import assert from "node:assert/strict";
import { test } from "node:test";
import { clearTimeout, setTimeout } from "node:timers";

import {
  AmbiguousPathError,
  ConflictError,
  DirectoryNotEmptyError,
  IndeterminateOperationError,
  InvalidArgumentError,
  InvalidUploadSourceError,
  NotFoundError,
  PermissionDeniedError,
  ProviderError,
  ProviderUnavailableError,
  QuotaExceededError,
  UnsupportedOperationError,
} from "@pydemia/drivefs";
import {
  GoogleAuth,
  GoogleDriveStorage,
  MemoryCredentialStore,
} from "@pydemia/drivefs-gdrive";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonResponse(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

class GoogleApiFixture {
  constructor() {
    this.items = new Map([
      [
        "root",
        {
          id: "root",
          name: "root",
          mimeType: FOLDER_MIME,
          parents: ["my-drive"],
          trashed: false,
        },
      ],
    ]);
    this.content = new Map();
    this.sessions = new Map();
    this.nextId = 1;
    this.nextSession = 1;
    this.forcedStatus = null;
    this.forcedReason = "forbidden";
    this.forcedException = false;
    this.failUploadStart = false;
    this.ignoreRange = false;
    this.loseFinalResponse = false;
    this.raceOnCreate = false;
    this.readerCanceled = false;
    this.trackReaderCancel = false;
    this.refreshCount = 0;
    this.cancelCount = 0;
  }

  inject(
    name,
    { parent = "root", kind = "file", data = new Uint8Array() } = {},
  ) {
    const id = `f${this.nextId++}`;
    const mimeType =
      kind === "directory"
        ? FOLDER_MIME
        : kind === "other"
          ? "application/vnd.google-apps.document"
          : "application/octet-stream";
    const item = {
      id,
      name,
      mimeType,
      parents: [parent],
      trashed: false,
      version: "1",
    };
    if (kind === "file") {
      item.size = String(data.length);
      this.content.set(id, data);
    }
    this.items.set(id, item);
    return item;
  }

  async fetch(input, init = {}) {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const path = url.pathname;
    if (url.hostname === "oauth2.googleapis.com") {
      this.refreshCount += 1;
      return jsonResponse(200, {
        access_token: "new-token",
        expires_in: 3600,
      });
    }
    if (
      !["Bearer test-token", "Bearer new-token"].includes(
        headers.get("Authorization"),
      ) &&
      !path.startsWith("/upload/session/")
    ) {
      return jsonResponse(401, { error: { message: "bad token" } });
    }
    if (this.forcedException && path.startsWith("/drive/v3/")) {
      this.forcedException = false;
      throw new Error("fixture timeout");
    }
    if (this.failUploadStart && path.startsWith("/upload/drive/v3/files")) {
      this.failUploadStart = false;
      throw new Error("fixture timeout");
    }
    if (this.forcedStatus !== null && path.startsWith("/drive/v3/")) {
      const status = this.forcedStatus;
      this.forcedStatus = null;
      return jsonResponse(
        status,
        {
          error: { errors: [{ reason: this.forcedReason }] },
        },
        { "Retry-After": "0" },
      );
    }
    if (path.startsWith("/upload/session/")) {
      return this.session(url, method, headers, init.body);
    }
    if (path.startsWith("/upload/drive/v3/files")) {
      if (url.searchParams.get("uploadType") === "media") {
        const id = path.split("/").at(-1);
        const item = this.items.get(id);
        const body = new Uint8Array(init.body ?? new Uint8Array());
        this.content.set(id, body);
        item.size = String(body.length);
        item.version = String(Number(item.version) + 1);
        return jsonResponse(200, item);
      }
      return this.startUpload(url, method, init.body);
    }
    if (path === "/drive/v3/files") {
      if (method === "GET") return this.list(url);
      if (method === "POST") {
        const payload = JSON.parse(init.body);
        const kind = payload.mimeType === FOLDER_MIME ? "directory" : "file";
        return jsonResponse(
          200,
          this.inject(payload.name, {
            parent: payload.parents[0],
            kind,
          }),
        );
      }
    }
    if (path.startsWith("/drive/v3/files/")) {
      const id = path.split("/").at(-1);
      const item = this.items.get(id);
      if (!item || item.trashed) return new Response(null, { status: 404 });
      if (method === "GET" && url.searchParams.get("alt") === "media") {
        return this.media(id, headers);
      }
      if (method === "GET") return jsonResponse(200, item);
      if (method === "PATCH") {
        Object.assign(item, JSON.parse(init.body));
        const parent = url.searchParams.get("addParents");
        if (parent) item.parents = [parent];
        return jsonResponse(200, item);
      }
    }
    throw new Error(`unexpected fixture request: ${method} ${path}`);
  }

  list(url) {
    const query = url.searchParams.get("q");
    const parent = /'([^']+)' in parents/.exec(query)?.[1];
    const name = /name = '((?:\\'|[^'])*)'/
      .exec(query)?.[1]
      ?.replaceAll("\\'", "'");
    const files = [...this.items.values()].filter(
      (item) =>
        item.parents[0] === parent &&
        !item.trashed &&
        (name === undefined || item.name === name),
    );
    const start = Number(url.searchParams.get("pageToken") ?? 0);
    const next = start + 2 < files.length ? String(start + 2) : null;
    return jsonResponse(200, {
      files: files.slice(start, start + 2),
      nextPageToken: next,
    });
  }

  media(id, headers) {
    const data = this.content.get(id);
    const range = headers.get("Range");
    if (range && !this.ignoreRange) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      assert.ok(match);
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), data.length - 1);
      if (start >= data.length) return new Response(null, { status: 416 });
      return new Response(data.slice(start, end + 1), {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/${data.length}` },
      });
    }
    if (this.trackReaderCancel) {
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(data);
          },
          cancel: () => {
            this.readerCanceled = true;
          },
        }),
      );
    }
    return new Response(data);
  }

  startUpload(url, method, body) {
    assert.equal(url.searchParams.get("uploadType"), "resumable");
    const id = String(this.nextSession++);
    const itemId = method === "PATCH" ? url.pathname.split("/").at(-1) : null;
    this.sessions.set(id, {
      itemId,
      metadata: JSON.parse(body),
      content: new Uint8Array(),
      completed: null,
    });
    return new Response(null, {
      status: 200,
      headers: { Location: `https://www.googleapis.com/upload/session/${id}` },
    });
  }

  session(url, method, headers, body) {
    const id = url.pathname.split("/").at(-1);
    const session = this.sessions.get(id);
    if (method === "DELETE") {
      this.cancelCount += 1;
      return new Response(null, { status: 204 });
    }
    assert.equal(method, "PUT");
    const range = headers.get("Content-Range");
    const bytes = new Uint8Array(body ?? new Uint8Array());
    if (range.startsWith("bytes */") && !bytes.length) {
      if (session.completed) return jsonResponse(200, session.completed);
      const length = session.content.length;
      return new Response(null, {
        status: 308,
        headers: length ? { Range: `bytes=0-${length - 1}` } : {},
      });
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = Number(match[3]);
    assert.equal(start, session.content.length);
    assert.equal(end - start + 1, bytes.length);
    const combined = new Uint8Array(session.content.length + bytes.length);
    combined.set(session.content);
    combined.set(bytes, session.content.length);
    session.content = combined;
    if (combined.length < total) {
      return new Response(null, {
        status: 308,
        headers: { Range: `bytes=0-${combined.length - 1}` },
      });
    }
    let item;
    if (session.itemId === null) {
      item = this.inject(session.metadata.name, {
        parent: session.metadata.parents[0],
        data: combined,
      });
      if (this.raceOnCreate) {
        this.raceOnCreate = false;
        this.inject(session.metadata.name, {
          parent: session.metadata.parents[0],
        });
      }
    } else {
      item = this.items.get(session.itemId);
      this.content.set(item.id, combined);
      item.size = String(combined.length);
      item.version = String(Number(item.version) + 1);
    }
    session.completed = item;
    if (this.loseFinalResponse) {
      this.loseFinalResponse = false;
      return new Response(null, { status: 503 });
    }
    return jsonResponse(200, item);
  }
}

function setup() {
  const api = new GoogleApiFixture();
  const fetcher = api.fetch.bind(api);
  const store = new MemoryCredentialStore({ access_token: "test-token" });
  const auth = new GoogleAuth({ store });
  const storage = new GoogleDriveStorage({
    rootId: "root",
    auth,
    fetch: fetcher,
  });
  return { api, fetcher, store, storage };
}

async function collect(iterable) {
  const result = [];
  for await (const item of iterable) result.push(item);
  return result;
}

test("Google public API lifecycle and streaming", async () => {
  const { api, storage } = setup();
  const folder = await storage.mkdir("/reports");
  assert.equal(folder.kind, "directory");
  const data = encoder.encode("ab".repeat(2 * 1024 * 1024 + 3));
  const entry = await storage.write("/reports/data.bin", stream(data), {
    size: data.length,
  });
  assert.equal(entry.size, data.length);
  assert.equal(
    decoder.decode(await storage.read_range(entry.ref, 1, 4)),
    "baba",
  );
  await assert.rejects(
    storage.read_range(entry.ref, Number.MAX_SAFE_INTEGER, 2),
    InvalidArgumentError,
  );
  assert.equal(
    (await storage.read_range(entry.ref, data.length + 1, 4)).length,
    0,
  );
  assert.deepEqual(await storage.read(entry.ref), data);
  api.trackReaderCancel = true;
  for await (const chunk of storage.open_reader(entry.ref)) {
    assert.ok(chunk.length > 0);
    break;
  }
  assert.equal(api.readerCanceled, true);
  const moved = await storage.move(entry.ref, "/reports/new.bin");
  assert.equal((await storage.stat(entry.ref)).path, moved.path);
  assert.equal((await collect(storage.list(folder.ref))).length, 1);
  await assert.rejects(storage.delete(folder.ref), DirectoryNotEmptyError);
  await storage.delete(entry.ref);
  assert.equal(await storage.exists(moved.path), false);
  await storage.delete(folder.ref);
});

test("Google duplicates, native items, outside refs, and range handling", async () => {
  const { api, storage } = setup();
  const first = api.inject("same", { data: encoder.encode("one") });
  api.inject("same", { data: encoder.encode("two") });
  assert.equal((await collect(storage.list("/"))).length, 2);
  await assert.rejects(storage.stat("/same"), AmbiguousPathError);
  const ref = (await collect(storage.list("/"))).find(
    (entry) => entry.id === first.id,
  ).ref;
  assert.equal(decoder.decode(await storage.read(ref)), "one");
  api.inject("native", { kind: "other" });
  assert.equal((await storage.stat("/native")).kind, "other");
  api.ignoreRange = true;
  await assert.rejects(storage.read_range(ref, 1, 2), ProviderError);
  first.parents = ["outside"];
  await assert.rejects(storage.stat(ref), NotFoundError);
});

test("Google upload size, empty file, replace, and uncertain completion", async () => {
  const { api, storage } = setup();
  await assert.rejects(
    storage.write("/missing", stream(encoder.encode("a"))),
    InvalidUploadSourceError,
  );
  assert.equal(api.nextSession, 1);
  await assert.rejects(
    storage.write("/bad", stream(encoder.encode("abc")), { size: 2 }),
    InvalidUploadSourceError,
  );
  assert.equal(api.cancelCount, 1);
  await assert.rejects(
    storage.write("/short", stream(encoder.encode("a")), { size: 2 }),
    InvalidUploadSourceError,
  );
  assert.equal(api.cancelCount, 2);
  const empty = await storage.write("/empty", new Uint8Array());
  assert.equal(empty.size, 0);
  api.loseFinalResponse = true;
  const entry = await storage.write("/recovered", encoder.encode("ok"));
  assert.equal(decoder.decode(await storage.read(entry.ref)), "ok");
  const replaced = await storage.write("/recovered", encoder.encode("new"), {
    overwrite: true,
  });
  assert.equal(replaced.id, entry.id);
  assert.equal(replaced.version, "2");
  await assert.rejects(
    storage.write("/recovered", encoder.encode("x"), {
      overwrite: true,
      expected_version: "1",
    }),
    UnsupportedOperationError,
  );
});

test("Google creation race and root validation", async () => {
  const { api, storage } = setup();
  api.raceOnCreate = true;
  await assert.rejects(
    storage.write("/race", encoder.encode("a")),
    (error) => error instanceof ConflictError && error.item_ids.length === 2,
  );
  api.items.get("root").driveId = "shared-drive";
  await assert.rejects(storage.stat("/"), NotFoundError);
});

test("Google HTTP errors and OAuth refresh", async () => {
  const { api, fetcher, storage } = setup();
  api.forcedStatus = 403;
  await assert.rejects(storage.exists("/missing"), PermissionDeniedError);
  api.forcedStatus = 403;
  api.forcedReason = "storageQuotaExceeded";
  await assert.rejects(storage.stat("/"), QuotaExceededError);
  api.forcedStatus = 429;
  assert.equal((await storage.stat("/")).kind, "directory");
  api.forcedStatus = 503;
  assert.equal((await storage.stat("/")).kind, "directory");
  for (const status of [409, 412]) {
    api.forcedStatus = status;
    await assert.rejects(storage.stat("/"), ConflictError);
  }
  api.forcedException = true;
  await assert.rejects(storage.stat("/"), ProviderUnavailableError);
  api.failUploadStart = true;
  await assert.rejects(
    storage.write("/unknown", encoder.encode("x")),
    IndeterminateOperationError,
  );
  const store = new MemoryCredentialStore({
    access_token: "test-token",
    refresh_token: "refresh-token",
    expires_at: Date.now() - 60_000,
  });
  const auth = new GoogleAuth({
    store,
    client_id: "client",
    client_secret: "secret",
  });
  const refreshed = new GoogleDriveStorage({
    rootId: "root",
    auth,
    fetch: fetcher,
  });
  assert.equal((await refreshed.stat("/")).kind, "directory");
  assert.equal(api.refreshCount, 1);
  assert.equal(store.load().access_token, "new-token");
  const retryStore = new MemoryCredentialStore({
    access_token: "test-token",
    refresh_token: "refresh-token",
  });
  const retryAuth = new GoogleAuth({
    store: retryStore,
    client_id: "client",
    client_secret: "secret",
  });
  const retry = new GoogleDriveStorage({
    rootId: "root",
    auth: retryAuth,
    fetch: fetcher,
  });
  api.forcedStatus = 401;
  assert.equal((await retry.stat("/")).path, "/");
  assert.equal(api.refreshCount, 2);
});

test("Google refresh is serialized and save failures are safe", async () => {
  const { api, fetcher } = setup();
  const expired = {
    access_token: "test-token",
    refresh_token: "refresh-token",
    expires_at: Date.now() - 60_000,
  };
  const store = new MemoryCredentialStore(expired);
  const auth = new GoogleAuth({
    store,
    client_id: "client",
    client_secret: "secret",
  });
  const tokens = await Promise.all(
    Array.from({ length: 5 }, () => auth.access_token(fetcher)),
  );
  assert.deepEqual(tokens, Array(5).fill("new-token"));
  assert.equal(api.refreshCount, 1);
  const failing = new GoogleAuth({
    store: {
      load: () => expired,
      save: () => {
        throw new Error("secret should not appear");
      },
    },
    client_id: "client",
    client_secret: "secret",
  });
  await assert.rejects(
    failing.access_token(fetcher),
    (error) =>
      error.name === "AuthenticationError" && !error.message.includes("secret"),
  );
});

test("Google request deadline bounds a stalled transport", async () => {
  const auth = new GoogleAuth({
    store: new MemoryCredentialStore({ access_token: "test-token" }),
  });
  let aborted = false;
  const fetcher = (_url, init) =>
    new Promise((resolve, reject) => {
      assert.ok(init.signal);
      const timer = setTimeout(
        () => resolve(new Response(null, { status: 204 })),
        1_000,
      );
      init.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          clearTimeout(timer);
          reject(init.signal.reason);
        },
        { once: true },
      );
    });
  const storage = new GoogleDriveStorage({
    rootId: "root",
    auth,
    fetch: fetcher,
    timeoutMs: 20,
  });
  await assert.rejects(storage.stat("/"), ProviderUnavailableError);
  assert.equal(aborted, true);
  assert.throws(
    () => new GoogleDriveStorage({ rootId: "root", auth, timeoutMs: 0 }),
    InvalidArgumentError,
  );
  assert.throws(
    () =>
      new GoogleDriveStorage({
        rootId: "root",
        auth,
        timeoutMs: 2_147_483_648,
      }),
    InvalidArgumentError,
  );
});

test("Google body failures distinguish reads from uncertain writes", async () => {
  const { api, store } = setup();
  let failRead = true;
  let emptyMetadata = false;
  const fetcher = async (url, init) => {
    const response = await api.fetch(url, init);
    if (emptyMetadata && init.method === "POST") {
      response.json = async () => ({});
    } else if (
      (failRead && init.method === "GET") ||
      (!failRead && init.method === "POST")
    ) {
      response.json = async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      };
    }
    return response;
  };
  const storage = new GoogleDriveStorage({
    rootId: "root",
    auth: new GoogleAuth({ store }),
    fetch: fetcher,
  });
  await assert.rejects(storage.stat("/"), ProviderUnavailableError);
  failRead = false;
  await assert.rejects(storage.mkdir("/late"), IndeterminateOperationError);
  emptyMetadata = true;
  await assert.rejects(
    storage.mkdir("/empty-metadata"),
    IndeterminateOperationError,
  );
});

async function* stream(bytes) {
  yield bytes;
}
