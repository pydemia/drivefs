"""Contract checks for the optional read-only fsspec view."""

from __future__ import annotations

import unittest

from drivefs import ConflictError, ProviderUnavailableError, UnsupportedOperationError
from drivefs_fsspec import DriveFSFileSystem
from fake_storage import FakeStorage


class FsspecAdapterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.storage = FakeStorage()
        self.storage.mkdir("/reports")
        self.storage.write("/reports/data.bin", b"abcdefghij")
        self.fs = DriveFSFileSystem(storage=self.storage)

    def test_info_list_and_exists(self) -> None:
        self.assertTrue(self.fs.exists("/reports/data.bin"))
        self.assertFalse(self.fs.exists("/missing"))
        self.assertEqual(self.fs.info("/reports/data.bin")["size"], 10)
        self.assertEqual(self.fs.info("/")["type"], "directory")
        self.assertEqual(self.fs.ls("/reports", detail=False), ["/reports/data.bin"])
        self.assertEqual(self.fs.ls("drivefs:///reports")[0]["type"], "file")
        with self.assertRaises(FileNotFoundError):
            self.fs.info("/missing")
        with self.assertRaises(FileNotFoundError):
            self.fs.ls("/missing")

    def test_range_seek_and_read(self) -> None:
        with self.fs.open("/reports/data.bin", "rb", block_size=3) as reader:
            self.assertEqual(reader.read(2), b"ab")
            self.assertEqual(reader.seek(5), 5)
            self.assertEqual(reader.read(3), b"fgh")
            self.assertEqual(reader.seek(-2, 2), 8)
            self.assertEqual(reader.read(), b"ij")
        with self.fs.open("/reports/data.bin", "rb") as reader:
            self.assertEqual(reader.read(), b"abcdefghij")
        with self.fs.open("/reports/data.bin", "rt", encoding="utf-8") as reader:
            self.assertEqual(reader.read(), "abcdefghij")

    def test_range_seek_detects_visible_version_change(self) -> None:
        with self.fs.open("/reports/data.bin", "rb", block_size=2) as reader:
            self.assertEqual(reader.read(2), b"ab")
            self.storage.write("/reports/data.bin", b"klmnopqrst", overwrite=True)
            reader.seek(6)
            with self.assertRaises(ConflictError):
                reader.read(2)

    def test_mutation_is_explicitly_rejected(self) -> None:
        with self.assertRaises(UnsupportedOperationError):
            self.fs.open("/reports/new.bin", "wb")
        for action in (
            lambda: self.fs.mkdir("/new"),
            lambda: self.fs.makedirs("/new/child"),
            lambda: self.fs.rm("/reports/data.bin"),
            lambda: self.fs.mv("/reports/data.bin", "/other.bin"),
            lambda: self.fs.pipe_file("/new.bin", b"x"),
            lambda: self.fs.touch("/new.bin"),
        ):
            with self.assertRaises(UnsupportedOperationError):
                action()
        self.assertTrue(self.storage.exists("/reports/data.bin"))

    def test_exists_propagates_provider_failure(self) -> None:
        self.storage.fail_next_stat(ProviderUnavailableError("unavailable"))
        with self.assertRaises(ProviderUnavailableError):
            self.fs.exists("/reports/data.bin")


if __name__ == "__main__":
    unittest.main()
