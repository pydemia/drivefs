"""Opt-in real-account lifecycle check; run only with a private config file."""

from __future__ import annotations

import hashlib
import io
import json
import os
import stat
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from drivefs import FileStorage
from drivefs_gdrive import GoogleAuth, GoogleDriveStorage, GoogleToken
from drivefs_microsoft import GraphAuth, GraphToken, OneDriveStorage, SharePointStorage

REPO_ROOT = Path(__file__).resolve().parent.parent
LARGE_SIZE = 4 * 1024 * 1024 + 17


def _required(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a nonempty string")
    return value


def _ensure(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


class PrivateConfig:
    def __init__(self, path: Path) -> None:
        self.path = path.resolve(strict=True)
        if self.path.is_relative_to(REPO_ROOT):
            raise ValueError("live config must be outside the repository")
        if os.name != "nt" and stat.S_IMODE(self.path.stat().st_mode) & 0o077:
            raise ValueError("live config must be readable only by its owner")
        data = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("live config must be a JSON object")
        self.data: dict[str, Any] = data
        self.provider = _required(data.get("provider"), "provider")
        if self.provider not in {"gdrive", "onedrive", "sharepoint"}:
            raise ValueError("provider must be gdrive, onedrive, or sharepoint")
        self.root_id = _required(data.get("root_id"), "root_id")
        self.client_id = _required(data.get("client_id"), "client_id")
        if self.provider == "gdrive":
            _required(data.get("client_secret"), "client_secret")
        else:
            _required(data.get("drive_id"), "drive_id")
            _required(data.get("tenant_id"), "tenant_id")
            if self.provider == "onedrive" and data["tenant_id"] != "consumers":
                raise ValueError("OneDrive Personal requires tenant_id=consumers")
            if self.provider == "sharepoint":
                _required(data.get("site_id"), "site_id")
                if data["tenant_id"] in {"common", "consumers"}:
                    raise ValueError("SharePoint requires a tenant-specific ID")
        token = data.get("token")
        if not isinstance(token, dict):
            raise ValueError("token must be a JSON object")
        _required(token.get("access_token"), "token.access_token")
        _required(token.get("refresh_token"), "token.refresh_token")
        self.save_count = 0

    def load(self) -> GoogleToken | GraphToken:
        token = self.data["token"]
        # Force an actual refresh before the first provider request.
        token_type = GoogleToken if self.provider == "gdrive" else GraphToken
        return token_type(
            access_token=token["access_token"],
            refresh_token=token["refresh_token"],
            expires_at=None if self.save_count else _expired_at(),
        )

    def save(self, token: GoogleToken | GraphToken) -> None:
        replacement = dict(self.data)
        replacement["token"] = {
            "access_token": token.access_token,
            "refresh_token": token.refresh_token,
            "expires_at": token.expires_at.isoformat() if token.expires_at else None,
        }
        descriptor, name = tempfile.mkstemp(
            prefix=".drivefs-live-", suffix=".tmp", dir=self.path.parent
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as writer:
                json.dump(replacement, writer, indent=2)
                writer.write("\n")
                writer.flush()
                os.fsync(writer.fileno())
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)
        self.data = replacement
        self.save_count += 1


def _expired_at() -> datetime:
    return datetime.now(timezone.utc) - timedelta(minutes=1)


def _storage(config: PrivateConfig) -> Any:
    if config.provider == "gdrive":
        return GoogleDriveStorage(
            root_id=config.root_id,
            auth=GoogleAuth(
                store=config,
                client_id=config.client_id,
                client_secret=config.data["client_secret"],
            ),
        )
    auth = GraphAuth(
        tenant_id=config.data["tenant_id"],
        client_id=config.client_id,
        client_secret=config.data.get("client_secret"),
        scopes=config.data.get("scopes"),
        store=config,
    )
    if config.provider == "onedrive":
        return OneDriveStorage(
            drive_id=config.data["drive_id"], root_id=config.root_id, auth=auth
        )
    return SharePointStorage(
        site_id=config.data["site_id"],
        drive_id=config.data["drive_id"],
        root_id=config.root_id,
        auth=auth,
    )


def _check(storage: FileStorage, config: PrivateConfig) -> None:
    _ensure(storage.stat("/").kind == "directory", "root is not a directory")
    _ensure(config.save_count >= 1, "token refresh was not persisted")
    scratch = "/drivefs-live-" + uuid4().hex
    _ensure(not storage.exists(scratch), "scratch path already exists")
    print(f"SCRATCH {scratch}")
    try:
        folder = storage.mkdir(scratch)
        _ensure(folder.kind == "directory", "mkdir did not create a directory")
        small = storage.write(scratch + "/small.bin", b"first")
        _ensure(storage.read(small.ref) == b"first", "small read differs")
        _ensure(storage.read_range(small.ref, 1, 3) == b"irs", "small range differs")
        _ensure(
            {item.name for item in storage.list(scratch)} == {"small.bin"},
            "small listing differs",
        )
        replacement = storage.write(scratch + "/small.bin", b"second", overwrite=True)
        _ensure(storage.read(replacement.ref) == b"second", "overwrite differs")
        moved = storage.move(replacement.ref, scratch + "/moved.bin")
        _ensure(
            storage.stat(moved.ref).path == scratch + "/moved.bin",
            "moved reference differs",
        )
        _ensure(not storage.exists(scratch + "/small.bin"), "old path remains")

        payload = bytes(range(256)) * (LARGE_SIZE // 256) + bytes(
            range(LARGE_SIZE % 256)
        )
        large = storage.write(
            scratch + "/large.bin", io.BytesIO(payload), size=len(payload)
        )
        _ensure(large.size == len(payload), "large size differs")
        _ensure(
            storage.read_range(large.ref, 1023, 4097) == payload[1023:5120],
            "large range differs",
        )
        with storage.open_reader(large.ref) as reader:
            downloaded = hashlib.sha256(reader.read()).digest()
        _ensure(downloaded == hashlib.sha256(payload).digest(), "large digest differs")
        _ensure(
            {item.name for item in storage.list(scratch)} == {"moved.bin", "large.bin"},
            "large listing differs",
        )
    finally:
        # The only cleanup target is the UUID directory made by this run.
        if storage.exists(scratch):
            for item in storage.list(scratch):
                storage.delete(item.ref)
            storage.delete(scratch)
    _ensure(not storage.exists(scratch), "scratch cleanup failed")


def main() -> int:
    path = os.environ.get("DRIVEFS_LIVE_CONFIG")
    if not path:
        raise ValueError("DRIVEFS_LIVE_CONFIG is required")
    config = PrivateConfig(Path(path))
    with _storage(config) as storage:
        _check(storage, config)
    print(f"PASS python {config.provider}: refresh, lifecycle, large stream, cleanup")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"FAIL python {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
