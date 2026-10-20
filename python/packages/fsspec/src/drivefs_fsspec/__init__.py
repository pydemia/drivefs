"""Read-only fsspec adapter over a drivefs storage instance."""

from .filesystem import DriveFSFileSystem

__all__ = ["DriveFSFileSystem"]
