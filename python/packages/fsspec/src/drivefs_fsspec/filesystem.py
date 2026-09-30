"""An optional read-only fsspec view of a caller-owned FileStorage."""

from __future__ import annotations

from io import BufferedReader, RawIOBase
from typing import Any, BinaryIO

from drivefs import (
    ConflictError,
    FileStorage,
    NotFoundError,
    StorageEntry,
    UnsupportedOperationError,
    normalize_path,
)
from fsspec.spec import AbstractFileSystem  # type: ignore[import-untyped]


class _RangeReader(RawIOBase):
    """Seekable reader that requests only the selected byte ranges."""

    def __init__(
        self, storage: FileStorage, path: str, size: int | None, version: str | None
    ) -> None:
        super().__init__()
        self._storage = storage
        self._path = path
        self._size = size
        self._version = version
        self._position = 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._position

    def seek(self, offset: int, whence: int = 0) -> int:
        if self.closed:
            raise ValueError("reader is closed")
        if whence == 0:
            position = offset
        elif whence == 1:
            position = self._position + offset
        elif whence == 2:
            if self._size is None:
                raise UnsupportedOperationError("file size is required for SEEK_END")
            position = self._size + offset
        else:
            raise ValueError("invalid whence")
        if position < 0:
            raise ValueError("negative seek position")
        self._position = position
        return position

    def readinto(self, buffer: Any) -> int:
        if self.closed:
            raise ValueError("reader is closed")
        view = memoryview(buffer)
        if not view:
            return 0
        if self._size is not None and self._position >= self._size:
            return 0
        count = len(view)
        if self._size is not None:
            count = min(count, self._size - self._position)
        if self._version is not None:
            current = self._storage.stat(self._path).version
            if current is not None and current != self._version:
                raise ConflictError("file changed during range reads")
        data = self._storage.read_range(self._path, self._position, count)
        if len(data) > count:
            raise ValueError("storage returned more bytes than requested")
        view[: len(data)] = data
        self._position += len(data)
        return len(data)


class DriveFSFileSystem(AbstractFileSystem):  # type: ignore[misc]
    """Read-only fsspec bridge bound to one concrete storage instance."""

    protocol = "drivefs"
    root_marker = "/"
    cachable = False

    def __init__(self, storage: FileStorage, **kwargs: Any) -> None:
        if not isinstance(storage, FileStorage):
            raise TypeError("storage must implement FileStorage")
        super().__init__(**kwargs)
        self.storage = storage

    @classmethod
    def _strip_protocol(cls, path: str) -> str:
        if path.startswith("drivefs://"):
            path = path[len("drivefs://") :]
        return normalize_path(path)

    @staticmethod
    def _info(entry: StorageEntry) -> dict[str, Any]:
        return {
            "name": entry.path,
            "size": entry.size,
            "type": entry.kind,
            "mtime": entry.modified_at,
            "id": entry.id,
            "mime_type": entry.mime_type,
            "version": entry.version,
        }

    def info(self, path: str, **kwargs: Any) -> dict[str, Any]:
        del kwargs
        normalized = self._strip_protocol(path)
        try:
            return self._info(self.storage.stat(normalized))
        except NotFoundError:
            raise FileNotFoundError(normalized) from None

    def ls(self, path: str, detail: bool = True, **kwargs: Any) -> list[Any]:
        del kwargs
        normalized = self._strip_protocol(path)
        try:
            entries = [self._info(entry) for entry in self.storage.list(normalized)]
        except NotFoundError:
            raise FileNotFoundError(normalized) from None
        return entries if detail else [entry["name"] for entry in entries]

    def exists(self, path: str, **kwargs: Any) -> bool:
        del kwargs
        return self.storage.exists(self._strip_protocol(path))

    def _open(
        self,
        path: str,
        mode: str = "rb",
        block_size: int | None = None,
        **kwargs: Any,
    ) -> BinaryIO:
        del kwargs
        if mode != "rb":
            raise UnsupportedOperationError("fsspec adapter supports rb only")
        normalized = self._strip_protocol(path)
        try:
            entry = self.storage.stat(normalized)
        except NotFoundError:
            raise FileNotFoundError(normalized) from None
        if entry.kind != "file":
            raise UnsupportedOperationError("only binary files can be opened")
        buffer_size = block_size or 256 * 1024
        if buffer_size <= 0:
            raise ValueError("block_size must be positive")
        return BufferedReader(
            _RangeReader(self.storage, normalized, entry.size, entry.version),
            buffer_size,
        )

    @staticmethod
    def _read_only() -> None:
        raise UnsupportedOperationError("fsspec adapter is read-only")

    def mkdir(self, path: str, create_parents: bool = True, **kwargs: Any) -> None:
        self._read_only()

    def makedirs(self, path: str, exist_ok: bool = False) -> None:
        self._read_only()

    def rmdir(self, path: str) -> None:
        self._read_only()

    def rm(
        self, path: str, recursive: bool = False, maxdepth: int | None = None
    ) -> None:
        self._read_only()

    def mv(
        self, path1: str, path2: str, recursive: bool = False, **kwargs: Any
    ) -> None:
        self._read_only()

    def cp_file(self, path1: str, path2: str, **kwargs: Any) -> None:
        self._read_only()

    def pipe_file(
        self, path: str, value: bytes, mode: str = "overwrite", **kwargs: Any
    ) -> None:
        self._read_only()

    def touch(self, path: str, truncate: bool = True, **kwargs: Any) -> None:
        self._read_only()

    def put_file(
        self, lpath: str, rpath: str, callback: Any = None, **kwargs: Any
    ) -> None:
        self._read_only()
