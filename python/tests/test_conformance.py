"""Run the language-neutral v1 cases against the Python fake."""

from __future__ import annotations

import json
import unittest
from io import BytesIO
from pathlib import Path
from typing import Any

import drivefs
from fake_storage import FakeStorage

CASES = json.loads(
    (Path(__file__).parents[2] / "conformance/cases/v1.json").read_text(
        encoding="utf-8"
    )
)


class ConformanceTest(unittest.TestCase):
    def test_version(self) -> None:
        self.assertEqual(CASES["schema_version"], 1)

    def test_paths(self) -> None:
        for case in CASES["path"]:
            with self.subTest(case=case["id"]):
                if "error" in case:
                    error = getattr(drivefs, case["error"])
                    with self.assertRaises(error):
                        drivefs.normalize_path(case["input"])
                else:
                    self.assertEqual(
                        drivefs.normalize_path(case["input"]), case["expect"]
                    )

    def test_storage(self) -> None:
        for case in CASES["storage"]:
            with self.subTest(case=case["id"]):
                self._run_scenario(case)

    def _run_scenario(self, case: dict[str, Any]) -> None:
        storage = FakeStorage()
        refs: dict[str, drivefs.ItemRef] = {}
        for step in case["steps"]:
            with self.subTest(step=step):
                if "error" in step:
                    error = getattr(drivefs, step["error"])
                    with self.assertRaises(error):
                        self._execute(storage, refs, step)
                else:
                    result = self._execute(storage, refs, step)
                    if "save" in step:
                        refs[step["save"]] = result.ref
                    for key, expected in step.get("expect", {}).items():
                        actual = self._result_field(result, key)
                        self.assertEqual(actual, expected)

    @staticmethod
    def _result_field(result: Any, key: str) -> Any:
        if key == "bytes":
            return result.decode("utf-8")
        if key == "exists":
            return result
        if key == "count":
            return len(result)
        if key == "closed":
            return result
        return getattr(result, key)

    @staticmethod
    def _execute(
        storage: FakeStorage,
        refs: dict[str, drivefs.ItemRef],
        step: dict[str, Any],
    ) -> Any:
        op = step["op"]
        target = refs[step["ref"]] if "ref" in step else step.get("path")
        if op == "inject":
            return storage.inject(
                step["path"],
                kind=step.get("kind", "file"),
                content=step.get("data", "").encode("utf-8"),
            )
        if op == "inject_foreign":
            return FakeStorage().inject(step["path"])
        if op == "detach":
            return storage.detach(target)
        if op == "fail_stat":
            error = getattr(drivefs, step["error_type"])
            return storage.fail_next_stat(error("fixture failure"))
        if op == "fail_list_after_page":
            error = getattr(drivefs, step["error_type"])
            return storage.fail_list_after_page(error("fixture failure"))
        if op == "write":
            data = step["data"].encode("utf-8")
            source = BytesIO(data) if step.get("stream") else data
            return storage.write(
                step["path"],
                source,
                overwrite=step.get("overwrite", False),
                expected_version=step.get("expected_version"),
                size=step.get("size"),
            )
        if op == "read_range":
            return storage.read_range(target, step["offset"], step["length"])
        if op == "open_reader":
            with storage.open_reader(target) as reader:
                return reader.read()
        if op == "open_reader_break":
            with storage.open_reader(target) as reader:
                reader.read(1)
            return reader.closed
        if op == "move":
            return storage.move(target, step["destination"])
        if op == "list":
            return list(storage.list(target))
        return getattr(storage, op)(target)


if __name__ == "__main__":
    unittest.main()
