import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import * as drivefs from "@pydemia/drivefs";

import { FakeStorage } from "./fake-storage.mjs";

const cases = JSON.parse(
  await readFile(new URL("../../conformance/cases/v1.json", import.meta.url)),
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("conformance schema version", () => {
  assert.equal(cases.schema_version, 1);
});

for (const item of cases.path) {
  test(item.id, () => {
    if (item.error) {
      assert.throws(
        () => drivefs.normalize_path(item.input),
        drivefs[item.error],
      );
    } else {
      assert.equal(drivefs.normalize_path(item.input), item.expect);
    }
  });
}

for (const scenario of cases.storage) {
  test(scenario.id, async () => {
    const storage = new FakeStorage();
    const refs = new Map();
    for (const step of scenario.steps) {
      let result;
      if (step.error) {
        await assert.rejects(
          async () => execute(storage, refs, step),
          drivefs[step.error],
          `${scenario.id}: ${JSON.stringify(step)}`,
        );
        continue;
      }
      result = await execute(storage, refs, step);
      if (step.save) refs.set(step.save, result.ref);
      for (const [field, expected] of Object.entries(step.expect ?? {})) {
        const actual = resultField(result, field);
        assert.equal(actual, expected, `${scenario.id}: ${field}`);
      }
    }
  });
}

function resultField(result, field) {
  if (field === "bytes") return decoder.decode(result);
  if (field === "exists") return result;
  if (field === "count") return result.length;
  if (field === "closed") return result;
  return result[field];
}

async function execute(storage, refs, step) {
  const target = step.ref ? refs.get(step.ref) : step.path;
  switch (step.op) {
    case "inject":
      return storage.inject(step.path, {
        kind: step.kind ?? "file",
        content: encoder.encode((step.data ?? "").repeat(step.repeat ?? 1)),
      });
    case "inject_foreign":
      return new FakeStorage().inject(step.path);
    case "detach":
      return storage.detach(target);
    case "fail_stat":
      return storage.fail_next_stat(
        new drivefs[step.error_type]("fixture failure"),
      );
    case "fail_list_after_page":
      return storage.fail_list_after_page(
        new drivefs[step.error_type]("fixture failure"),
      );
    case "write": {
      const bytes = encoder.encode(step.data.repeat(step.repeat ?? 1));
      const source = step.stream ? stream(bytes) : bytes;
      return storage.write(step.path, source, {
        overwrite: step.overwrite ?? false,
        expected_version: step.expected_version ?? null,
        size: step.size ?? null,
      });
    }
    case "read_range":
      return storage.read_range(target, step.offset, step.length);
    case "open_reader": {
      const chunks = [];
      for await (const chunk of storage.open_reader(target)) {
        chunks.push(chunk);
      }
      return concat(chunks);
    }
    case "open_reader_break": {
      const before = storage.closed_readers;
      for await (const _chunk of storage.open_reader(target)) {
        assert.ok(_chunk instanceof Uint8Array);
        break;
      }
      return storage.closed_readers === before + 1;
    }
    case "list": {
      const entries = [];
      for await (const entry of storage.list(target)) entries.push(entry);
      return entries;
    }
    case "move":
      return storage.move(target, step.destination);
    default:
      return storage[step.op](target);
  }
}

async function* stream(bytes) {
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
    yield bytes.subarray(offset, offset + 64 * 1024);
  }
}

function concat(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
