"""Exercise both public Graph backends through HTTP-only fixtures."""

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
from drivefs_microsoft import (
    GraphAuth,
    GraphToken,
    MemoryCredentialStore,
    OneDriveStorage,
    SharePointStorage,
)


class GraphApiFixture:
    def __init__(self, *, drive_type: str, site_id: str | None = None) -> None:
        self.drive_type = drive_type
        self.site_id = site_id
        root: dict[str, Any] = {
            "id": "root",
            "name": "root",
            "folder": {},
            "parentReference": {"id": "drive-root", "driveId": "drive"},
        }
        if site_id is not None:
            root["sharepointIds"] = {"siteId": site_id}
        self.items: dict[str, dict[str, Any]] = {"root": root}
        self.content: dict[str, bytes] = {}
        self.sessions: dict[str, dict[str, Any]] = {}
        self.next_id = 1
        self.next_session = 1
        self.cancel_count = 0
        self.refresh_count = 0
        self.forced_status: int | None = None
        self.forced_exception = False
        self.ignore_range = False
        self.lose_final_response = False
        self.expire_session_after_commit = False
        self.last_download: httpx.Response | None = None
        self.signed_authorization_seen = False

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
        item: dict[str, Any] = {
            "id": item_id,
            "name": name,
            "parentReference": {"id": parent, "driveId": "drive"},
            "size": len(data),
            "eTag": '"v1"',
        }
        if kind == "directory":
            item["folder"] = {}
        elif kind == "file":
            item["file"] = {"mimeType": "application/octet-stream"}
            self.content[item_id] = data
        else:
            item["package"] = {}
        self.items[item_id] = item
        return item

    def __call__(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if host == "login.microsoftonline.com":
            self.refresh_count += 1
            return httpx.Response(
                200, json={"access_token": "new-token", "expires_in": 3600}
            )
        if host in ("download.example", "upload.example"):
            if request.headers.get("Authorization"):
                self.signed_authorization_seen = True
            return (
                self._download(request)
                if host == "download.example"
                else self._session(request)
            )
        if request.headers.get("Authorization") not in (
            "Bearer test-token",
            "Bearer new-token",
        ):
            return httpx.Response(401)
        path = request.url.path
        if self.forced_exception and path.startswith("/v1.0/"):
            self.forced_exception = False
            raise httpx.ReadTimeout("fixture timeout", request=request)
        if self.forced_status is not None and path.startswith("/v1.0/"):
            status = self.forced_status
            self.forced_status = None
            return httpx.Response(status, headers={"Retry-After": "0"})
        if path == "/v1.0/sites/site/drives":
            return httpx.Response(
                200,
                json={"value": [{"id": "drive", "driveType": "documentLibrary"}]},
            )
        if path == "/v1.0/drives/drive":
            return httpx.Response(
                200, json={"id": "drive", "driveType": self.drive_type}
            )
        if path.startswith("/v1.0/drives/drive/items/"):
            return self._item_request(request)
        raise AssertionError(f"unexpected Graph request: {request.method} {path}")

    def _item_request(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        base = "/v1.0/drives/drive/items/"
        suffix = path[len(base) :]
        if suffix.endswith("/createUploadSession") or suffix.endswith(
            ":/createUploadSession"
        ):
            return self._start_upload(request)
        if suffix.endswith("/children"):
            parent_id = suffix[: -len("/children")]
            if request.method == "GET":
                return self._children(parent_id, request)
            payload = json.loads(request.content)
            name = payload["name"]
            if any(
                item["name"] == name and item["parentReference"]["id"] == parent_id
                for item in self.items.values()
                if item is not self.items["root"]
            ):
                return httpx.Response(409)
            item = self.inject(
                name,
                parent=parent_id,
                kind="directory" if "folder" in payload else "file",
            )
            return httpx.Response(201, json=item)
        if suffix.endswith("/content"):
            item_id = suffix[: -len("/content")]
            if request.method == "GET":
                return httpx.Response(
                    302,
                    headers={"Location": f"https://download.example/{item_id}"},
                )
            if request.method == "PUT":
                if ":/" in item_id:
                    parent_id, name = item_id.split(":/", 1)
                    name = name.removesuffix(":")
                    if any(
                        item["name"] == name
                        and item["parentReference"]["id"] == parent_id
                        for item in self.items.values()
                        if item is not self.items["root"]
                    ):
                        return httpx.Response(409)
                    return httpx.Response(
                        201,
                        json=self.inject(name, parent=parent_id, data=request.content),
                    )
                item = self.items[item_id]
                self.content[item_id] = request.content
                item["size"] = len(request.content)
                item["eTag"] = '"v2"'
                return httpx.Response(200, json=item)
        item_id = suffix
        item = self.items.get(item_id)
        if item is None:
            return httpx.Response(404)
        if request.method == "GET":
            return httpx.Response(200, json=item)
        if request.method == "PATCH":
            payload = json.loads(request.content)
            if "name" in payload:
                item["name"] = payload["name"]
            if "parentReference" in payload:
                item["parentReference"]["id"] = payload["parentReference"]["id"]
            return httpx.Response(200, json=item)
        if request.method == "DELETE":
            del self.items[item_id]
            return httpx.Response(204)
        raise AssertionError(f"unexpected item request: {request.method} {path}")

    def _children(self, parent_id: str, request: httpx.Request) -> httpx.Response:
        values = [
            item
            for item in self.items.values()
            if item["parentReference"]["id"] == parent_id
        ]
        start = int(request.url.params.get("$skiptoken", "0"))
        next_link = (
            f"https://graph.microsoft.com/v1.0/drives/drive/items/"
            f"{parent_id}/children?$skiptoken={start + 2}"
            if start + 2 < len(values)
            else None
        )
        return httpx.Response(
            200,
            json={"value": values[start : start + 2], "@odata.nextLink": next_link},
        )

    def _download(self, request: httpx.Request) -> httpx.Response:
        item_id = request.url.path.strip("/")
        data = self.content[item_id]
        range_header = request.headers.get("Range")
        if range_header and not self.ignore_range:
            match = re.fullmatch(r"bytes=(\d+)-(\d+)", range_header)
            assert match is not None
            start, end = map(int, match.groups())
            if start >= len(data):
                return httpx.Response(416)
            end = min(end, len(data) - 1)
            response = httpx.Response(
                206,
                content=data[start : end + 1],
                headers={"Content-Range": f"bytes {start}-{end}/{len(data)}"},
            )
        else:
            response = httpx.Response(200, content=data)
        self.last_download = response
        return response

    def _start_upload(self, request: httpx.Request) -> httpx.Response:
        suffix = request.url.path.split("/items/")[1]
        existing_id = None
        parent_id = None
        name = None
        if ":/" in suffix:
            parent_id, tail = suffix.split(":/", 1)
            name = tail.split(":/")[0]
        else:
            existing_id = suffix.split("/")[0]
        session_id = str(self.next_session)
        self.next_session += 1
        self.sessions[session_id] = {
            "existing_id": existing_id,
            "parent_id": parent_id,
            "name": name,
            "bytes": bytearray(),
            "completed": None,
        }
        return httpx.Response(
            200, json={"uploadUrl": f"https://upload.example/{session_id}"}
        )

    def _session(self, request: httpx.Request) -> httpx.Response:
        session = self.sessions[request.url.path.strip("/")]
        if request.method == "DELETE":
            self.cancel_count += 1
            return httpx.Response(204)
        if request.method == "GET":
            if session["completed"] is not None:
                if self.expire_session_after_commit:
                    return httpx.Response(404)
                return httpx.Response(200, json=session["completed"])
            return httpx.Response(
                200,
                json={"nextExpectedRanges": [f"{len(session['bytes'])}-"]},
            )
        assert request.method == "PUT"
        match = re.fullmatch(
            r"bytes (\d+)-(\d+)/(\d+)",
            request.headers["Content-Range"],
        )
        assert match is not None
        start, end, total = map(int, match.groups())
        assert start == len(session["bytes"])
        assert end - start + 1 == len(request.content)
        session["bytes"].extend(request.content)
        if len(session["bytes"]) < total:
            return httpx.Response(
                202,
                json={"nextExpectedRanges": [f"{len(session['bytes'])}-"]},
            )
        if session["existing_id"] is not None:
            item = self.items[session["existing_id"]]
            item["size"] = len(session["bytes"])
            item["eTag"] = '"v2"'
            self.content[item["id"]] = bytes(session["bytes"])
        else:
            item = self.inject(
                session["name"],
                parent=session["parent_id"],
                data=bytes(session["bytes"]),
            )
        session["completed"] = item
        if self.lose_final_response:
            self.lose_final_response = False
            return httpx.Response(503)
        return httpx.Response(201, json=item)


class MicrosoftStorageTest(unittest.TestCase):
    def _make(
        self, kind: str
    ) -> tuple[
        GraphApiFixture,
        httpx.Client,
        OneDriveStorage | SharePointStorage,
        MemoryCredentialStore,
    ]:
        site_id = "site" if kind == "sharepoint" else None
        drive_type = "documentLibrary" if site_id else "personal"
        api = GraphApiFixture(drive_type=drive_type, site_id=site_id)
        client = httpx.Client(transport=httpx.MockTransport(api))
        store = MemoryCredentialStore(GraphToken("test-token"))
        auth = GraphAuth(
            tenant_id="tenant" if site_id else "consumers",
            client_id="client",
            store=store,
        )
        storage: OneDriveStorage | SharePointStorage
        if site_id:
            storage = SharePointStorage(
                site_id=site_id,
                drive_id="drive",
                root_id="root",
                auth=auth,
                client=client,
            )
        else:
            storage = OneDriveStorage(
                drive_id="drive",
                root_id="root",
                auth=auth,
                client=client,
            )
        return api, client, storage, store

    def test_lifecycle_in_both_roots(self) -> None:
        for kind in ("personal", "sharepoint"):
            with self.subTest(kind=kind):
                api, client, storage, _ = self._make(kind)
                try:
                    folder = storage.mkdir("/reports")
                    self.assertEqual(folder.kind, "directory")
                    data = b"ab" * (2 * 1024 * 1024 + 3)
                    entry = storage.write(
                        "/reports/data.bin", BytesIO(data), size=len(data)
                    )
                    self.assertEqual(entry.size, len(data))
                    self.assertEqual(storage.read_range(entry.ref, 1, 4), b"baba")
                    with storage.open_reader(entry.ref) as reader:
                        self.assertEqual(reader.read(2), b"ab")
                    assert api.last_download is not None
                    self.assertTrue(api.last_download.is_closed)
                    self.assertFalse(api.signed_authorization_seen)
                    self.assertEqual(storage.read(entry.ref), data)
                    moved = storage.move(entry.ref, "/reports/new.bin")
                    self.assertEqual(storage.stat(entry.ref).path, moved.path)
                    self.assertEqual(len(list(storage.list(folder.ref))), 1)
                    with self.assertRaises(DirectoryNotEmptyError):
                        storage.delete(folder.ref)
                    storage.delete(entry.ref)
                    self.assertFalse(storage.exists(moved.path))
                    storage.delete(folder.ref)
                finally:
                    client.close()

    def test_empty_replace_and_size(self) -> None:
        api, client, storage, _ = self._make("personal")
        try:
            with self.assertRaises(InvalidUploadSourceError):
                storage.write("/unknown", BytesIO(b"a"))
            self.assertEqual(api.next_session, 1)
            with self.assertRaises(InvalidUploadSourceError):
                storage.write("/bad", BytesIO(b"abc"), size=2)
            self.assertEqual(api.cancel_count, 1)
            empty = storage.write("/empty", b"")
            self.assertEqual(empty.size, 0)
            entry = storage.write("/item", b"ok")
            replaced = storage.write("/item", b"new", overwrite=True)
            self.assertEqual(entry.id, replaced.id)
            self.assertEqual(replaced.version, '"v2"')
            with self.assertRaises(UnsupportedOperationError):
                storage.write(
                    "/item",
                    b"x",
                    overwrite=True,
                    expected_version='"v2"',
                )
        finally:
            client.close()

    def test_duplicates_outside_and_range(self) -> None:
        api, client, storage, _ = self._make("personal")
        try:
            first = api.inject("same", data=b"one")
            api.inject("same", data=b"two")
            self.assertEqual(len(list(storage.list("/"))), 2)
            with self.assertRaises(AmbiguousPathError):
                storage.stat("/same")
            ref = next(
                entry.ref for entry in storage.list("/") if entry.id == first["id"]
            )
            api.ignore_range = True
            with self.assertRaises(ProviderError):
                storage.read_range(ref, 1, 2)
            first["parentReference"]["id"] = "outside"
            with self.assertRaises(NotFoundError):
                storage.stat(ref)
        finally:
            client.close()

    def test_errors_and_refresh(self) -> None:
        api, client, storage, store = self._make("personal")
        try:
            api.forced_status = 403
            with self.assertRaises(PermissionDeniedError):
                storage.exists("/missing")
            api.forced_status = 429
            self.assertEqual(storage.stat("/").kind, "directory")
            api.forced_status = 503
            self.assertEqual(storage.stat("/").kind, "directory")
            api.forced_status = 507
            with self.assertRaises(QuotaExceededError):
                storage.stat("/")
            for status in (409, 412):
                api.forced_status = status
                with self.assertRaises(ConflictError):
                    storage.stat("/")
            api.forced_exception = True
            with self.assertRaises(ProviderUnavailableError):
                storage.stat("/")
            store.save(GraphToken("test-token", "refresh-token"))
            api.forced_status = 401
            self.assertEqual(storage.stat("/").kind, "directory")
            self.assertEqual(api.refresh_count, 1)
            expired = GraphToken(
                "test-token",
                "refresh-token",
                datetime.now(timezone.utc) - timedelta(minutes=1),
            )
            store.save(expired)
            auth = GraphAuth(tenant_id="consumers", client_id="client", store=store)
            refreshed = OneDriveStorage(
                drive_id="drive",
                root_id="root",
                auth=auth,
                client=client,
            )
            self.assertEqual(refreshed.stat("/").kind, "directory")
            self.assertEqual(api.refresh_count, 2)

            class FailingStore(MemoryCredentialStore):
                def save(self, token: GraphToken) -> None:
                    raise RuntimeError("secret should not appear")

            failing = FailingStore(expired)
            bad_auth = GraphAuth(
                tenant_id="consumers", client_id="client", store=failing
            )
            with self.assertRaises(AuthenticationError) as caught:
                bad_auth.access_token(client)
            self.assertNotIn("secret", str(caught.exception))
        finally:
            client.close()

    def test_upload_completion_uncertain(self) -> None:
        api, client, storage, _ = self._make("sharepoint")
        try:
            api.lose_final_response = True
            recovered = storage.write("/recovered", b"data")
            self.assertEqual(recovered.size, 4)
            api.lose_final_response = True
            api.expire_session_after_commit = True
            with self.assertRaises(IndeterminateOperationError):
                storage.write("/unknown", b"data")
        finally:
            client.close()

    def test_concurrent_unauthorized_requests_refresh_once(self) -> None:
        barrier = Barrier(2)
        refresh_count = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal refresh_count
            if request.url.host == "login.microsoftonline.com":
                refresh_count += 1
                return httpx.Response(200, json={"access_token": "new-token"})
            if request.url.path == "/v1.0/drives/drive":
                if request.headers["Authorization"] == "Bearer test-token":
                    barrier.wait(timeout=5)
                    return httpx.Response(401)
                self.assertEqual(request.headers["Authorization"], "Bearer new-token")
                return httpx.Response(200, json={"driveType": "personal"})
            self.assertEqual(request.url.path, "/v1.0/drives/drive/items/root")
            return httpx.Response(
                200,
                json={"id": "root", "name": "root", "folder": {}},
            )

        store = MemoryCredentialStore(GraphToken("test-token", "refresh-token"))
        auth = GraphAuth(tenant_id="consumers", client_id="client", store=store)
        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            storage = OneDriveStorage(
                drive_id="drive", root_id="root", auth=auth, client=client
            )
            with ThreadPoolExecutor(max_workers=2) as executor:
                kinds = list(
                    executor.map(lambda _index: storage.stat("/").kind, range(2))
                )
        self.assertEqual(kinds, ["directory", "directory"])
        self.assertEqual(refresh_count, 1)
