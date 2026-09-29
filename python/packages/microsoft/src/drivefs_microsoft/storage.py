"""Shared Graph transport with separate OneDrive and SharePoint roots."""

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

from .auth import GraphAuth

GRAPH_URL = "https://graph.microsoft.com/v1.0"
CHUNK_SIZE = 10 * 320 * 1024


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
                    "Graph download stream failed", provider="microsoft"
                ) from None
        count = min(len(view), len(self._pending))
        view[:count] = self._pending[:count]
        self._pending = self._pending[count:]
        return count

    def close(self) -> None:
        if not self.closed:
            self._response.close()
        super().close()


class _GraphStorage(FileStorage):
    def __init__(
        self,
        *,
        drive_id: str,
        root_id: str,
        auth: GraphAuth,
        drive_type: str,
        site_id: str | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        if not drive_id or not root_id:
            raise InvalidArgumentError("drive_id and root_id are required")
        self._drive_id = drive_id
        self._root_id = root_id
        self._auth = auth
        self._drive_type = drive_type
        self._site_id = site_id
        self._site_verified = False
        self._client = client or httpx.Client(timeout=30.0)
        self._owns_client = client is None
        self._scope = RefScope()
        self._base = f"{GRAPH_URL}/drives/{quote(drive_id, safe='')}"

    @property
    def capabilities(self) -> StorageCapabilities:
        return StorageCapabilities(conditional_replace=False)

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> _GraphStorage:
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
        context: dict[str, Any] = {
            "operation": operation,
            "target": target,
            "provider": "microsoft",
            "retry_after": _retry_after(response),
        }
        status = response.status_code
        if status == 401:
            return AuthenticationError("Graph authentication failed", **context)
        if status == 403:
            return PermissionDeniedError("Graph permission denied", **context)
        if status == 404:
            return NotFoundError("Graph item was not found", **context)
        if status in (409, 412):
            return ConflictError("Graph item changed concurrently", **context)
        if status == 429:
            return RateLimitError("Graph request was throttled", **context)
        if status == 507:
            return QuotaExceededError("Graph storage quota exceeded", **context)
        if status >= 500:
            if mutation:
                return IndeterminateOperationError(
                    "Graph mutation result is unknown", **context
                )
            return ProviderUnavailableError("Graph service is unavailable", **context)
        return ProviderError("Graph request failed", **context)

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
                    "Graph transport failed",
                    operation=operation,
                    target=target,
                    provider="microsoft",
                ) from None
            if response.status_code in expected:
                return response
            if response.status_code == 401 and not refreshed:
                response.close()
                self._auth.access_token(
                    self._client, force_refresh=True, failed_token=token
                )
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
    def _json_object(
        response: httpx.Response, *, mutation: bool = False
    ) -> dict[str, Any]:
        try:
            payload = response.json()
        except ValueError:
            if mutation:
                raise IndeterminateOperationError(
                    "Graph mutation response was not JSON", provider="microsoft"
                ) from None
            raise ProviderError("Graph response was not JSON") from None
        except (httpx.RequestError, httpx.StreamError):
            if mutation:
                raise IndeterminateOperationError(
                    "Graph mutation response failed", provider="microsoft"
                ) from None
            raise ProviderUnavailableError(
                "Graph response body failed", provider="microsoft"
            ) from None
        if not isinstance(payload, dict):
            if mutation:
                raise IndeterminateOperationError(
                    "Graph mutation response had an invalid shape", provider="microsoft"
                )
            raise ProviderError("Graph response had an invalid shape")
        return payload

    def _item_url(self, item_id: str) -> str:
        return f"{self._base}/items/{quote(item_id, safe='')}"

    def _get(self, item_id: str) -> dict[str, Any]:
        return self._json_object(
            self._request(
                "GET",
                self._item_url(item_id),
                operation="stat",
                target=item_id,
            )
        )

    def _root(self) -> dict[str, Any]:
        if self._site_id is not None and not self._site_verified:
            self._verify_site_drive()
        drive = self._json_object(
            self._request(
                "GET",
                self._base,
                operation="stat",
                target=self._drive_id,
            )
        )
        if drive.get("driveType") != self._drive_type:
            raise NotFoundError("configured Graph drive has the wrong type")
        root = self._get(self._root_id)
        if not isinstance(root.get("folder"), dict):
            raise NotFoundError("configured Graph root is not a folder")
        if self._site_id is not None:
            ids = root.get("sharepointIds")
            if (
                isinstance(ids, dict)
                and ids.get("siteId") is not None
                and ids.get("siteId") != self._site_id
            ):
                raise NotFoundError("configured Graph root is outside site")
        return root

    def _verify_site_drive(self) -> None:
        assert self._site_id is not None
        base = f"{GRAPH_URL}/sites/{quote(self._site_id, safe='')}/drives"
        url = base
        seen: set[str] = set()
        while True:
            payload = self._json_object(
                self._request(
                    "GET",
                    url,
                    operation="stat",
                    target=self._site_id,
                )
            )
            drives = payload.get("value")
            if not isinstance(drives, list):
                raise ProviderError("Graph site drive listing was invalid")
            if any(
                isinstance(item, dict) and item.get("id") == self._drive_id
                for item in drives
            ):
                self._site_verified = True
                return
            next_url = payload.get("@odata.nextLink")
            if not next_url:
                raise NotFoundError("configured library is outside site")
            if (
                not isinstance(next_url, str)
                or not next_url.startswith(base + "?")
                or next_url in seen
            ):
                raise ProviderError("Graph site pagination URL was invalid")
            seen.add(next_url)
            url = next_url

    def _pages(self, parent_id: str) -> Iterator[dict[str, Any]]:
        url = f"{self._item_url(parent_id)}/children"
        seen: set[str] = set()
        while True:
            response = self._request(
                "GET",
                url,
                operation="list",
                target=parent_id,
            )
            payload = self._json_object(response)
            items = payload.get("value")
            if not isinstance(items, list):
                raise ProviderError("Graph listing omitted items")
            for item in items:
                if not isinstance(item, dict):
                    raise ProviderError("Graph listing had an invalid item")
                yield item
            next_url = payload.get("@odata.nextLink")
            if not next_url:
                return
            if (
                not isinstance(next_url, str)
                or not next_url.startswith(self._base + "/items/")
                or next_url in seen
            ):
                raise ProviderError("Graph pagination URL was invalid")
            seen.add(next_url)
            url = next_url

    def _find_child(self, parent_id: str, name: str) -> dict[str, Any] | None:
        matches = [item for item in self._pages(parent_id) if item.get("name") == name]
        if len(matches) > 1:
            raise AmbiguousPathError(
                "Graph path matches multiple items",
                provider="microsoft",
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
                raise ProviderError("Graph parent chain contains a cycle")
            seen.add(current)
            item = self._get(current)
            first = first or item
            parent = item.get("parentReference")
            if (
                not isinstance(parent, dict)
                or not isinstance(parent.get("id"), str)
                or parent.get("driveId") != self._drive_id
            ):
                raise NotFoundError("Graph item is outside this root")
            name = item.get("name")
            if not isinstance(name, str) or not name:
                raise ProviderError("Graph item has an invalid name")
            parts.append(name)
            current = parent["id"]
        self._root()
        assert first is not None
        return first, "/" + "/".join(reversed(parts))

    def _resolve(self, target: StorageTarget) -> tuple[dict[str, Any], str]:
        if not isinstance(target, str):
            item_id, container_id = self._scope.resolve(target)
            if container_id != self._drive_id:
                raise NotFoundError("reference belongs to another drive")
            return self._path_for_id(item_id)
        path = normalize_path(target)
        item = self._root()
        if path == "/":
            return item, path
        for name in path[1:].split("/"):
            self._require_directory(item)
            child = self._find_child(str(item["id"]), name)
            if child is None:
                raise NotFoundError(
                    "Graph path does not exist",
                    target=path,
                    provider="microsoft",
                )
            item = child
        return item, path

    @staticmethod
    def _kind(item: dict[str, Any]) -> str:
        if isinstance(item.get("remoteItem"), dict):
            return "other"
        if isinstance(item.get("package"), dict):
            return "other"
        if isinstance(item.get("folder"), dict):
            return "directory"
        if isinstance(item.get("file"), dict):
            return "file"
        return "other"

    @classmethod
    def _require_directory(cls, item: dict[str, Any]) -> None:
        if cls._kind(item) != "directory":
            raise NotDirectoryError("Graph item is not a directory")

    @classmethod
    def _require_file(cls, item: dict[str, Any]) -> None:
        kind = cls._kind(item)
        if kind == "directory":
            raise IsDirectoryError("Graph item is a directory")
        if kind == "other":
            raise UnsupportedOperationError("Graph item is not a binary file")

    def _entry(self, item: dict[str, Any], path: str) -> StorageEntry:
        item_id = item.get("id")
        if not isinstance(item_id, str):
            raise ProviderError("Graph item omitted its ID")
        name = item.get("name", "")
        if not isinstance(name, str):
            raise ProviderError("Graph item had an invalid name")
        size = item.get("size")
        if size is not None and (type(size) is not int or size < 0):
            raise ProviderError("Graph item had an invalid size")
        modified_value = item.get("lastModifiedDateTime")
        try:
            modified_at = (
                datetime.fromisoformat(modified_value.replace("Z", "+00:00"))
                if isinstance(modified_value, str)
                else None
            )
        except ValueError:
            raise ProviderError("Graph item had an invalid timestamp") from None
        file_facet = item.get("file")
        mime_type = file_facet.get("mimeType") if isinstance(file_facet, dict) else None
        version = item.get("eTag")
        return StorageEntry(
            ref=self._scope.make(item_id, self._drive_id),
            id=item_id,
            path=path,
            name=name,
            kind=self._kind(item),  # type: ignore[arg-type]
            size=size,
            modified_at=modified_at,
            mime_type=mime_type if isinstance(mime_type, str) else None,
            version=version if isinstance(version, str) else None,
        )

    def _mutation_entry(self, item: dict[str, Any], path: str) -> StorageEntry:
        try:
            return self._entry(item, path)
        except ProviderError:
            raise IndeterminateOperationError(
                "Graph mutation response metadata was invalid", provider="microsoft"
            ) from None

    def stat(self, target: StorageTarget) -> StorageEntry:
        item, path = self._resolve(target)
        return self._entry(item, path)

    def list(self, target: StorageTarget) -> Iterator[StorageEntry]:
        item, path = self._resolve(target)
        self._require_directory(item)
        for child in self._pages(str(item["id"])):
            name = child.get("name")
            if not isinstance(name, str) or not name:
                raise ProviderError("Graph listing had an invalid name")
            yield self._entry(child, path.rstrip("/") + "/" + name)

    def _download(
        self, target: StorageTarget, *, range_header: str | None = None
    ) -> httpx.Response:
        item, _ = self._resolve(target)
        self._require_file(item)
        response = self._request(
            "GET",
            self._item_url(str(item["id"])) + "/content",
            operation="read",
            target=str(item["id"]),
            expected=(302,),
        )
        location = response.headers.get("Location")
        parsed = urlparse(location or "")
        if parsed.scheme != "https" or not parsed.hostname:
            raise ProviderError("Graph download URL was invalid")
        headers = {"Range": range_header} if range_header is not None else {}
        try:
            request = self._client.build_request("GET", location, headers=headers)
            download = self._client.send(request, stream=True)
        except httpx.RequestError:
            raise ProviderUnavailableError(
                "Graph download transport failed", provider="microsoft"
            ) from None
        if download.status_code in ((200, 206, 416) if range_header else (200,)):
            return download
        error = self._error(download, "read", str(item["id"]), mutation=False)
        download.close()
        raise error

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
                raise ProviderError("Graph ignored the requested byte range")
            content_range = response.headers.get("Content-Range", "")
            if not content_range.startswith(f"bytes {offset}-"):
                raise ProviderError("Graph returned a different byte range")
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
            raise AlreadyExistsError("Graph destination already exists")
        response = self._request(
            "POST",
            self._item_url(str(parent["id"])) + "/children",
            operation="mkdir",
            target=path,
            json={
                "name": name,
                "folder": {},
                "@microsoft.graph.conflictBehavior": "fail",
            },
            expected=(201,),
            mutation=True,
        )
        return self._mutation_entry(
            self._json_object(response, mutation=True), normalize_path(path)
        )

    def move(self, target: StorageTarget, destination: str) -> StorageEntry:
        item, old_path = self._resolve(target)
        if item.get("id") == self._root_id:
            raise UnsupportedOperationError("cannot move the Graph root")
        if self._kind(item) == "other":
            raise UnsupportedOperationError("cannot move this Graph item")
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
            raise AlreadyExistsError("Graph destination already exists")
        response = self._request(
            "PATCH",
            self._item_url(str(item["id"])),
            operation="move",
            target=old_path,
            json={"name": name, "parentReference": {"id": parent["id"]}},
            mutation=True,
        )
        return self._mutation_entry(
            self._json_object(response, mutation=True), normalize_path(destination)
        )

    def delete(self, target: StorageTarget) -> None:
        item, path = self._resolve(target)
        if item.get("id") == self._root_id:
            raise UnsupportedOperationError("cannot delete the Graph root")
        if self._kind(item) == "other":
            raise UnsupportedOperationError("cannot delete this Graph item")
        if self._kind(item) == "directory":
            if next(self._pages(str(item["id"])), None) is not None:
                raise DirectoryNotEmptyError("Graph directory is not empty")
        self._request(
            "DELETE",
            self._item_url(str(item["id"])),
            operation="delete",
            target=path,
            expected=(204,),
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
                "Graph conditional replacement is unverified"
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
            raise AlreadyExistsError("Graph destination already exists") from None
        if existing is not None:
            if not overwrite:
                raise AlreadyExistsError("Graph destination already exists")
            self._require_file(existing)
        if total == 0:
            self._check_stream_end(data)
            endpoint = (
                self._item_url(str(existing["id"])) + "/content"
                if existing is not None
                else self._item_url(str(parent["id"]))
                + f":/{quote(name, safe='')}:/content"
            )
            response = self._request(
                "PUT",
                endpoint,
                operation="write",
                target=path,
                content=b"",
                headers={"Content-Type": "application/octet-stream"},
                expected=(200, 201),
                mutation=True,
            )
            result = self._json_object(response, mutation=True)
        else:
            endpoint = (
                self._item_url(str(existing["id"])) + "/createUploadSession"
                if existing is not None
                else self._item_url(str(parent["id"]))
                + f":/{quote(name, safe='')}:/createUploadSession"
            )
            upload_item: dict[str, Any] = {
                "@microsoft.graph.conflictBehavior": (
                    "replace" if existing is not None else "fail"
                ),
                "name": name,
            }
            if self._drive_type == "personal":
                upload_item["fileSize"] = total
            response = self._request(
                "POST",
                endpoint,
                operation="write",
                target=path,
                json={"item": upload_item},
                mutation=True,
            )
            payload = self._json_object(response, mutation=True)
            session = payload.get("uploadUrl")
            parsed = urlparse(session if isinstance(session, str) else "")
            if parsed.scheme != "https" or not parsed.hostname:
                raise IndeterminateOperationError(
                    "Graph upload session was not returned",
                    operation="write",
                    target=path,
                    provider="microsoft",
                )
            assert isinstance(session, str)
            try:
                result = self._upload(session, data, total)
            except InvalidUploadSourceError:
                self._cancel_upload(session)
                raise
        normalized = normalize_path(path)
        entry = self._mutation_entry(result, normalized)
        if existing is None:
            matches = [
                item
                for item in self._pages(str(parent["id"]))
                if item.get("name") == name
            ]
            if len(matches) > 1:
                raise ConflictError(
                    "Graph creation raced with another item",
                    operation="write",
                    target=normalized,
                    provider="microsoft",
                    item_ids=tuple(str(item.get("id")) for item in matches),
                )
        return entry

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
        if source.read(1):
            raise InvalidUploadSourceError("stream exceeds declared size")

    @staticmethod
    def _next_offset(payload: dict[str, Any]) -> int:
        ranges = payload.get("nextExpectedRanges")
        if not isinstance(ranges, list) or not ranges:
            raise IndeterminateOperationError("Graph upload omitted its next range")
        first = ranges[0]
        if not isinstance(first, str):
            raise IndeterminateOperationError(
                "Graph upload returned an invalid next range"
            )
        start, _, _ = first.partition("-")
        try:
            return int(start)
        except ValueError:
            raise IndeterminateOperationError(
                "Graph upload returned an invalid next range"
            ) from None

    def _upload_status(self, session: str) -> tuple[int | None, dict[str, Any] | None]:
        try:
            response = self._client.get(session)
        except httpx.RequestError:
            raise IndeterminateOperationError(
                "Graph upload status is unavailable"
            ) from None
        if response.status_code == 404:
            raise IndeterminateOperationError(
                "Graph upload session expired before completion"
            )
        if response.status_code != 200:
            raise self._error(response, "write", None, mutation=True)
        payload = self._json_object(response, mutation=True)
        if isinstance(payload.get("file"), dict):
            return None, payload
        return self._next_offset(payload), None

    def _upload(self, session: str, source: UploadSource, total: int) -> dict[str, Any]:
        offset = 0
        while offset < total:
            length = min(CHUNK_SIZE, total - offset)
            fragment = self._read_fragment(source, offset, length)
            if len(fragment) != length:
                raise InvalidUploadSourceError("stream is shorter than size")
            if offset + length == total:
                self._check_stream_end(source)
            next_offset, completed = self._put_fragment(
                session, fragment, offset, total
            )
            if completed is not None:
                if offset + length != total:
                    raise IndeterminateOperationError(
                        "Graph upload completed before declared size"
                    )
                return completed
            if next_offset != offset + length:
                raise IndeterminateOperationError(
                    "Graph upload did not acknowledge its fragment"
                )
            if next_offset is None:
                raise IndeterminateOperationError(
                    "Graph upload omitted its next offset"
                )
            offset = next_offset
        _, completed = self._upload_status(session)
        if completed is not None:
            return completed
        raise IndeterminateOperationError("Graph upload completion is unknown")

    def _put_fragment(
        self, session: str, fragment: bytes, start: int, total: int
    ) -> tuple[int, dict[str, Any] | None]:
        end = start + len(fragment)
        for _attempt in range(3):
            try:
                response = self._client.put(
                    session,
                    content=fragment,
                    headers={
                        "Content-Type": "application/octet-stream",
                        "Content-Range": f"bytes {start}-{end - 1}/{total}",
                    },
                )
            except httpx.RequestError:
                response = None
            if response is not None:
                if response.status_code in (200, 201):
                    return end, self._json_object(response, mutation=True)
                if response.status_code == 202:
                    next_offset = self._next_offset(
                        self._json_object(response, mutation=True)
                    )
                    if next_offset == end:
                        return next_offset, None
                    if next_offset != start:
                        raise IndeterminateOperationError(
                            "Graph upload acknowledged a partial fragment"
                        )
                    continue
                if response.status_code not in (429, 500, 502, 503, 504):
                    raise self._error(response, "write", None, mutation=True)
            status_offset, completed = self._upload_status(session)
            if completed is not None:
                return end, completed
            if status_offset == end:
                return end, None
            if status_offset != start:
                raise IndeterminateOperationError(
                    "Graph upload status has a partial fragment"
                )
        raise IndeterminateOperationError("Graph upload retry limit reached")


class OneDriveStorage(_GraphStorage):
    """A selected root in a OneDrive Personal drive."""

    def __init__(
        self,
        *,
        drive_id: str,
        root_id: str,
        auth: GraphAuth,
        client: httpx.Client | None = None,
    ) -> None:
        if auth.tenant_id != "consumers":
            raise InvalidArgumentError(
                "OneDrive Personal requires a consumers tenant auth"
            )
        super().__init__(
            drive_id=drive_id,
            root_id=root_id,
            auth=auth,
            drive_type="personal",
            client=client,
        )


class SharePointStorage(_GraphStorage):
    """A selected document library root in a SharePoint site."""

    def __init__(
        self,
        *,
        site_id: str,
        drive_id: str,
        root_id: str,
        auth: GraphAuth,
        client: httpx.Client | None = None,
    ) -> None:
        if not site_id or auth.tenant_id in ("consumers", "common"):
            raise InvalidArgumentError(
                "SharePoint requires a site and tenant-specific auth"
            )
        super().__init__(
            drive_id=drive_id,
            root_id=root_id,
            auth=auth,
            drive_type="documentLibrary",
            site_id=site_id,
            client=client,
        )
