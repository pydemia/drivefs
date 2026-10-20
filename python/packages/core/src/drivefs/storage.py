"""Synchronous high-level interface implemented by provider plugins."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from contextlib import AbstractContextManager
from typing import BinaryIO

from .errors import NotFoundError
from .model import ItemRef, StorageCapabilities, StorageEntry

StorageTarget = str | ItemRef
UploadSource = bytes | BinaryIO


class FileStorage(ABC):
    @property
    @abstractmethod
    def capabilities(self) -> StorageCapabilities:
        """Report verified optional storage capabilities."""

    @abstractmethod
    def stat(self, target: StorageTarget) -> StorageEntry:
        """Read current metadata for a path or instance-scoped reference."""

    def exists(self, path: str) -> bool:
        """Return false only when a path does not exist."""

        try:
            self.stat(path)
        except NotFoundError:
            return False
        return True

    @abstractmethod
    def list(self, target: StorageTarget) -> Iterator[StorageEntry]:
        """Iterate immediate children without requiring full materialization."""

    @abstractmethod
    def read(self, target: StorageTarget) -> bytes:
        """Read an entire binary file into memory."""

    @abstractmethod
    def open_reader(self, target: StorageTarget) -> AbstractContextManager[BinaryIO]:
        """Open a closeable sequential binary reader."""

    @abstractmethod
    def read_range(self, target: StorageTarget, offset: int, length: int) -> bytes:
        """Read up to length bytes starting at offset."""

    @abstractmethod
    def write(
        self,
        path: str,
        data: UploadSource,
        *,
        overwrite: bool = False,
        expected_version: str | None = None,
        size: int | None = None,
    ) -> StorageEntry:
        """Create a file or explicitly replace an existing file."""

    @abstractmethod
    def mkdir(self, path: str) -> StorageEntry:
        """Create one directory beneath an existing parent."""

    @abstractmethod
    def move(self, target: StorageTarget, destination: str) -> StorageEntry:
        """Move one item to an unused path within this storage root."""

    @abstractmethod
    def delete(self, target: StorageTarget) -> None:
        """Move a file or empty directory to the provider trash."""
