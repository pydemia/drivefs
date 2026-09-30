"""Root-relative path rules common to every provider."""

from __future__ import annotations

from .errors import InvalidPathError


def normalize_path(path: str) -> str:
    """Return a canonical absolute path without decoding or case folding."""

    if not isinstance(path, str) or not path:
        raise InvalidPathError("path must be a nonempty string")
    if "\\" in path or "\x00" in path:
        raise InvalidPathError("path contains an invalid character")
    components: list[str] = []
    for component in path.split("/"):
        if component in ("", "."):
            continue
        if component == "..":
            raise InvalidPathError("parent traversal is not allowed")
        components.append(component)
    return "/" + "/".join(components)


def split_parent(path: str) -> tuple[str, str]:
    """Return a canonical parent and leaf name, rejecting the root."""

    normalized = normalize_path(path)
    if normalized == "/":
        raise InvalidPathError("the root has no parent")
    parent, _, name = normalized.rpartition("/")
    return parent or "/", name
