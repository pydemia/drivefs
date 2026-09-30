"""Public API smoke run with installed wheels and an HTTP fixture."""

from __future__ import annotations

import sys
from importlib.metadata import requires, version
from importlib.util import find_spec

import drivefs


def core_only() -> None:
    assert version("drivefs") == "0.1.0"
    assert not requires("drivefs")
    assert drivefs.normalize_path("notes/./file") == "/notes/file"
    print("core wheel: import, API, no runtime dependencies OK")


def isolated_plugin(name: str) -> None:
    modules = {
        "gdrive": "drivefs_gdrive",
        "microsoft": "drivefs_microsoft",
        "fsspec": "drivefs_fsspec",
    }
    assert find_spec(modules[name]) is not None
    for other, module in modules.items():
        if other != name:
            assert find_spec(module) is None
    assert any(req.startswith("drivefs") for req in requires(f"drivefs-{name}") or [])
    print(f"{name} wheel: selected plugin and core only OK")


def full() -> None:
    import httpx
    from drivefs_fsspec import DriveFSFileSystem
    from drivefs_gdrive import (
        GoogleAuth,
        GoogleDriveStorage,
        GoogleToken,
    )
    from drivefs_gdrive import (
        MemoryCredentialStore as GoogleStore,
    )
    from drivefs_microsoft import (
        GraphAuth,
        GraphToken,
        OneDriveStorage,
        SharePointStorage,
    )
    from drivefs_microsoft import (
        MemoryCredentialStore as GraphStore,
    )

    content = b"abcdefghij"

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        host = request.url.host
        if host == "download.example":
            range_header = request.headers.get("Range")
            if range_header:
                start, end = (
                    int(value)
                    for value in range_header.removeprefix("bytes=").split("-")
                )
                end = min(end, len(content) - 1)
                return httpx.Response(
                    206,
                    content=content[start : end + 1],
                    headers={"Content-Range": f"bytes {start}-{end}/{len(content)}"},
                )
            return httpx.Response(200, content=content)
        if host == "www.googleapis.com":
            root = {
                "id": "root",
                "name": "root",
                "mimeType": "application/vnd.google-apps.folder",
                "parents": ["my-drive"],
                "trashed": False,
            }
            item = {
                "id": "file",
                "name": "data.bin",
                "mimeType": "application/octet-stream",
                "size": str(len(content)),
                "parents": ["root"],
                "trashed": False,
            }
            if path == "/drive/v3/files/root":
                return httpx.Response(200, json=root)
            if path == "/drive/v3/files":
                return httpx.Response(200, json={"files": [item]})
            if path == "/drive/v3/files/file":
                if request.url.params.get("alt") == "media":
                    range_header = request.headers.get("Range")
                    if range_header:
                        start, end = (
                            int(value)
                            for value in range_header.removeprefix("bytes=").split("-")
                        )
                        return httpx.Response(
                            206,
                            content=content[start : end + 1],
                            headers={
                                "Content-Range": f"bytes {start}-{end}/{len(content)}"
                            },
                        )
                    return httpx.Response(200, content=content)
                return httpx.Response(200, json=item)
        if host == "graph.microsoft.com":
            if path == "/v1.0/sites/site/drives":
                return httpx.Response(200, json={"value": [{"id": "drive"}]})
            if path == "/v1.0/drives/drive":
                return httpx.Response(200, json={"driveType": graph_drive_type[0]})
            if path == "/v1.0/drives/drive/items/root":
                return httpx.Response(
                    200,
                    json={
                        "id": "root",
                        "name": "root",
                        "folder": {},
                        "sharepointIds": {"siteId": "site"},
                    },
                )
            if path == "/v1.0/drives/drive/items/root/children":
                return httpx.Response(
                    200,
                    json={
                        "value": [
                            {
                                "id": "file",
                                "name": "data.bin",
                                "file": {"mimeType": "application/octet-stream"},
                                "size": len(content),
                                "parentReference": {"id": "root", "driveId": "drive"},
                            }
                        ]
                    },
                )
            if path == "/v1.0/drives/drive/items/file/content":
                return httpx.Response(
                    302, headers={"Location": "https://download.example/file"}
                )
        raise AssertionError(f"unexpected fixture request: {host} {path}")

    graph_drive_type = ["personal"]
    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        google = GoogleDriveStorage(
            root_id="root",
            auth=GoogleAuth(store=GoogleStore(GoogleToken("token"))),
            client=client,
        )
        assert google.stat("/data.bin").kind == "file"
        assert google.read_range("/data.bin", 2, 3) == b"cde"
        fs = DriveFSFileSystem(storage=google)
        with fs.open("/data.bin", "rb") as reader:
            reader.seek(4)
            assert reader.read(3) == b"efg"

        personal = OneDriveStorage(
            drive_id="drive",
            root_id="root",
            auth=GraphAuth(
                tenant_id="consumers",
                client_id="client",
                store=GraphStore(GraphToken("token")),
            ),
            client=client,
        )
        assert personal.stat("/data.bin").size == len(content)
        assert personal.read_range("/data.bin", 1, 3) == b"bcd"

        graph_drive_type[0] = "documentLibrary"
        sharepoint = SharePointStorage(
            site_id="site",
            drive_id="drive",
            root_id="root",
            auth=GraphAuth(
                tenant_id="tenant",
                client_id="client",
                store=GraphStore(GraphToken("token")),
            ),
            client=client,
        )
        assert sharepoint.stat("/data.bin").kind == "file"
        assert sharepoint.read_range("/data.bin", 3, 2) == b"de"
    finally:
        client.close()
    for name in ("drivefs-gdrive", "drivefs-microsoft", "drivefs-fsspec"):
        assert any(req.startswith("drivefs") for req in requires(name) or [])
    print("four wheels: public provider API, fsspec range seek OK")


if __name__ == "__main__":
    if sys.argv[1:] == ["core"]:
        core_only()
    elif len(sys.argv) == 3 and sys.argv[1] == "isolated":
        isolated_plugin(sys.argv[2])
    elif sys.argv[1:] == ["full"]:
        full()
    else:
        raise SystemExit("expected core or full")
