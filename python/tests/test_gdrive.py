"""Exercise the public Google backend against external HTTP fixtures."""

from __future__ import annotations

import json
import re
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from io import BytesIO
from threading import Barrier
from typing import Any

import httpx
from drivefs import (
    AmbiguousPathError,
    AuthenticationError,
    ConflictError,
    DirectoryNotEmptyError,
    IndeterminateOperationError,
    InvalidUploadSourceError,
    NotFoundError,
    PermissionDeniedError,
    ProviderError,
    ProviderUnavailableError,
    QuotaExceededError,
    UnsupportedOperationError,
)
from drivefs_gdrive import (
    GoogleAuth,
    GoogleDriveStorage,
    GoogleToken,
    MemoryCredentialStore,
)

FOLDER_MIME = "application/vnd.google-apps.folder"


class GoogleApiFixture:
    def __init__(self) -> None:
        self.items: dict[str, dict[str, Any]] = {
            "root": {
                "id": "root",
                "name": "root",
                "mimeType": FOLDER_MIME,
                "parents": ["my-drive"],
                "trashed": False,
            }
        }
        self.content: dict[str, bytes] = {}
        self.sessions: dict[str, dict[str, Any]] = {}
        self.next_id = 1
        self.next_session = 1
        self.forced_status: int | None = None
        self.forced_reason = "forbidden"
        self.forced_exception = False
        self.fail_upload_start = False
        self.ignore_range = False
        self.lose_final_response = False
        self.last_media_response: httpx.Response | None = None
        self.refresh_count = 0
        self.cancel_count = 0
        self.race_on_create = False

    def inject(
        self,
        name: str,
        *,
        parent: str = "root",
        kind: str = "file",
        data: bytes = b"",
    ) -> dict[str, Any]:
        item_id = f"f{self.next_id}"
        self.next_id += 1
        mime = (
            FOLDER_MIME
            if kind == "directory"
            else (
                "application/vnd.google-apps.document"
                if kind == "other"
                else "application/octet-stream"
            )
        )
        item = {
            "id": item_id,
            "name": name,
            "mimeType": mime,
            "parents": [parent],
            "trashed": False,
            "version": "1",
        }
        if kind == "file":
            item["size"] = str(len(data))
            self.content[item_id] = data
        self.items[item_id] = item
        return item

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "oauth2.googleapis.com":
            self.refresh_count += 1
            return httpx.Response(
                200, json={"access_token": "new-token", "expires_in": 3600}
            )
        if (
            request.headers.get("Authorization")
            not in ("Bearer test-token", "Bearer new-token")
            and "/upload/session/" not in request.url.path
        ):
            return httpx.Response(401, json={"error": {"message": "bad token"}})
        path = request.url.path
        if self.forced_exception and path.startswith("/drive/v3/"):
            self.forced_exception = False
            raise httpx.ReadTimeout("fixture timeout", request=request)
        if self.fail_upload_start and path.startswith("/upload/drive/v3/files"):
            self.fail_upload_start = False
            raise httpx.ReadTimeout("fixture timeout", request=request)
        if self.forced_status is not None and path.startswith("/drive/v3/"):
            status = self.forced_status
            self.forced_status = None
            return httpx.Response(
                status,
                headers={"Retry-After": "0"},
                json={"error": {"errors": [{"reason": self.forced_reason}]}},
            )
        if path.startswith("/upload/session/"):
            return self._session(request)
        if path == "/upload/drive/v3/files" or path.startswith(
            "/upload/drive/v3/files/"
        ):
            if request.url.params.get("uploadType") == "media":
                item_id = path.rsplit("/", 1)[1]
                item = self.items[item_id]
                self.content[item_id] = request.content
                item["size"] = str(len(request.content))
                item["version"] = str(int(item["version"]) + 1)
                return httpx.Response(200, json=item)
            return self._start_upload(request)
        if path == "/drive/v3/files":
            if request.method == "GET":
                return self._list(request)
            if request.method == "POST":
                payload = json.loads(request.content)
                item = self.inject(
                    payload["name"],
                    parent=payload["parents"][0],
                    kind=(
                        "directory" if payload["mimeType"] == FOLDER_MIME else "file"
                    ),
                )
                return httpx.Response(200, json=item)
        if path.startswith("/drive/v3/files/"):
            item_id = path.rsplit("/", 1)[1]
            item = self.items.get(item_id)
            if item is None or item["trashed"]:
                return httpx.Response(404)
            if request.method == "GET" and request.url.params.get("alt") == "media":
                return self._media(request, item_id)
            if request.method == "GET":
                return httpx.Response(200, json=item)
            if request.method == "PATCH":
                payload = json.loads(request.content)
                item.update(payload)
                new_parent = request.url.params.get("addParents")
                if new_parent:
                    item["parents"] = [new_parent]
                return httpx.Response(200, json=item)
        raise AssertionError(f"unexpected fixture request: {request.method} {path}")

    def _list(self, request: httpx.Request) -> httpx.Response:
        query = request.url.params["q"]
        parent_match = re.search(r"'([^']+)' in parents", query)
        assert parent_match is not None
        parent = parent_match.group(1)
        name_match = re.search(r"name = '((?:\\'|[^'])*)'", query)
        name = name_match.group(1).replace("\\'", "'") if name_match else None
        files = [
            item
            for item in self.items.values()
            if item["parents"] == [parent]
            and not item["trashed"]
            and (name is None or item["name"] == name)
        ]
        start = int(request.url.params.get("pageToken", "0"))
        page = files[start : start + 2]
        next_token = str(start + 2) if start + 2 < len(files) else None
        return httpx.Response(200, json={"files": page, "nextPageToken": next_token})

    def _media(self, request: httpx.Request, item_id: str) -> httpx.Response:
        data = self.content[item_id]
        requested_range = request.headers.get("Range")
        if requested_range and not self.ignore_range:
            match = re.fullmatch(r"bytes=(\d+)-(\d+)", requested_range)
            assert match is not None
            start, end = map(int, match.groups())
            if start >= len(data):
                return httpx.Response(416)
            end = min(end, len(data) - 1)
            result = httpx.Response(
                206,
                content=data[start : end + 1],
                headers={"Content-Range": f"bytes {start}-{end}/{len(data)}"},
            )
        else:
            result = httpx.Response(200, content=data)
        self.last_media_response = result
        return result

    def _start_upload(self, request: httpx.Request) -> httpx.Response:
        assert request.url.params["uploadType"] == "resumable"
        session_id = str(self.next_session)
        self.next_session += 1
        item_id = (
            request.url.path.rsplit("/", 1)[1] if request.method == "PATCH" else None
        )
        self.sessions[session_id] = {
            "item_id": item_id,
            "metadata": json.loads(request.content),
            "content": bytearray(),
            "completed": None,
        }
        return httpx.Response(
            200,
            headers={
                "Location": (f"https://www.googleapis.com/upload/session/{session_id}")
            },
        )

    def _session(self, request: httpx.Request) -> httpx.Response:
        session_id = request.url.path.rsplit("/", 1)[1]
        session = self.sessions[session_id]
        if request.method == "DELETE":
            self.cancel_count += 1
            return httpx.Response(204)
        assert request.method == "PUT"
        content_range = request.headers["Content-Range"]
        if content_range.startswith("bytes */") and not request.content:
            if session["completed"] is not None:
                return httpx.Response(200, json=session["completed"])
            received = len(session["content"])
            headers = {"Range": f"bytes=0-{received - 1}"} if received else {}
            return httpx.Response(308, headers=headers)
        if content_range == "bytes */0":
            total = 0
        else:
            match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
            assert match is not None
            start, end, total = map(int, match.groups())
            assert start == len(session["content"])
            assert end - start + 1 == len(request.content)
        session["content"].extend(request.content)
        if len(session["content"]) < total:
            return httpx.Response(
                308,
                headers={"Range": f"bytes=0-{len(session['content']) - 1}"},
            )
        item_id = session["item_id"]
        if item_id is None:
            metadata = session["metadata"]
            item = self.inject(
                metadata["name"],
                parent=metadata["parents"][0],
                data=bytes(session["content"]),
            )
            if self.race_on_create:
                self.race_on_create = False
                self.inject(metadata["name"], parent=metadata["parents"][0])
        else:
            item = self.items[item_id]
            self.content[item_id] = bytes(session["content"])
            item["size"] = str(len(session["content"]))
            item["version"] = str(int(item["version"]) + 1)
        session["completed"] = item
        if self.lose_final_response:
            self.lose_final_response = False
            return httpx.Response(503)
        return httpx.Response(200, json=item)


class GoogleDriveStorageTest(unittest.TestCase):
    def setUp(self) -> None:
        self.api = GoogleApiFixture()
        self.client = httpx.Client(transport=httpx.MockTransport(self.api))
        self.store = MemoryCredentialStore(GoogleToken("test-token"))
        self.auth = GoogleAuth(store=self.store)
        self.storage = GoogleDriveStorage(
            root_id="root", auth=self.auth, client=self.client
        )

    def tearDown(self) -> None:
        self.client.close()

    def test_lifecycle_and_streams(self) -> None:
        folder = self.storage.mkdir("/reports")
        self.assertEqual(folder.kind, "directory")
        data = b"ab" * (2 * 1024 * 1024 + 3)
        entry = self.storage.write("/reports/data.bin", BytesIO(data), size=len(data))
        self.assertEqual(entry.size, len(data))
        self.assertEqual(self.storage.read_range(entry.ref, 1, 4), b"baba")
        self.assertEqual(self.storage.read_range(entry.ref, len(data) + 1, 4), b"")
        with self.storage.open_reader(entry.ref) as reader:
            self.assertEqual(reader.read(2), b"ab")
        assert self.api.last_media_response is not None
        self.assertTrue(self.api.last_media_response.is_closed)
        self.assertEqual(self.storage.read(entry.ref), data)
        moved = self.storage.move(entry.ref, "/reports/new.bin")
        self.assertEqual(moved.path, "/reports/new.bin")
        self.assertEqual(self.storage.stat(entry.ref).path, moved.path)
        self.assertEqual(len(list(self.storage.list(folder.ref))), 1)
        with self.assertRaises(DirectoryNotEmptyError):
            self.storage.delete(folder.ref)
        self.storage.delete(entry.ref)
        self.assertFalse(self.storage.exists(moved.path))
        self.storage.delete(folder.ref)

    def test_duplicates_and_other(self) -> None:
        first = self.api.inject("same", data=b"a")
        self.api.inject("same", data=b"b")
        self.assertEqual(len(list(self.storage.list("/"))), 2)
        with self.assertRaises(AmbiguousPathError):
            self.storage.stat("/same")
        ref = next(
            entry.ref for entry in self.storage.list("/") if entry.id == first["id"]
        )
        self.assertEqual(self.storage.read(ref), b"a")
        self.api.inject("native", kind="other")
        self.assertEqual(self.storage.stat("/native").kind, "other")

    def test_creation_race_and_root_validation(self) -> None:
        self.api.race_on_create = True
        with self.assertRaises(ConflictError) as caught:
            self.storage.write("/race", b"a")
        self.assertEqual(len(caught.exception.item_ids), 2)
        self.api.items["root"]["driveId"] = "shared-drive"
        with self.assertRaises(NotFoundError):
            self.storage.stat("/")

    def test_ref_outside_root_and_range_ignored(self) -> None:
        item = self.api.inject("item", data=b"abcdef")
        ref = self.storage.stat("/item").ref
        self.api.ignore_range = True
        with self.assertRaises(ProviderError):
            self.storage.read_range(ref, 2, 2)
        item["parents"] = ["outside"]
        with self.assertRaises(NotFoundError):
            self.storage.stat(ref)

    def test_upload_size_and_uncertain_completion(self) -> None:
        with self.assertRaises(InvalidUploadSourceError):
            self.storage.write("/missing", BytesIO(b"a"))
        self.assertEqual(self.api.next_session, 1)
        with self.assertRaises(InvalidUploadSourceError):
            self.storage.write("/bad", BytesIO(b"abc"), size=2)
        self.assertEqual(self.api.cancel_count, 1)
        with self.assertRaises(InvalidUploadSourceError):
            self.storage.write("/short", BytesIO(b"a"), size=2)
        self.assertEqual(self.api.cancel_count, 2)
        empty = self.storage.write("/empty", b"")
        self.assertEqual(empty.size, 0)
        self.assertEqual(self.storage.read(empty.ref), b"")
        self.api.lose_final_response = True
        entry = self.storage.write("/recovered", b"ok")
        self.assertEqual(self.storage.read(entry.ref), b"ok")
        replaced = self.storage.write("/recovered", b"new", overwrite=True)
        self.assertEqual(replaced.id, entry.id)
        self.assertEqual(replaced.version, "2")
        with self.assertRaises(UnsupportedOperationError):
            self.storage.write(
                "/recovered",
                b"changed",
                overwrite=True,
                expected_version="1",
            )

    def test_error_mapping_and_refresh(self) -> None:
        self.api.forced_status = 403
        with self.assertRaises(PermissionDeniedError):
            self.storage.exists("/missing")
        self.api.forced_status = 403
        self.api.forced_reason = "storageQuotaExceeded"
        with self.assertRaises(QuotaExceededError):
            self.storage.stat("/")
        self.api.forced_status = 429
        self.assertEqual(self.storage.stat("/").kind, "directory")
        self.api.forced_status = 503
        self.assertEqual(self.storage.stat("/").kind, "directory")
        for status in (409, 412):
            self.api.forced_status = status
            with self.assertRaises(ConflictError):
                self.storage.stat("/")
        self.api.forced_exception = True
        with self.assertRaises(ProviderUnavailableError):
            self.storage.stat("/")
        self.api.fail_upload_start = True
        with self.assertRaises(IndeterminateOperationError):
            self.storage.write("/unknown", b"x")
        expired = GoogleToken(
            "test-token",
            "refresh-token",
            datetime.now(timezone.utc) - timedelta(minutes=1),
        )
        self.store.save(expired)
        auth = GoogleAuth(store=self.store, client_id="client", client_secret="secret")
        storage = GoogleDriveStorage(root_id="root", auth=auth, client=self.client)
        self.assertEqual(storage.stat("/").kind, "directory")
        self.assertEqual(self.api.refresh_count, 1)
        assert self.store.load() is not None
        self.assertEqual(self.store.load().access_token, "new-token")

        class FailingStore(MemoryCredentialStore):
            def save(self, token: GoogleToken) -> None:
                raise RuntimeError("secret should not appear")

        failing = FailingStore(expired)
        bad_auth = GoogleAuth(store=failing, client_id="client", client_secret="secret")
        with self.assertRaises(AuthenticationError) as caught:
            bad_auth.access_token(self.client)
        self.assertNotIn("secret", str(caught.exception))

    def test_mutation_response_body_failure_is_indeterminate(self) -> None:
        corrupt_body = b"{"
        corrupt_read = False

        def handler(request: httpx.Request) -> httpx.Response:
            if corrupt_read and request.method == "GET":
                return httpx.Response(200, content=b"{")
            response = self.api(request)
            if request.method == "POST" and request.url.path == "/drive/v3/files":
                return httpx.Response(response.status_code, content=corrupt_body)
            return response

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            storage = GoogleDriveStorage(root_id="root", auth=self.auth, client=client)
            for index, body in enumerate((b"{", b"[]", b"{}")):
                corrupt_body = body
                with self.subTest(body=body):
                    with self.assertRaises(IndeterminateOperationError):
                        storage.mkdir(f"/created-{index}")
            corrupt_read = True
            with self.assertRaises(ProviderError):
                storage.stat("/")

    def test_unauthorized_response_refreshes_once(self) -> None:
        store = MemoryCredentialStore(GoogleToken("test-token", "refresh-token"))
        auth = GoogleAuth(store=store, client_id="client", client_secret="secret")
        storage = GoogleDriveStorage(root_id="root", auth=auth, client=self.client)
        self.api.forced_status = 401
        self.assertEqual(storage.stat("/").path, "/")
        self.assertEqual(self.api.refresh_count, 1)

    def test_app_owned_token_provider_handles_unauthorized_response(self) -> None:
        class AppAuth:
            def __init__(self) -> None:
                self.calls: list[tuple[bool, str | None]] = []
                self.token = "test-token"

            def access_token(
                self,
                client: httpx.Client,
                *,
                force_refresh: bool = False,
                failed_token: str | None = None,
            ) -> str:
                self.calls.append((force_refresh, failed_token))
                if force_refresh:
                    self.token = "new-token"
                return self.token

        auth = AppAuth()
        storage = GoogleDriveStorage(root_id="root", auth=auth, client=self.client)
        self.api.forced_status = 401
        self.assertEqual(storage.stat("/").kind, "directory")
        self.assertEqual(auth.calls[:2], [(False, None), (True, "test-token")])
        self.assertEqual(auth.calls[2:], [(False, None)])
        self.assertEqual(self.api.refresh_count, 0)

    def test_concurrent_unauthorized_requests_refresh_once(self) -> None:
        barrier = Barrier(2)
        refresh_count = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal refresh_count
            if request.url.host == "oauth2.googleapis.com":
                refresh_count += 1
                return httpx.Response(200, json={"access_token": "new-token"})
            self.assertEqual(request.url.path, "/drive/v3/files/root")
            if request.headers["Authorization"] == "Bearer test-token":
                barrier.wait(timeout=5)
                return httpx.Response(401)
            self.assertEqual(request.headers["Authorization"], "Bearer new-token")
            return httpx.Response(
                200,
                json={
                    "id": "root",
                    "name": "root",
                    "mimeType": FOLDER_MIME,
                    "parents": ["my-drive"],
                    "trashed": False,
                },
            )

        store = MemoryCredentialStore(GoogleToken("test-token", "refresh-token"))
        auth = GoogleAuth(store=store, client_id="client", client_secret="secret")
        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            storage = GoogleDriveStorage(root_id="root", auth=auth, client=client)
            with ThreadPoolExecutor(max_workers=2) as executor:
                kinds = list(
                    executor.map(lambda _index: storage.stat("/").kind, range(2))
                )
        self.assertEqual(kinds, ["directory", "directory"])
        self.assertEqual(refresh_count, 1)


if __name__ == "__main__":
    unittest.main()
