"""Deterministic storage used only by the conformance suite."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from io import BytesIO
from typing import BinaryIO
from uuid import uuid4

from drivefs import (
    AlreadyExistsError,
    AmbiguousPathError,
    ConflictError,
    DirectoryNotEmptyError,
    FileStorage,
    InvalidArgumentError,
    InvalidPathError,
    InvalidUploadSourceError,
    IsDirectoryError,
    ItemRef,
    NotDirectoryError,
    NotFoundError,
    RefScope,
    StorageCapabilities,
    StorageEntry,
    StorageTarget,
    UnsupportedOperationError,
    UploadSource,
    normalize_path,
    split_parent,
)


@dataclass(slots=True)
class _Node:
    id: str
    parent: str | None
    name: str
    kind: str
    content: bytes = b""
    version: int = 1
    trashed: bool = False


class FakeStorage(FileStorage):
    """A fake with duplicates, movable IDs, trash, and paged iteration."""

    def __init__(self, *, page_size: int = 2) -> None:
        self._scope = RefScope()
        self._nodes: dict[str, _Node] = {"root": _Node("root", None, "", "directory")}
        self._page_size = page_size
        self._stat_failure: Exception | None = None
        self._list_failure_after_page: Exception | None = None

    @property
    def capabilities(self) -> StorageCapabilities:
        return StorageCapabilities(conditional_replace=True)

    def fail_next_stat(self, error: Exception) -> None:
        self._stat_failure = error

    def fail_list_after_page(self, error: Exception) -> None:
        self._list_failure_after_page = error

    def inject(
        self,
        path: str,
        *,
        kind: str = "file",
        content: bytes = b"",
    ) -> StorageEntry:
        """Insert an item even if its sibling already has the same name."""

        parent_path, name = split_parent(path)
        parent = self._resolve(parent_path)
        self._require_directory(parent)
        node = _Node(uuid4().hex, parent.id, name, kind, content)
        self._nodes[node.id] = node
        return self._entry(node)

    def detach(self, ref: ItemRef) -> None:
        """Model a provider-side move outside the configured root."""

        native_id, _ = self._scope.resolve(ref)
        self._nodes[native_id].parent = None

    def _children(self, parent_id: str) -> list[_Node]:
        return [
            node
            for node in self._nodes.values()
            if node.parent == parent_id and not node.trashed
        ]

    def _within_root(self, node: _Node) -> bool:
        seen: set[str] = set()
        while node.id != "root":
            if node.id in seen or node.parent is None or node.trashed:
                return False
            seen.add(node.id)
            node = self._nodes.get(node.parent)  # type: ignore[assignment]
            if node is None:
                return False
        return True

    def _resolve(self, target: StorageTarget) -> _Node:
        if isinstance(target, ItemRef):
            native_id, _ = self._scope.resolve(target)
            node = self._nodes.get(native_id)
            if node is None or not self._within_root(node):
                raise NotFoundError("item is outside this storage root")
            return node
        path = normalize_path(target)
        node = self._nodes["root"]
        if path == "/":
            return node
        for name in path[1:].split("/"):
            self._require_directory(node)
            matches = [child for child in self._children(node.id) if child.name == name]
            if not matches:
                raise NotFoundError("path does not exist", target=path)
            if len(matches) > 1:
                raise AmbiguousPathError(
                    "path matches multiple items",
                    target=path,
                    item_ids=tuple(child.id for child in matches),
                )
            node = matches[0]
        return node

    def _path(self, node: _Node) -> str:
        parts: list[str] = []
        while node.id != "root":
            parts.append(node.name)
            if node.parent is None:
                raise NotFoundError("item is outside this storage root")
            node = self._nodes[node.parent]
        return "/" + "/".join(reversed(parts))

    def _entry(self, node: _Node) -> StorageEntry:
        return StorageEntry(
            ref=self._scope.make(node.id),
            id=node.id,
            path=self._path(node),
            name=node.name,
            kind=node.kind,  # type: ignore[arg-type]
            size=len(node.content) if node.kind == "file" else None,
            version=str(node.version) if node.kind == "file" else None,
        )

    @staticmethod
    def _require_directory(node: _Node) -> None:
        if node.kind != "directory":
            raise NotDirectoryError("item is not a directory")

    @staticmethod
    def _require_file(node: _Node) -> None:
        if node.kind == "directory":
            raise IsDirectoryError("item is a directory")
        if node.kind == "other":
            raise UnsupportedOperationError("item is not a binary file")

    def stat(self, target: StorageTarget) -> StorageEntry:
        if self._stat_failure is not None:
            error = self._stat_failure
            self._stat_failure = None
            raise error
        return self._entry(self._resolve(target))

    def list(self, target: StorageTarget) -> Iterator[StorageEntry]:
        node = self._resolve(target)
        self._require_directory(node)
        children = self._children(node.id)
        for index in range(0, len(children), self._page_size):
            if index and self._list_failure_after_page is not None:
                error = self._list_failure_after_page
                self._list_failure_after_page = None
                raise error
            for child in children[index : index + self._page_size]:
                yield self._entry(child)

    def read(self, target: StorageTarget) -> bytes:
        node = self._resolve(target)
        self._require_file(node)
        return node.content

    def open_reader(self, target: StorageTarget) -> BytesIO:
        return BytesIO(self.read(target))

    def read_range(self, target: StorageTarget, offset: int, length: int) -> bytes:
        if (
            type(offset) is not int
            or type(length) is not int
            or offset < 0
            or length < 0
        ):
            raise InvalidArgumentError("offset and length must be nonnegative integers")
        node = self._resolve(target)
        self._require_file(node)
        return node.content[offset : offset + length]

    @staticmethod
    def _upload_bytes(data: UploadSource, size: int | None) -> bytes:
        if isinstance(data, bytes):
            if size is not None and size != len(data):
                raise InvalidUploadSourceError("byte count differs from size")
            return data
        if type(size) is not int or size < 0:
            raise InvalidUploadSourceError("stream requires a nonnegative size")
        chunks: list[bytes] = []
        count = 0
        reader: BinaryIO = data
        while True:
            chunk = reader.read(64 * 1024)
            if not chunk:
                break
            if not isinstance(chunk, bytes):
                raise InvalidUploadSourceError("stream must return bytes")
            count += len(chunk)
            if count > size:
                raise InvalidUploadSourceError("stream exceeds declared size")
            chunks.append(chunk)
        if count != size:
            raise InvalidUploadSourceError("stream is shorter than size")
        return b"".join(chunks)

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
        parent_path, name = split_parent(path)
        content = self._upload_bytes(data, size)
        parent = self._resolve(parent_path)
        self._require_directory(parent)
        matches = [child for child in self._children(parent.id) if child.name == name]
        if len(matches) > 1:
            raise AmbiguousPathError("destination is ambiguous")
        if matches:
            if not overwrite:
                raise AlreadyExistsError("destination exists")
            node = matches[0]
            self._require_file(node)
            if expected_version is not None and expected_version != str(node.version):
                raise ConflictError("version differs")
            node.content = content
            node.version += 1
            return self._entry(node)
        if expected_version is not None:
            raise NotFoundError("replace target does not exist")
        return self.inject(path, content=content)

    def mkdir(self, path: str) -> StorageEntry:
        parent_path, name = split_parent(path)
        parent = self._resolve(parent_path)
        self._require_directory(parent)
        if any(child.name == name for child in self._children(parent.id)):
            raise AlreadyExistsError("destination exists")
        return self.inject(path, kind="directory")

    def move(self, target: StorageTarget, destination: str) -> StorageEntry:
        node = self._resolve(target)
        if node.id == "root":
            raise UnsupportedOperationError("cannot move the root")
        if node.kind == "other":
            raise UnsupportedOperationError("cannot move this item kind")
        parent_path, name = split_parent(destination)
        parent = self._resolve(parent_path)
        self._require_directory(parent)
        if parent.id == node.id or self._is_descendant(parent, node):
            raise InvalidPathError("cannot move into own descendant")
        if any(child.name == name for child in self._children(parent.id)):
            raise AlreadyExistsError("destination exists")
        node.parent = parent.id
        node.name = name
        return self._entry(node)

    def _is_descendant(self, candidate: _Node, ancestor: _Node) -> bool:
        while candidate.parent is not None:
            if candidate.parent == ancestor.id:
                return True
            candidate = self._nodes[candidate.parent]
        return False

    def delete(self, target: StorageTarget) -> None:
        node = self._resolve(target)
        if node.id == "root":
            raise UnsupportedOperationError("cannot delete the root")
        if node.kind == "other":
            raise UnsupportedOperationError("cannot delete this item kind")
        if node.kind == "directory" and self._children(node.id):
            raise DirectoryNotEmptyError("directory is not empty")
        node.trashed = True
