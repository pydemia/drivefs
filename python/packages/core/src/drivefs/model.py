"""Provider-neutral metadata and instance-scoped references."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4

from .errors import NotFoundError

EntryKind = Literal["file", "directory", "other"]


@dataclass(frozen=True, slots=True, repr=False)
class ItemRef:
    """An opaque reference valid only on its creating storage instance."""

    _owner: UUID
    _native_id: str
    _container_id: str | None = None

    def __repr__(self) -> str:
        return "ItemRef(<opaque>)"


@dataclass(frozen=True, slots=True)
class StorageEntry:
    ref: ItemRef
    id: str
    path: str
    name: str
    kind: EntryKind
    size: int | None = None
    modified_at: datetime | None = None
    mime_type: str | None = None
    version: str | None = None


@dataclass(frozen=True, slots=True)
class StorageCapabilities:
    conditional_replace: bool = False


@dataclass(slots=True)
class RefScope:
    """Provider SPI for creating and validating instance-owned references."""

    owner: UUID = field(default_factory=uuid4)

    def make(self, native_id: str, container_id: str | None = None) -> ItemRef:
        return ItemRef(self.owner, native_id, container_id)

    def resolve(self, ref: ItemRef) -> tuple[str, str | None]:
        if not isinstance(ref, ItemRef) or ref._owner != self.owner:
            raise NotFoundError("reference belongs to another storage")
        return ref._native_id, ref._container_id
