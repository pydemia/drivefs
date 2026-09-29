import assert from "node:assert/strict";
import { test } from "node:test";
import { clearTimeout, setTimeout } from "node:timers";

import {
  AmbiguousPathError,
  AuthenticationError,
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
  GraphAuth,
  MemoryCredentialStore,
  OneDriveStorage,
  SharePointStorage,
} from "@pydemia/drivefs-microsoft";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonResponse(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

class GraphApiFixture {
  constructor(driveType, siteId = null) {
    this.driveType = driveType;
    this.siteId = siteId;
    this.items = new Map([
      [
        "root",
        {
          id: "root",
          name: "root",
          folder: {},
          parentReference: { id: "drive-root", driveId: "drive" },
          ...(siteId ? { sharepointIds: { siteId } } : {}),
        },
      ],
    ]);
    this.content = new Map();
    this.sessions = new Map();
    this.nextId = 1;
    this.nextSession = 1;
    this.cancelCount = 0;
    this.refreshCount = 0;
    this.forcedStatus = null;
    this.forcedException = false;
    this.ignoreRange = false;
    this.loseFinalResponse = false;
    this.expireSessionAfterCommit = false;
    this.signedAuthorizationSeen = false;
    this.trackReaderCancel = false;
    this.readerCanceled = false;
  }

  inject(
    name,
    { parent = "root", kind = "file", data = new Uint8Array() } = {},
  ) {
    const id = `f${this.nextId++}`;
    const item = {
      id,
      name,
      parentReference: { id: parent, driveId: "drive" },
      size: data.length,
      eTag: '"v1"',
    };
    if (kind === "directory") item.folder = {};
    else if (kind === "file") {
      item.file = { mimeType: "application/octet-stream" };
      this.content.set(id, data);
    } else item.package = {};
    this.items.set(id, item);
    return item;
  }

  async fetch(input, init = {}) {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const path = url.pathname;
    if (url.hostname === "login.microsoftonline.com") {
      this.refreshCount += 1;
      return jsonResponse(200, {
        access_token: "new-token",
        expires_in: 3600,
      });
    }
    if (
      url.hostname === "download.example" ||
      url.hostname === "upload.example"
    ) {
      if (headers.has("Authorization")) this.signedAuthorizationSeen = true;
      return url.hostname === "download.example"
        ? this.download(path, headers)
        : this.session(path, method, headers, init.body);
    }
    if (
      !["Bearer test-token", "Bearer new-token"].includes(
        headers.get("Authorization"),
      )
    ) {
      return new Response(null, { status: 401 });
    }
    if (this.forcedException && path.startsWith("/v1.0/")) {
      this.forcedException = false;
      throw new Error("fixture timeout");
    }
    if (this.forcedStatus !== null && path.startsWith("/v1.0/")) {
      const status = this.forcedStatus;
      this.forcedStatus = null;
      return new Response(null, {
        status,
        headers: { "Retry-After": "0" },
      });
    }
    if (path === "/v1.0/sites/site/drives") {
      return jsonResponse(200, {
        value: [{ id: "drive", driveType: "documentLibrary" }],
      });
    }
    if (path === "/v1.0/drives/drive") {
      return jsonResponse(200, { id: "drive", driveType: this.driveType });
    }
    const base = "/v1.0/drives/drive/items/";
    if (!path.startsWith(base)) {
      throw new Error(`unexpected Graph request: ${method} ${path}`);
    }
    const suffix = decodeURIComponent(path.slice(base.length));
    if (
      suffix.endsWith("/createUploadSession") ||
      suffix.endsWith(":/createUploadSession")
    ) {
      return this.startUpload(suffix);
    }
    if (suffix.endsWith("/children")) {
      const parentId = suffix.slice(0, -"/children".length);
      if (method === "GET") return this.children(parentId, url);
      const payload = JSON.parse(init.body);
      const name = payload.name;
      if (
        [...this.items.values()].some(
          (item) =>
            item.id !== "root" &&
            item.name === name &&
            item.parentReference.id === parentId,
        )
      ) {
        return new Response(null, { status: 409 });
      }
      return jsonResponse(
        201,
        this.inject(name, {
          parent: parentId,
          kind: "folder" in payload ? "directory" : "file",
        }),
      );
    }
    if (suffix.endsWith("/content")) {
      const id = suffix.slice(0, -"/content".length);
      if (method === "GET") {
        return new Response(null, {
          status: 302,
          headers: { Location: `https://download.example/${id}` },
        });
      }
      if (method === "PUT") {
        const data = new Uint8Array(init.body ?? new Uint8Array());
        if (id.includes(":/")) {
          const [parentId, rawName] = id.split(":/");
          const name = rawName.replace(/:$/, "");
          if (
            [...this.items.values()].some(
              (item) =>
                item.id !== "root" &&
                item.name === name &&
                item.parentReference.id === parentId,
            )
          ) {
            return new Response(null, { status: 409 });
          }
          return jsonResponse(
            201,
            this.inject(name, { parent: parentId, data }),
          );
        }
        const item = this.items.get(id);
        this.content.set(id, data);
        item.size = data.length;
        item.eTag = '"v2"';
        return jsonResponse(200, item);
      }
    }
    const item = this.items.get(suffix);
    if (!item) return new Response(null, { status: 404 });
    if (method === "GET") return jsonResponse(200, item);
    if (method === "PATCH") {
      const payload = JSON.parse(init.body);
      if (payload.name) item.name = payload.name;
      if (payload.parentReference)
        item.parentReference.id = payload.parentReference.id;
      return jsonResponse(200, item);
    }
    if (method === "DELETE") {
      this.items.delete(suffix);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected item request: ${method} ${path}`);
  }

  children(parentId, url) {
    const values = [...this.items.values()].filter(
      (item) => item.parentReference.id === parentId,
    );
    const start = Number(url.searchParams.get("$skiptoken") ?? 0);
    const next =
      start + 2 < values.length
        ? `https://graph.microsoft.com/v1.0/drives/drive/items/${parentId}/children?$skiptoken=${start + 2}`
        : null;
    return jsonResponse(200, {
      value: values.slice(start, start + 2),
      "@odata.nextLink": next,
    });
  }

  download(path, headers) {
    const data = this.content.get(path.slice(1));
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

  startUpload(suffix) {
    let existingId = null;
    let parentId = null;
    let name = null;
    if (suffix.includes(":/")) {
      [parentId, name] = suffix.split(":/");
    } else {
      existingId = suffix.split("/")[0];
    }
    const id = String(this.nextSession++);
    this.sessions.set(id, {
      existingId,
      parentId,
      name,
      bytes: new Uint8Array(),
      completed: null,
    });
    return jsonResponse(200, { uploadUrl: `https://upload.example/${id}` });
  }

  session(path, method, headers, body) {
    const session = this.sessions.get(path.slice(1));
    if (method === "DELETE") {
      this.cancelCount += 1;
      return new Response(null, { status: 204 });
    }
    if (method === "GET") {
      if (session.completed) {
        if (this.expireSessionAfterCommit) {
          return new Response(null, { status: 404 });
        }
        return jsonResponse(200, session.completed);
      }
      return jsonResponse(200, {
        nextExpectedRanges: [`${session.bytes.length}-`],
      });
    }
    assert.equal(method, "PUT");
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
      headers.get("Content-Range"),
    );
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = Number(match[3]);
    const fragment = new Uint8Array(body);
    assert.equal(start, session.bytes.length);
    assert.equal(end - start + 1, fragment.length);
    const bytes = new Uint8Array(start + fragment.length);
    bytes.set(session.bytes);
    bytes.set(fragment, start);
    session.bytes = bytes;
    if (bytes.length < total) {
      return jsonResponse(202, { nextExpectedRanges: [`${bytes.length}-`] });
    }
    let item;
    if (session.existingId) {
      item = this.items.get(session.existingId);
      item.size = bytes.length;
      item.eTag = '"v2"';
      this.content.set(item.id, bytes);
    } else {
      item = this.inject(session.name, {
        parent: session.parentId,
        data: bytes,
      });
    }
    session.completed = item;
    if (this.loseFinalResponse) {
      this.loseFinalResponse = false;
      return new Response(null, { status: 503 });
    }
    return jsonResponse(201, item);
  }
}

function make(kind) {
  const siteId = kind === "sharepoint" ? "site" : null;
  const api = new GraphApiFixture(
    siteId ? "documentLibrary" : "personal",
    siteId,
  );
  const store = new MemoryCredentialStore({ access_token: "test-token" });
  const auth = new GraphAuth({
    tenant_id: siteId ? "tenant" : "consumers",
    client_id: "client",
    store,
  });
  const options = {
    driveId: "drive",
    rootId: "root",
    auth,
    fetch: api.fetch.bind(api),
  };
  const storage = siteId
    ? new SharePointStorage({ ...options, siteId })
    : new OneDriveStorage(options);
  return { api, storage, store };
}

async function collect(iterable) {
  const entries = [];
  for await (const entry of iterable) entries.push(entry);
  return entries;
}

test("Graph lifecycle works in both public roots", async () => {
  for (const kind of ["personal", "sharepoint"]) {
    const { api, storage } = make(kind);
    const folder = await storage.mkdir("/reports");
    assert.equal(folder.kind, "directory");
    const bytes = encoder.encode("ab".repeat(2 * 1024 * 1024 + 3));
    async function* stream() {
      yield bytes;
    }
    const entry = await storage.write("/reports/data.bin", stream(), {
      size: bytes.length,
    });
    assert.equal(entry.size, bytes.length);
    assert.equal(
      decoder.decode(await storage.read_range(entry.ref, 1, 4)),
      "baba",
    );
    const reader = storage.open_reader(entry.ref)[Symbol.asyncIterator]();
    assert.equal(
      decoder.decode((await reader.next()).value),
      decoder.decode(bytes),
    );
    await reader.return();
    assert.equal(api.signedAuthorizationSeen, false);
    assert.deepEqual(await storage.read(entry.ref), bytes);
    const moved = await storage.move(entry.ref, "/reports/new.bin");
    assert.equal((await storage.stat(entry.ref)).path, moved.path);
    assert.equal((await collect(storage.list(folder.ref))).length, 1);
    await assert.rejects(storage.delete(folder.ref), DirectoryNotEmptyError);
    await storage.delete(entry.ref);
    assert.equal(await storage.exists(moved.path), false);
    await storage.delete(folder.ref);
  }
});

test("Graph empty files, replacement and stream size", async () => {
  const { api, storage } = make("personal");
  async function* one() {
    yield encoder.encode("abc");
  }
  await assert.rejects(
    storage.write("/unknown", one()),
    InvalidUploadSourceError,
  );
  assert.equal(api.nextSession, 1);
  await assert.rejects(
    storage.write("/bad", one(), { size: 2 }),
    InvalidUploadSourceError,
  );
  assert.equal(api.cancelCount, 1);
  const empty = await storage.write("/empty", new Uint8Array());
  assert.equal(empty.size, 0);
  const entry = await storage.write("/item", encoder.encode("ok"));
  const replaced = await storage.write("/item", encoder.encode("new"), {
    overwrite: true,
  });
  assert.equal(entry.id, replaced.id);
  assert.equal(replaced.version, '"v2"');
  await assert.rejects(
    storage.write("/item", encoder.encode("x"), {
      overwrite: true,
      expected_version: '"v2"',
    }),
    UnsupportedOperationError,
  );
});

test("Graph duplicate names, root scope and ignored range", async () => {
  const { api, storage } = make("personal");
  const first = api.inject("same", { data: encoder.encode("one") });
  api.inject("same", { data: encoder.encode("two") });
  assert.equal((await collect(storage.list("/"))).length, 2);
  await assert.rejects(storage.stat("/same"), AmbiguousPathError);
  const ref = (await collect(storage.list("/"))).find(
    (entry) => entry.id === first.id,
  ).ref;
  api.ignoreRange = true;
  await assert.rejects(storage.read_range(ref, 1, 2), ProviderError);
  first.parentReference.id = "outside";
  await assert.rejects(storage.stat(ref), NotFoundError);
});

test("Graph rejects a byte range beyond the safe integer limit", async () => {
  const { storage } = make("personal");
  await assert.rejects(
    storage.read_range("/missing", Number.MAX_SAFE_INTEGER, 2),
    InvalidArgumentError,
  );
});

test("Graph error mapping, retry and refresh", async () => {
  const { api, storage, store } = make("personal");
  api.forcedStatus = 403;
  await assert.rejects(storage.exists("/missing"), PermissionDeniedError);
  api.forcedStatus = 429;
  assert.equal((await storage.stat("/")).kind, "directory");
  api.forcedStatus = 503;
  assert.equal((await storage.stat("/")).kind, "directory");
  api.forcedStatus = 507;
  await assert.rejects(storage.stat("/"), QuotaExceededError);
  api.forcedStatus = 409;
  await assert.rejects(storage.stat("/"), ConflictError);
  api.forcedStatus = 412;
  await assert.rejects(storage.stat("/"), ConflictError);
  api.forcedException = true;
  await assert.rejects(storage.stat("/"), ProviderUnavailableError);
  api.forcedStatus = 401;
  store.save({
    access_token: "test-token",
    refresh_token: "refresh-token",
  });
  assert.equal((await storage.stat("/")).kind, "directory");
  assert.equal(api.refreshCount, 1);
  store.save({
    access_token: "test-token",
    refresh_token: "refresh-token",
    expires_at: Date.now() - 60_000,
  });
  assert.equal((await storage.stat("/")).kind, "directory");
  assert.equal(api.refreshCount, 2);
  const badStore = {
    load: () => ({
      access_token: "test-token",
      refresh_token: "refresh-token",
      expires_at: 0,
    }),
    save: () => {
      throw new Error("secret should not appear");
    },
  };
  const badAuth = new GraphAuth({
    tenant_id: "consumers",
    client_id: "client",
    store: badStore,
  });
  await assert.rejects(
    badAuth.access_token(api.fetch.bind(api)),
    (error) =>
      error instanceof AuthenticationError && !error.message.includes("secret"),
  );
});

test("Graph uncertain upload completion is recovered or reported", async () => {
  const { api, storage } = make("sharepoint");
  api.loseFinalResponse = true;
  assert.equal(
    (await storage.write("/recovered", encoder.encode("data"))).size,
    4,
  );
  api.loseFinalResponse = true;
  api.expireSessionAfterCommit = true;
  await assert.rejects(
    storage.write("/unknown", encoder.encode("data")),
    IndeterminateOperationError,
  );
});

test("Graph reader cancels on early return", async () => {
  const { api, storage } = make("personal");
  api.inject("item", { data: encoder.encode("contents") });
  api.trackReaderCancel = true;
  const reader = storage.open_reader("/item")[Symbol.asyncIterator]();
  await reader.next();
  await reader.return();
  assert.equal(api.readerCanceled, true);
});

test("Graph rejects a mismatched drive and SharePoint root", async () => {
  const personal = make("personal");
  personal.api.driveType = "business";
  await assert.rejects(personal.storage.stat("/"), NotFoundError);
  const sharepoint = make("sharepoint");
  sharepoint.api.items.get("root").sharepointIds.siteId = "another-site";
  await assert.rejects(sharepoint.storage.stat("/"), NotFoundError);
});

test("Graph refresh is serialized across simultaneous requests", async () => {
  const { api, store } = make("personal");
  store.save({
    access_token: "test-token",
    refresh_token: "refresh-token",
    expires_at: Date.now() - 60_000,
  });
  const auth = new GraphAuth({
    tenant_id: "consumers",
    client_id: "client",
    store,
  });
  const fetcher = api.fetch.bind(api);
  const [first, second] = await Promise.all([
    auth.access_token(fetcher),
    auth.access_token(fetcher),
  ]);
  assert.equal(first, "new-token");
  assert.equal(second, "new-token");
  assert.equal(api.refreshCount, 1);
});

test("Graph request deadline bounds a stalled transport", async () => {
  const auth = new GraphAuth({
    tenant_id: "consumers",
    client_id: "client",
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
  const storage = new OneDriveStorage({
    driveId: "drive",
    rootId: "root",
    auth,
    fetch: fetcher,
    timeoutMs: 20,
  });
  await assert.rejects(storage.stat("/"), ProviderUnavailableError);
  assert.equal(aborted, true);
  assert.throws(
    () =>
      new OneDriveStorage({
        driveId: "drive",
        rootId: "root",
        auth,
        timeoutMs: 0,
      }),
    InvalidArgumentError,
  );
  assert.throws(
    () =>
      new OneDriveStorage({
        driveId: "drive",
        rootId: "root",
        auth,
        timeoutMs: 2_147_483_648,
      }),
    InvalidArgumentError,
  );
});

test("Graph body failures distinguish reads from uncertain writes", async () => {
  const { api, store } = make("personal");
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
  const auth = new GraphAuth({
    tenant_id: "consumers",
    client_id: "client",
    store,
  });
  const storage = new OneDriveStorage({
    driveId: "drive",
    rootId: "root",
    auth,
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
