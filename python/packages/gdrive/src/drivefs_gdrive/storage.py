"""Google Drive My Drive folder implementation of FileStorage."""

from __future__ import annotations

from collections.abc import Buffer, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from io import BufferedReader, RawIOBase
from time import sleep
from typing import Any, BinaryIO
from urllib.parse import quote, urlparse

import httpx
from drivefs import (
    AlreadyExistsError,
    AmbiguousPathError,
    AuthenticationError,
    ConflictError,
    DirectoryNotEmptyError,
    FileStorage,
    IndeterminateOperationError,
    InvalidArgumentError,
    InvalidPathError,
    InvalidUploadSourceError,
    IsDirectoryError,
    NotDirectoryError,
    NotFoundError,
    PermissionDeniedError,
    ProviderError,
    ProviderUnavailableError,
    QuotaExceededError,
    RateLimitError,
    RefScope,
    StorageCapabilities,
    StorageEntry,
    StorageTarget,
    UnsupportedOperationError,
    UploadSource,
    normalize_path,
    split_parent,
)

from .auth import GoogleAuth

API_URL = "https://www.googleapis.com/drive/v3/files"
UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"
FOLDER_MIME = "application/vnd.google-apps.folder"
BINARY_MIME = "application/octet-stream"
FIELDS = "id,name,mimeType,size,modifiedTime,version,parents,trashed,driveId"
PAGE_FIELDS = f"nextPageToken,incompleteSearch,files({FIELDS})"
CHUNK_SIZE = 8 * 256 * 1024


def _quote_id(value: str) -> str:
    return quote(value, safe="")


def _query_literal(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def _retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("Retry-After")
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            parsed = parsedate_to_datetime(value)
            return max(0.0, (parsed - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return None


class _ResponseReader(RawIOBase):
    """Adapt a streaming HTTP response to Python's binary reader API."""

    def __init__(self, response: httpx.Response) -> None:
        super().__init__()
        self._response = response
        self._chunks = response.iter_bytes()
        self._pending = b""

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: Buffer) -> int:
        if self.closed:
            raise ValueError("reader is closed")
        view = memoryview(buffer)
        if not view:
            return 0
        while not self._pending:
            try:
                self._pending = next(self._chunks)
            except StopIteration:
                return 0
            except (httpx.RequestError, httpx.StreamError):
                raise ProviderUnavailableError(
                    "Google download stream failed", provider="gdrive"
                ) from None
        count = min(len(view), len(self._pending))
        view[:count] = self._pending[:count]
        self._pending = self._pending[count:]
        return count

    def close(self) -> None:
        if not self.closed:
            self._response.close()
        super().close()


class GoogleDriveStorage(FileStorage):
    """Expose a chosen My Drive folder through the high-level storage API."""

    def __init__(
        self,
        *,
        root_id: str,
        auth: GoogleAuth,
        client: httpx.Client | None = None,
    ) -> None:
        if not root_id:
            raise InvalidArgumentError("root_id must be nonempty")
        self._root_id = root_id
        self._auth = auth
        self._client = client or httpx.Client(timeout=30.0)
        self._owns_client = client is None
        self._scope = RefScope()

    @property
    def capabilities(self) -> StorageCapabilities:
        return StorageCapabilities(conditional_replace=False)

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> GoogleDriveStorage:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _error(
        self,
        response: httpx.Response,
        operation: str,
        target: str | None,
        *,
        mutation: bool,
    ) -> Exception:
        status = response.status_code
        context: dict[str, Any] = {
            "operation": operation,
            "target": target,
            "provider": "gdrive",
            "retry_after": _retry_after(response),
        }
        if status == 401:
            return AuthenticationError("Google authentication failed", **context)
        if status == 404:
            return NotFoundError("Google item was not found", **context)
        if status in (409, 412):
            return ConflictError("Google item changed concurrently", **context)
        if status == 429:
            return RateLimitError("Google request was throttled", **context)
        if status == 403:
            reason = ""
            try:
                body = response.json()
                reason = body["error"]["errors"][0]["reason"]
            except (ValueError, KeyError, IndexError, TypeError, httpx.ResponseNotRead):
                pass
            if reason in ("rateLimitExceeded", "userRateLimitExceeded"):
                return RateLimitError("Google request was throttled", **context)
            if reason in ("storageQuotaExceeded", "quotaExceeded"):
                return QuotaExceededError("Google storage quota exceeded", **context)
            return PermissionDeniedError("Google permission denied", **context)
        if status >= 500:
            if mutation:
                return IndeterminateOperationError(
                    "Google mutation result is unknown", **context
                )
            return ProviderUnavailableError("Google service is unavailable", **context)
        return ProviderError("Google request failed", **context)

    def _request(
        self,
        method: str,
        url: str,
        *,
        operation: str,
        target: str | None = None,
        params: dict[str, str] | None = None,
        json: dict[str, Any] | None = None,
        content: bytes | None = None,
        headers: dict[str, str] | None = None,
        expected: tuple[int, ...] = (200,),
        mutation: bool = False,
        stream: bool = False,
    ) -> httpx.Response:
        refreshed = False
        attempt = 0
        while True:
            token = self._auth.access_token(self._client)
            request_headers = {**(headers or {}), "Authorization": f"Bearer {token}"}
            try:
                request = self._client.build_request(
                    method,
                    url,
                    params=params,
                    json=json,
                    content=content,
                    headers=request_headers,
                )
                response = self._client.send(request, stream=stream)
            except httpx.RequestError:
                error_type = (
                    IndeterminateOperationError
                    if mutation
                    else ProviderUnavailableError
                )
                raise error_type(
                    "Google transport failed",
                    operation=operation,
                    target=target,
                    provider="gdrive",
                ) from None
            if response.status_code in expected:
                return response
            if response.status_code == 401 and not refreshed:
                response.close()
                self._auth.access_token(self._client, force_refresh=True)
                refreshed = True
                continue
            if (
                not mutation
                and response.status_code in (429, 500, 502, 503, 504)
                and attempt < 2
            ):
                delay = _retry_after(response)
                response.close()
                sleep(min(delay if delay is not None else 2**attempt, 30.0))
                attempt += 1
                continue
            error = self._error(response, operation, target, mutation=mutation)
            response.close()
            raise error

    @staticmethod
    def _json_object(response: httpx.Response) -> dict[str, Any]:
        try:
            payload = response.json()
        except ValueError:
            raise ProviderError("Google response was not JSON") from None
        if not isinstance(payload, dict):
            raise ProviderError("Google response had an invalid shape")
        return payload

    def _get(self, item_id: str) -> dict[str, Any]:
        response = self._request(
            "GET",
            f"{API_URL}/{_quote_id(item_id)}",
            operation="stat",
            target=item_id,
            params={"fields": FIELDS},
        )
        return self._json_object(response)

    def _root(self) -> dict[str, Any]:
        root = self._get(self._root_id)
        if (
            root.get("trashed")
            or root.get("mimeType") != FOLDER_MIME
            or root.get("driveId")
        ):
            raise NotFoundError("configured Google root is unavailable")
        return root

    def _pages(
        self, parent_id: str, name: str | None = None
    ) -> Iterator[dict[str, Any]]:
        query = f"'{_query_literal(parent_id)}' in parents and trashed = false"
        if name is not None:
            query += f" and name = '{_query_literal(name)}'"
        page_token: str | None = None
        seen: set[str] = set()
        while True:
            params = {"q": query, "fields": PAGE_FIELDS, "pageSize": "1000"}
            if page_token is not None:
                params["pageToken"] = page_token
            response = self._request(
                "GET",
                API_URL,
                operation="list",
                target=parent_id,
                params=params,
            )
            payload = self._json_object(response)
            if payload.get("incompleteSearch"):
                raise ProviderError("Google returned an incomplete listing")
            files = payload.get("files")
            if not isinstance(files, list):
                raise ProviderError("Google listing omitted files")
            for item in files:
                if not isinstance(item, dict):
                    raise ProviderError("Google listing had an invalid item")
                if item.get("trashed") or name is not None and item.get("name") != name:
                    continue
                yield item
            next_token = payload.get("nextPageToken")
            if not next_token:
                return
            if not isinstance(next_token, str) or next_token in seen:
                raise ProviderError("Google pagination token was invalid")
            seen.add(next_token)
            page_token = next_token

    def _find_child(self, parent_id: str, name: str) -> dict[str, Any] | None:
        matches = list(self._pages(parent_id, name))
        if len(matches) > 1:
            raise AmbiguousPathError(
                "Google path matches multiple items",
                provider="gdrive",
                item_ids=tuple(str(item.get("id")) for item in matches),
            )
        return matches[0] if matches else None

    def _path_for_id(self, item_id: str) -> tuple[dict[str, Any], str]:
        if item_id == self._root_id:
            return self._root(), "/"
        parts: list[str] = []
        seen: set[str] = set()
        current = item_id
        first: dict[str, Any] | None = None
        while current != self._root_id:
            if current in seen:
                raise ProviderError("Google parent chain contains a cycle")
            seen.add(current)
            item = self._get(current)
            if first is None:
                first = item
            if item.get("trashed"):
                raise NotFoundError("Google item is outside this root")
            parents = item.get("parents")
            if (
                not isinstance(parents, list)
                or len(parents) != 1
                or not isinstance(parents[0], str)
            ):
                raise NotFoundError("Google item is outside this root")
            name = item.get("name")
            if not isinstance(name, str) or not name:
                raise ProviderError("Google item has an invalid name")
            parts.append(name)
            current = parents[0]
        self._root()
        assert first is not None
        return first, "/" + "/".join(reversed(parts))

    def _resolve(self, target: StorageTarget) -> tuple[dict[str, Any], str]:
        if not isinstance(target, str):
            item_id, _ = self._scope.resolve(target)
            return self._path_for_id(item_id)
        path = normalize_path(target)
        item = self._root()
        if path == "/":
            return item, path
        current = "/"
        for name in path[1:].split("/"):
            self._require_directory(item)
            child = self._find_child(str(item["id"]), name)
            if child is None:
                raise NotFoundError(
                    "Google path does not exist",
                    target=path,
                    provider="gdrive",
                )
            item = child
            current = current.rstrip("/") + "/" + name
        return item, current

    @staticmethod
    def _kind(item: dict[str, Any]) -> str:
        mime = item.get("mimeType")
        if mime == FOLDER_MIME:
            return "directory"
        if isinstance(mime, str) and mime.startswith("application/vnd.google-apps."):
            return "other"
        return "file"

    @classmethod
    def _require_directory(cls, item: dict[str, Any]) -> None:
        if cls._kind(item) != "directory":
            raise NotDirectoryError("Google item is not a directory")

    @classmethod
    def _require_file(cls, item: dict[str, Any]) -> None:
        kind = cls._kind(item)
        if kind == "directory":
            raise IsDirectoryError("Google item is a directory")
        if kind == "other":
            raise UnsupportedOperationError("Google item is not a binary file")

    def _entry(self, item: dict[str, Any], path: str) -> StorageEntry:
        item_id = item.get("id")
        if not isinstance(item_id, str):
            raise ProviderError("Google item omitted its ID")
        name = item.get("name", "")
        if not isinstance(name, str):
            raise ProviderError("Google item had an invalid name")
        size_value = item.get("size")
        try:
            size = int(size_value) if size_value is not None else None
        except (TypeError, ValueError):
            raise ProviderError("Google item had an invalid size") from None
        modified_value = item.get("modifiedTime")
        try:
            modified_at = (
                datetime.fromisoformat(modified_value.replace("Z", "+00:00"))
                if isinstance(modified_value, str)
                else None
            )
        except ValueError:
            raise ProviderError("Google item had an invalid timestamp") from None
        version_value = item.get("version")
        return StorageEntry(
            ref=self._scope.make(item_id),
            id=item_id,
            path=path,
            name=name,
            kind=self._kind(item),  # type: ignore[arg-type]
            size=size,
            modified_at=modified_at,
            mime_type=item.get("mimeType"),
            version=str(version_value) if version_value is not None else None,
        )

    def stat(self, target: StorageTarget) -> StorageEntry:
        item, path = self._resolve(target)
        return self._entry(item, path)

    def list(self, target: StorageTarget) -> Iterator[StorageEntry]:
        item, path = self._resolve(target)
        self._require_directory(item)
        for child in self._pages(str(item["id"])):
            name = child.get("name")
            if not isinstance(name, str) or not name:
                raise ProviderError("Google listing had an invalid name")
            child_path = path.rstrip("/") + "/" + name
            yield self._entry(child, child_path)

    def _download(
        self, target: StorageTarget, *, range_header: str | None = None
    ) -> httpx.Response:
        item, _ = self._resolve(target)
        self._require_file(item)
        headers = {"Range": range_header} if range_header is not None else None
        return self._request(
            "GET",
            f"{API_URL}/{_quote_id(str(item['id']))}",
            operation="read",
            target=str(item["id"]),
            params={"alt": "media"},
            headers=headers,
            expected=(200, 206, 416) if range_header else (200,),
            stream=True,
        )

    def read(self, target: StorageTarget) -> bytes:
        with self.open_reader(target) as reader:
            return reader.read()

    @contextmanager
    def open_reader(self, target: StorageTarget) -> Iterator[BinaryIO]:
        response = self._download(target)
        reader = BufferedReader(_ResponseReader(response))
        try:
            yield reader
        finally:
            reader.close()

    def read_range(self, target: StorageTarget, offset: int, length: int) -> bytes:
        if (
            type(offset) is not int
            or type(length) is not int
            or offset < 0
            or length < 0
        ):
            raise InvalidArgumentError("offset and length must be nonnegative integers")
        if length == 0:
            self._require_file(self._resolve(target)[0])
            return b""
        response = self._download(
            target, range_header=f"bytes={offset}-{offset + length - 1}"
        )
        try:
            if response.status_code == 416:
                return b""
            if response.status_code != 206:
                raise ProviderError("Google ignored the requested byte range")
            content_range = response.headers.get("Content-Range", "")
            if not content_range.startswith(f"bytes {offset}-"):
                raise ProviderError("Google returned a different byte range")
            reader = BufferedReader(_ResponseReader(response))
            try:
                return reader.read(length)
            finally:
                reader.close()
        finally:
            response.close()

    def mkdir(self, path: str) -> StorageEntry:
        parent_path, name = split_parent(path)
        parent, _ = self._resolve(parent_path)
        self._require_directory(parent)
        try:
            existing = self._find_child(str(parent["id"]), name) is not None
        except AmbiguousPathError:
            existing = True
        if existing:
            raise AlreadyExistsError("Google destination already exists")
        response = self._request(
            "POST",
            API_URL,
            operation="mkdir",
            target=path,
            params={"fields": FIELDS},
            json={"name": name, "mimeType": FOLDER_MIME, "parents": [parent["id"]]},
            expected=(200, 201),
            mutation=True,
        )
        return self._entry(self._json_object(response), normalize_path(path))

    def move(self, target: StorageTarget, destination: str) -> StorageEntry:
        item, old_path = self._resolve(target)
        if item.get("id") == self._root_id:
            raise UnsupportedOperationError("cannot move the Google root")
        if self._kind(item) == "other":
            raise UnsupportedOperationError("cannot move this Google item")
        parent_path, name = split_parent(destination)
        parent, _ = self._resolve(parent_path)
        self._require_directory(parent)
        if self._kind(item) == "directory" and (
            parent_path == old_path or parent_path.startswith(old_path + "/")
        ):
            raise InvalidPathError("cannot move into own descendant")
        try:
            existing = self._find_child(str(parent["id"]), name) is not None
        except AmbiguousPathError:
            existing = True
        if existing:
            raise AlreadyExistsError("Google destination already exists")
        parents = item.get("parents")
        if not isinstance(parents, list) or len(parents) != 1:
            raise ProviderError("Google item has invalid parents")
        params = {"fields": FIELDS}
        if parents[0] != parent["id"]:
            params["addParents"] = str(parent["id"])
            params["removeParents"] = str(parents[0])
        response = self._request(
            "PATCH",
            f"{API_URL}/{_quote_id(str(item['id']))}",
            operation="move",
            target=old_path,
            params=params,
            json={"name": name},
            mutation=True,
        )
        return self._entry(self._json_object(response), normalize_path(destination))

    def delete(self, target: StorageTarget) -> None:
        item, path = self._resolve(target)
        if item.get("id") == self._root_id:
            raise UnsupportedOperationError("cannot delete the Google root")
        if self._kind(item) == "other":
            raise UnsupportedOperationError("cannot delete this Google item")
        if self._kind(item) == "directory":
            if next(self._pages(str(item["id"])), None) is not None:
                raise DirectoryNotEmptyError("Google directory is not empty")
        self._request(
            "PATCH",
            f"{API_URL}/{_quote_id(str(item['id']))}",
            operation="delete",
            target=path,
            json={"trashed": True},
            params={"fields": "id,trashed"},
            mutation=True,
        )

    def write(
        self,
        path: str,
        data: UploadSource,
        *,
        overwrite: bool = False,
        expected_version: str | None = None,
        size: int | None = None,
    ) -> StorageEntry:
        if expected_version is not None and not overwrite:
            raise InvalidArgumentError("expected_version requires overwrite=True")
        if expected_version is not None:
            raise UnsupportedOperationError(
                "Google conditional replacement is unverified"
            )
        if isinstance(data, bytes):
            total = len(data)
            if size is not None and (type(size) is not int or size != total):
                raise InvalidUploadSourceError("byte count differs from size")
        else:
            if type(size) is not int or size < 0:
                raise InvalidUploadSourceError("stream requires a nonnegative size")
            total = size
        parent_path, name = split_parent(path)
        parent, _ = self._resolve(parent_path)
        self._require_directory(parent)
        try:
            existing = self._find_child(str(parent["id"]), name)
        except AmbiguousPathError:
            if overwrite:
                raise
            raise AlreadyExistsError("Google destination already exists") from None
        if existing is not None:
            if not overwrite:
                raise AlreadyExistsError("Google destination already exists")
            self._require_file(existing)
        metadata = (
            {}
            if existing is not None
            else {"name": name, "parents": [parent["id"]], "mimeType": BINARY_MIME}
        )
        if total == 0:
            self._check_stream_end(data)
            if existing is None:
                response = self._request(
                    "POST",
                    API_URL,
                    operation="write",
                    target=path,
                    params={"fields": FIELDS},
                    json=metadata,
                    expected=(200, 201),
                    mutation=True,
                )
            else:
                response = self._request(
                    "PATCH",
                    f"{UPLOAD_URL}/{_quote_id(str(existing['id']))}",
                    operation="write",
                    target=path,
                    params={"uploadType": "media", "fields": FIELDS},
                    content=b"",
                    headers={"Content-Type": BINARY_MIME},
                    expected=(200,),
                    mutation=True,
                )
            result = self._json_object(response)
        else:
            upload_url = (
                f"{UPLOAD_URL}/{_quote_id(str(existing['id']))}"
                if existing is not None
                else UPLOAD_URL
            )
            response = self._request(
                "PATCH" if existing is not None else "POST",
                upload_url,
                operation="write",
                target=path,
                params={"uploadType": "resumable", "fields": FIELDS},
                json=metadata,
                headers={
                    "X-Upload-Content-Type": BINARY_MIME,
                    "X-Upload-Content-Length": str(total),
                },
                expected=(200,),
                mutation=True,
            )
            session = response.headers.get("Location")
            if not session or not self._valid_session_url(session):
                raise IndeterminateOperationError(
                    "Google upload session was not returned",
                    operation="write",
                    target=path,
                    provider="gdrive",
                )
            try:
                result = self._upload(session, data, total)
            except InvalidUploadSourceError:
                self._cancel_upload(session)
                raise
        normalized = normalize_path(path)
        entry = self._entry(result, normalized)
        if existing is None:
            matches = list(self._pages(str(parent["id"]), name))
            if len(matches) > 1:
                raise ConflictError(
                    "Google creation raced with another item",
                    operation="write",
                    target=normalized,
                    provider="gdrive",
                    item_ids=tuple(str(item.get("id")) for item in matches),
                )
        return entry

    @staticmethod
    def _valid_session_url(session: str) -> bool:
        parsed = urlparse(session)
        return (
            parsed.scheme == "https"
            and parsed.hostname is not None
            and (
                parsed.hostname == "googleapis.com"
                or parsed.hostname.endswith(".googleapis.com")
            )
        )

    def _cancel_upload(self, session: str) -> None:
        try:
            self._client.delete(session)
        except httpx.RequestError:
            pass

    @staticmethod
    def _read_fragment(source: UploadSource, offset: int, length: int) -> bytes:
        if isinstance(source, bytes):
            return source[offset : offset + length]
        chunks: list[bytes] = []
        remaining = length
        while remaining:
            chunk = source.read(remaining)
            if not chunk:
                break
            if not isinstance(chunk, bytes):
                raise InvalidUploadSourceError("stream must return bytes")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    @staticmethod
    def _check_stream_end(source: UploadSource) -> None:
        if isinstance(source, bytes):
            return
        extra = source.read(1)
        if extra:
            raise InvalidUploadSourceError("stream exceeds declared size")

    @staticmethod
    def _acknowledged(response: httpx.Response) -> int:
        value = response.headers.get("Range")
        if value is None:
            return 0
        if not value.startswith("bytes=0-"):
            raise IndeterminateOperationError(
                "Google upload acknowledged an invalid range"
            )
        try:
            return int(value[len("bytes=0-") :]) + 1
        except ValueError:
            raise IndeterminateOperationError(
                "Google upload acknowledged an invalid range"
            ) from None

    def _upload_status(
        self, session: str, total: int
    ) -> tuple[int, dict[str, Any] | None]:
        try:
            response = self._client.put(
                session,
                headers={"Content-Range": f"bytes */{total}"},
                content=b"",
            )
        except httpx.RequestError:
            raise IndeterminateOperationError(
                "Google upload status is unavailable"
            ) from None
        if response.status_code in (200, 201):
            return total, self._json_object(response)
        if response.status_code == 308:
            return self._acknowledged(response), None
        if response.status_code == 404:
            raise IndeterminateOperationError(
                "Google upload session expired before completion"
            )
        raise self._error(response, "write", None, mutation=True)

    def _upload(self, session: str, source: UploadSource, total: int) -> dict[str, Any]:
        offset = 0
        while offset < total:
            length = min(CHUNK_SIZE, total - offset)
            fragment = self._read_fragment(source, offset, length)
            if len(fragment) != length:
                raise InvalidUploadSourceError("stream is shorter than size")
            if offset + length == total:
                self._check_stream_end(source)
            acknowledged, completed = self._put_fragment(
                session, fragment, offset, total
            )
            if completed is not None:
                if acknowledged != total:
                    raise IndeterminateOperationError(
                        "Google upload completed before declared size"
                    )
                return completed
            if acknowledged != offset + length:
                raise IndeterminateOperationError(
                    "Google upload did not acknowledge its fragment"
                )
            offset = acknowledged
        acknowledged, completed = self._upload_status(session, total)
        if acknowledged == total and completed is not None:
            return completed
        raise IndeterminateOperationError("Google upload completion is unknown")

    def _put_fragment(
        self, session: str, fragment: bytes, start: int, total: int
    ) -> tuple[int, dict[str, Any] | None]:
        end = start + len(fragment)
        for _attempt in range(3):
            headers = {
                "Content-Type": BINARY_MIME,
                "Content-Range": f"bytes {start}-{end - 1}/{total}",
            }
            try:
                response = self._client.put(
                    session,
                    headers=headers,
                    content=fragment,
                )
            except httpx.RequestError:
                response = None
            if response is not None:
                if response.status_code in (200, 201):
                    return total, self._json_object(response)
                if response.status_code == 308:
                    acknowledged = self._acknowledged(response)
                    if acknowledged == end:
                        return acknowledged, None
                    if acknowledged < start or acknowledged > end:
                        raise IndeterminateOperationError(
                            "Google upload acknowledged an unexpected range"
                        )
                    start = acknowledged
                    fragment = fragment[start - (end - len(fragment)) :]
                    continue
                if response.status_code not in (429, 500, 502, 503, 504):
                    raise self._error(response, "write", None, mutation=True)
            acknowledged, completed = self._upload_status(session, total)
            if completed is not None:
                return acknowledged, completed
            if acknowledged == end:
                return acknowledged, None
            if acknowledged < start or acknowledged > end:
                raise IndeterminateOperationError(
                    "Google upload status has an unexpected range"
                )
            old_start = start
            start = acknowledged
            fragment = fragment[start - old_start :]
        raise IndeterminateOperationError("Google upload retry limit reached")
