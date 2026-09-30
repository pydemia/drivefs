"""Stable errors shared by storage implementations."""

from __future__ import annotations


class StorageError(Exception):
    """An operation failed without exposing credentials or request URLs."""

    def __init__(
        self,
        message: str,
        *,
        operation: str | None = None,
        target: str | None = None,
        provider: str | None = None,
        retry_after: float | None = None,
        item_ids: tuple[str, ...] = (),
    ) -> None:
        super().__init__(message)
        self.operation = operation
        self.target = target
        self.provider = provider
        self.retry_after = retry_after
        self.item_ids = item_ids


class NotFoundError(StorageError):
    """An item or its parent does not exist in the selected root."""


class AlreadyExistsError(StorageError):
    """A destination name already exists."""


class AmbiguousPathError(StorageError):
    """Several siblings match one path component."""


class InvalidPathError(StorageError):
    """A path or provider name is invalid."""


class InvalidArgumentError(StorageError):
    """An operation option or numeric argument is invalid."""


class InvalidUploadSourceError(StorageError):
    """The upload source lacks a size or supplied the wrong byte count."""


class NotDirectoryError(StorageError):
    """A directory was required."""


class IsDirectoryError(StorageError):
    """A file was required."""


class DirectoryNotEmptyError(StorageError):
    """Only empty directories may be deleted."""


class AuthenticationError(StorageError):
    """Authentication or credential refresh failed."""


class PermissionDeniedError(StorageError):
    """The authenticated identity lacks permission."""


class RateLimitError(StorageError):
    """The provider is throttling requests."""


class QuotaExceededError(StorageError):
    """The account has insufficient storage quota."""


class ConflictError(StorageError):
    """A version or concurrent change conflicted."""


class IndeterminateOperationError(StorageError):
    """A mutation may have succeeded, but its result is unknown."""


class UnsupportedOperationError(StorageError):
    """The selected storage does not support this operation."""


class ProviderUnavailableError(StorageError):
    """A provider is temporarily unavailable."""


class ProviderError(StorageError):
    """Another provider error occurred."""
