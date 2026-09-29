import {
  AlreadyExistsError,
  AmbiguousPathError,
  AuthenticationError,
  ConflictError,
  DirectoryNotEmptyError,
  FileStorage,
  IndeterminateOperationError,
  InvalidArgumentError,
  InvalidPathError,
  InvalidUploadSourceError,
  IsDirectoryError,
  ItemRef,
  NotDirectoryError,
  NotFoundError,
  PermissionDeniedError,
  ProviderError,
  ProviderUnavailableError,
  QuotaExceededError,
  RateLimitError,
  RefScope,
  UnsupportedOperationError,
  normalize_path,
  split_parent,
  type EntryKind,
  type StorageCapabilities,
  type StorageEntry,
  type StorageTarget,
  type UploadSource,
  type WriteOptions,
} from "@pydemia/drivefs";

import { GraphAuth } from "./auth.js";

const GRAPH_URL = "https://graph.microsoft.com/v1.0";
const CHUNK_SIZE = 10 * 320 * 1024;
type Metadata = Record<string, unknown>;

interface GraphStorageOptions {
  driveId: string;
  rootId: string;
  auth: GraphAuth;
  fetch?: typeof fetch;
}

export type OneDriveStorageOptions = GraphStorageOptions;
export interface SharePointStorageOptions extends GraphStorageOptions {
  siteId: string;
}

function record(value: unknown): Metadata | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Metadata)
    : null;
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("Retry-After");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.max(0, (date - Date.now()) / 1000)
    : undefined;
}

function signedUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProviderError("Graph signed URL was invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError("Graph signed URL was invalid");
  }
  if (url.protocol !== "https:" || !url.hostname) {
    throw new ProviderError("Graph signed URL was invalid");
  }
  return value;
}

function joinBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

class ByteSource {
  readonly #bytes: Uint8Array | null;
  readonly #iterator: AsyncIterator<Uint8Array> | null;
  #pending: Uint8Array | null = null;
  #position = 0;

  constructor(source: UploadSource) {
    this.#bytes = source instanceof Uint8Array ? source : null;
    this.#iterator =
      source instanceof Uint8Array ? null : source[Symbol.asyncIterator]();
  }

  async fragment(offset: number, length: number): Promise<Uint8Array> {
    if (this.#bytes) return this.#bytes.slice(offset, offset + length);
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (!this.#pending || this.#position === this.#pending.length) {
        const next = await this.#iterator!.next();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) {
          throw new InvalidUploadSourceError("stream must yield Uint8Array");
        }
        this.#pending = next.value;
        this.#position = 0;
        if (!this.#pending.length) continue;
      }
      const count = Math.min(
        length - written,
        this.#pending.length - this.#position,
      );
      output.set(
        this.#pending.subarray(this.#position, this.#position + count),
        written,
      );
      written += count;
      this.#position += count;
    }
    return output.subarray(0, written);
  }

  async ensureEnd(): Promise<void> {
    if (this.#bytes) return;
    if (this.#pending && this.#position < this.#pending.length) {
      throw new InvalidUploadSourceError("stream exceeds declared size");
    }
    for (;;) {
      const next = await this.#iterator!.next();
      if (next.done) return;
      if (!(next.value instanceof Uint8Array)) {
        throw new InvalidUploadSourceError("stream must yield Uint8Array");
      }
      if (next.value.length) {
        throw new InvalidUploadSourceError("stream exceeds declared size");
      }
    }
  }
}

class GraphStorage extends FileStorage {
  readonly #driveId: string;
  readonly #rootId: string;
  readonly #auth: GraphAuth;
  readonly #fetch: typeof fetch;
  readonly #driveType: "personal" | "documentLibrary";
  readonly #siteId: string | null;
  readonly #base: string;
  readonly #scope = new RefScope();
  #siteVerified = false;

  constructor(
    options: GraphStorageOptions,
    driveType: "personal" | "documentLibrary",
    siteId: string | null = null,
  ) {
    super();
    if (!options.driveId || !options.rootId) {
      throw new InvalidArgumentError("driveId and rootId are required");
    }
    this.#driveId = options.driveId;
    this.#rootId = options.rootId;
    this.#auth = options.auth;
    this.#fetch = options.fetch ?? fetch;
    this.#driveType = driveType;
    this.#siteId = siteId;
    this.#base = `${GRAPH_URL}/drives/${encodeURIComponent(options.driveId)}`;
  }

  get capabilities(): StorageCapabilities {
    return { conditional_replace: false };
  }

  #error(
    response: Response,
    operation: string,
    target: string | undefined,
    mutation: boolean,
  ): Error {
    const context = {
      operation,
      target,
      provider: "microsoft",
      retry_after: retryAfter(response),
    };
    switch (response.status) {
      case 401:
        return new AuthenticationError("Graph authentication failed", context);
      case 403:
        return new PermissionDeniedError("Graph permission denied", context);
      case 404:
        return new NotFoundError("Graph item was not found", context);
      case 409:
      case 412:
        return new ConflictError("Graph item changed concurrently", context);
      case 429:
        return new RateLimitError("Graph request was throttled", context);
      case 507:
        return new QuotaExceededError("Graph storage quota exceeded", context);
      default:
        if (response.status >= 500) {
          return mutation
            ? new IndeterminateOperationError(
                "Graph mutation result is unknown",
                context,
              )
            : new ProviderUnavailableError(
                "Graph service is unavailable",
                context,
              );
        }
        return new ProviderError("Graph request failed", context);
    }
  }

  async #discard(response: Response): Promise<void> {
    if (!response.body || response.bodyUsed || response.body.locked) return;
    try {
      await response.body.cancel();
    } catch {
      /* already closing */
    }
  }

  async #request(
    method: string,
    url: string,
    options: {
      operation: string;
      target?: string;
      json?: Metadata;
      body?: BodyInit;
      headers?: Record<string, string>;
      expected?: number[];
      mutation?: boolean;
      signal?: AbortSignal | undefined;
    },
  ): Promise<Response> {
    const mutation = options.mutation ?? false;
    const expected = options.expected ?? [200];
    let refreshed = false;
    let attempt = 0;
    for (;;) {
      const token = await this.#auth.access_token(this.#fetch);
      const headers = new Headers(options.headers);
      headers.set("Authorization", `Bearer ${token}`);
      if (options.json !== undefined) {
        headers.set("Content-Type", "application/json");
      }
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers,
          redirect: "manual",
          signal: options.signal ?? null,
          body:
            options.json !== undefined
              ? JSON.stringify(options.json)
              : (options.body ?? null),
        });
      } catch {
        const ErrorType = mutation
          ? IndeterminateOperationError
          : ProviderUnavailableError;
        throw new ErrorType("Graph transport failed", {
          operation: options.operation,
          target: options.target,
          provider: "microsoft",
        });
      }
      if (expected.includes(response.status)) return response;
      if (response.status === 401 && !refreshed) {
        await this.#discard(response);
        await this.#auth.access_token(this.#fetch, true, token);
        refreshed = true;
        continue;
      }
      if (
        !mutation &&
        [429, 500, 502, 503, 504].includes(response.status) &&
        attempt < 2
      ) {
        const delay = retryAfter(response);
        await this.#discard(response);
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(delay ?? 2 ** attempt, 30) * 1000),
        );
        attempt += 1;
        continue;
      }
      const error = this.#error(
        response,
        options.operation,
        options.target,
        mutation,
      );
      await this.#discard(response);
      throw error;
    }
  }

  async #jsonObject(response: Response): Promise<Metadata> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError("Graph response was not JSON");
    }
    const result = record(payload);
    if (!result) throw new ProviderError("Graph response had an invalid shape");
    return result;
  }

  #itemUrl(id: string): string {
    return `${this.#base}/items/${encodeURIComponent(id)}`;
  }

  async #get(id: string): Promise<Metadata> {
    return this.#jsonObject(
      await this.#request("GET", this.#itemUrl(id), {
        operation: "stat",
        target: id,
      }),
    );
  }

  async #verifySiteDrive(): Promise<void> {
    if (this.#siteId === null || this.#siteVerified) return;
    const base = `${GRAPH_URL}/sites/${encodeURIComponent(this.#siteId)}/drives`;
    let url = base;
    const seen = new Set<string>();
    for (;;) {
      const payload = await this.#jsonObject(
        await this.#request("GET", url, {
          operation: "stat",
          target: this.#siteId,
        }),
      );
      if (!Array.isArray(payload.value)) {
        throw new ProviderError("Graph site drive listing was invalid");
      }
      if (payload.value.some((item) => record(item)?.id === this.#driveId)) {
        this.#siteVerified = true;
        return;
      }
      const next = payload["@odata.nextLink"];
      if (!next) throw new NotFoundError("configured library is outside site");
      if (
        typeof next !== "string" ||
        !next.startsWith(`${base}?`) ||
        seen.has(next)
      ) {
        throw new ProviderError("Graph site pagination URL was invalid");
      }
      seen.add(next);
      url = next;
    }
  }

  async #root(): Promise<Metadata> {
    await this.#verifySiteDrive();
    const drive = await this.#jsonObject(
      await this.#request("GET", this.#base, {
        operation: "stat",
        target: this.#driveId,
      }),
    );
    if (drive.driveType !== this.#driveType) {
      throw new NotFoundError("configured Graph drive has the wrong type");
    }
    const root = await this.#get(this.#rootId);
    if (!record(root.folder)) {
      throw new NotFoundError("configured Graph root is not a folder");
    }
    const ids = record(root.sharepointIds);
    if (
      this.#siteId !== null &&
      ids?.siteId !== undefined &&
      ids.siteId !== this.#siteId
    ) {
      throw new NotFoundError("configured Graph root is outside site");
    }
    return root;
  }

  async *#pages(parentId: string): AsyncGenerator<Metadata> {
    let url = `${this.#itemUrl(parentId)}/children`;
    const seen = new Set<string>();
    for (;;) {
      const payload = await this.#jsonObject(
        await this.#request("GET", url, {
          operation: "list",
          target: parentId,
        }),
      );
      if (!Array.isArray(payload.value)) {
        throw new ProviderError("Graph listing omitted items");
      }
      for (const value of payload.value) {
        const item = record(value);
        if (!item) throw new ProviderError("Graph listing had an invalid item");
        yield item;
      }
      const next = payload["@odata.nextLink"];
      if (!next) return;
      if (
        typeof next !== "string" ||
        !next.startsWith(`${this.#base}/items/`) ||
        seen.has(next)
      ) {
        throw new ProviderError("Graph pagination URL was invalid");
      }
      seen.add(next);
      url = next;
    }
  }

  async #findChild(parentId: string, name: string): Promise<Metadata | null> {
    let match: Metadata | null = null;
    const ids: string[] = [];
    for await (const item of this.#pages(parentId)) {
      if (item.name !== name) continue;
      match = item;
      ids.push(String(item.id));
      if (ids.length > 1) {
        throw new AmbiguousPathError("Graph path matches multiple items", {
          provider: "microsoft",
          item_ids: ids,
        });
      }
    }
    return match;
  }

  async #pathForId(id: string): Promise<[Metadata, string]> {
    if (id === this.#rootId) return [await this.#root(), "/"];
    const parts: string[] = [];
    const seen = new Set<string>();
    let current = id;
    let first: Metadata | null = null;
    while (current !== this.#rootId) {
      if (seen.has(current)) {
        throw new ProviderError("Graph parent chain contains a cycle");
      }
      seen.add(current);
      const item = await this.#get(current);
      first ??= item;
      const parent = record(item.parentReference);
      if (
        !parent ||
        typeof parent.id !== "string" ||
        parent.driveId !== this.#driveId
      ) {
        throw new NotFoundError("Graph item is outside this root");
      }
      if (typeof item.name !== "string" || !item.name) {
        throw new ProviderError("Graph item has an invalid name");
      }
      parts.push(item.name);
      current = parent.id;
    }
    await this.#root();
    if (!first) throw new ProviderError("Graph item was not resolved");
    return [first, `/${parts.reverse().join("/")}`];
  }

  async #resolve(target: StorageTarget): Promise<[Metadata, string]> {
    if (target instanceof ItemRef) {
      const [id, driveId] = this.#scope.resolve(target);
      if (driveId !== this.#driveId) {
        throw new NotFoundError("reference belongs to another drive");
      }
      return this.#pathForId(id);
    }
    const path = normalize_path(target);
    let item = await this.#root();
    if (path === "/") return [item, path];
    for (const name of path.slice(1).split("/")) {
      this.#requireDirectory(item);
      const child = await this.#findChild(String(item.id), name);
      if (!child) {
        throw new NotFoundError("Graph path does not exist", {
          target: path,
          provider: "microsoft",
        });
      }
      item = child;
    }
    return [item, path];
  }

  #kind(item: Metadata): EntryKind {
    if (record(item.remoteItem) || record(item.package)) return "other";
    if (record(item.folder)) return "directory";
    if (record(item.file)) return "file";
    return "other";
  }

  #requireDirectory(item: Metadata): void {
    if (this.#kind(item) !== "directory") {
      throw new NotDirectoryError("Graph item is not a directory");
    }
  }

  #requireFile(item: Metadata): void {
    const kind = this.#kind(item);
    if (kind === "directory")
      throw new IsDirectoryError("Graph item is a directory");
    if (kind === "other") {
      throw new UnsupportedOperationError("Graph item is not a binary file");
    }
  }

  #entry(item: Metadata, path: string): StorageEntry {
    if (typeof item.id !== "string") {
      throw new ProviderError("Graph item omitted its ID");
    }
    const name = item.name ?? "";
    if (typeof name !== "string") {
      throw new ProviderError("Graph item had an invalid name");
    }
    const size = item.size;
    if (
      size !== undefined &&
      size !== null &&
      (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
    ) {
      throw new ProviderError("Graph item had an invalid size");
    }
    const modifiedValue = item.lastModifiedDateTime;
    const modified_at =
      typeof modifiedValue === "string" ? new Date(modifiedValue) : null;
    if (modified_at && Number.isNaN(modified_at.valueOf())) {
      throw new ProviderError("Graph item had an invalid timestamp");
    }
    const mimeType = record(item.file)?.mimeType;
    return {
      ref: this.#scope.make(item.id, this.#driveId),
      id: item.id,
      path,
      name,
      kind: this.#kind(item),
      size: typeof size === "number" ? size : null,
      modified_at,
      mime_type: typeof mimeType === "string" ? mimeType : null,
      version: typeof item.eTag === "string" ? item.eTag : null,
    };
  }

  async stat(target: StorageTarget): Promise<StorageEntry> {
    const [item, path] = await this.#resolve(target);
    return this.#entry(item, path);
  }

  async *list(target: StorageTarget): AsyncGenerator<StorageEntry> {
    const [item, path] = await this.#resolve(target);
    this.#requireDirectory(item);
    for await (const child of this.#pages(String(item.id))) {
      if (typeof child.name !== "string" || !child.name) {
        throw new ProviderError("Graph listing had an invalid name");
      }
      yield this.#entry(child, `${path.replace(/\/$/, "")}/${child.name}`);
    }
  }

  async #download(
    target: StorageTarget,
    range?: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const [item] = await this.#resolve(target);
    this.#requireFile(item);
    const redirect = await this.#request(
      "GET",
      `${this.#itemUrl(String(item.id))}/content`,
      { operation: "read", target: String(item.id), expected: [302], signal },
    );
    const location = signedUrl(redirect.headers.get("Location"));
    await this.#discard(redirect);
    let response: Response;
    try {
      response = await this.#fetch(location, {
        method: "GET",
        redirect: "manual",
        headers: range ? { Range: range } : {},
        signal: signal ?? null,
      });
    } catch {
      throw new ProviderUnavailableError("Graph download transport failed", {
        provider: "microsoft",
      });
    }
    if ((range ? [200, 206, 416] : [200]).includes(response.status)) {
      return response;
    }
    const error = this.#error(response, "read", String(item.id), false);
    await this.#discard(response);
    throw error;
  }

  async read(target: StorageTarget): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.open_reader(target)) chunks.push(chunk);
    return joinBytes(chunks);
  }

  async *open_reader(
    target: StorageTarget,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const response = await this.#download(target, undefined, signal);
    if (!response.body) return;
    const reader = response.body.getReader();
    try {
      for (;;) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch {
          throw new ProviderUnavailableError("Graph download stream failed", {
            provider: "microsoft",
          });
        }
        if (result.done) return;
        yield result.value;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      reader.releaseLock();
    }
  }

  async read_range(
    target: StorageTarget,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0
    ) {
      throw new InvalidArgumentError(
        "offset and length must be nonnegative integers",
      );
    }
    if (length === 0) {
      this.#requireFile((await this.#resolve(target))[0]);
      return new Uint8Array();
    }
    const response = await this.#download(
      target,
      `bytes=${offset}-${offset + length - 1}`,
    );
    if (response.status === 416) {
      await this.#discard(response);
      return new Uint8Array();
    }
    if (response.status !== 206) {
      await this.#discard(response);
      throw new ProviderError("Graph ignored the requested byte range");
    }
    if (
      !response.headers.get("Content-Range")?.startsWith(`bytes ${offset}-`)
    ) {
      await this.#discard(response);
      throw new ProviderError("Graph returned a different byte range");
    }
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > length) {
        throw new ProviderError("Graph range exceeded requested length");
      }
      return bytes;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderUnavailableError("Graph download stream failed");
    }
  }

  async mkdir(path: string): Promise<StorageEntry> {
    const [parentPath, name] = split_parent(path);
    const [parent] = await this.#resolve(parentPath);
    this.#requireDirectory(parent);
    try {
      if (await this.#findChild(String(parent.id), name)) {
        throw new AlreadyExistsError("Graph destination already exists");
      }
    } catch (error) {
      if (error instanceof AmbiguousPathError) {
        throw new AlreadyExistsError("Graph destination already exists");
      }
      throw error;
    }
    const response = await this.#request(
      "POST",
      `${this.#itemUrl(String(parent.id))}/children`,
      {
        operation: "mkdir",
        target: path,
        json: {
          name,
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        },
        expected: [201],
        mutation: true,
      },
    );
    return this.#entry(await this.#jsonObject(response), normalize_path(path));
  }

  async move(
    target: StorageTarget,
    destination: string,
  ): Promise<StorageEntry> {
    const [item, oldPath] = await this.#resolve(target);
    if (item.id === this.#rootId) {
      throw new UnsupportedOperationError("cannot move the Graph root");
    }
    if (this.#kind(item) === "other") {
      throw new UnsupportedOperationError("cannot move this Graph item");
    }
    const [parentPath, name] = split_parent(destination);
    const [parent] = await this.#resolve(parentPath);
    this.#requireDirectory(parent);
    if (
      this.#kind(item) === "directory" &&
      (parentPath === oldPath || parentPath.startsWith(`${oldPath}/`))
    ) {
      throw new InvalidPathError("cannot move into own descendant");
    }
    try {
      if (await this.#findChild(String(parent.id), name)) {
        throw new AlreadyExistsError("Graph destination already exists");
      }
    } catch (error) {
      if (error instanceof AmbiguousPathError) {
        throw new AlreadyExistsError("Graph destination already exists");
      }
      throw error;
    }
    const response = await this.#request(
      "PATCH",
      this.#itemUrl(String(item.id)),
      {
        operation: "move",
        target: oldPath,
        json: { name, parentReference: { id: parent.id } },
        mutation: true,
      },
    );
    return this.#entry(
      await this.#jsonObject(response),
      normalize_path(destination),
    );
  }

  async delete(target: StorageTarget): Promise<void> {
    const [item, path] = await this.#resolve(target);
    if (item.id === this.#rootId) {
      throw new UnsupportedOperationError("cannot delete the Graph root");
    }
    if (this.#kind(item) === "other") {
      throw new UnsupportedOperationError("cannot delete this Graph item");
    }
    if (this.#kind(item) === "directory") {
      const firstChild = await this.#pages(String(item.id)).next();
      if (!firstChild.done) {
        throw new DirectoryNotEmptyError("Graph directory is not empty");
      }
    }
    await this.#request("DELETE", this.#itemUrl(String(item.id)), {
      operation: "delete",
      target: path,
      expected: [204],
      mutation: true,
    });
  }

  async write(
    path: string,
    data: UploadSource,
    options: WriteOptions = {},
  ): Promise<StorageEntry> {
    const overwrite = options.overwrite ?? false;
    if (options.expected_version != null && !overwrite) {
      throw new InvalidArgumentError(
        "expected_version requires overwrite=true",
      );
    }
    if (options.expected_version != null) {
      throw new UnsupportedOperationError(
        "Graph conditional replacement is unverified",
      );
    }
    let total: number;
    if (data instanceof Uint8Array) {
      total = data.length;
      if (options.size != null && options.size !== total) {
        throw new InvalidUploadSourceError("byte count differs from size");
      }
    } else {
      if (
        !data ||
        typeof data[Symbol.asyncIterator] !== "function" ||
        !Number.isSafeInteger(options.size) ||
        options.size! < 0
      ) {
        throw new InvalidUploadSourceError(
          "stream requires a nonnegative size",
        );
      }
      total = options.size!;
    }
    const source = new ByteSource(data);
    const [parentPath, name] = split_parent(path);
    const [parent] = await this.#resolve(parentPath);
    this.#requireDirectory(parent);
    let existing: Metadata | null;
    try {
      existing = await this.#findChild(String(parent.id), name);
    } catch (error) {
      if (error instanceof AmbiguousPathError && !overwrite) {
        throw new AlreadyExistsError("Graph destination already exists");
      }
      throw error;
    }
    if (existing && !overwrite) {
      throw new AlreadyExistsError("Graph destination already exists");
    }
    if (existing) this.#requireFile(existing);
    let result: Metadata;
    if (total === 0) {
      await source.ensureEnd();
      const endpoint = existing
        ? `${this.#itemUrl(String(existing.id))}/content`
        : `${this.#itemUrl(String(parent.id))}:/${encodeURIComponent(name)}:/content`;
      const response = await this.#request("PUT", endpoint, {
        operation: "write",
        target: path,
        body: new Uint8Array(),
        headers: { "Content-Type": "application/octet-stream" },
        expected: [200, 201],
        mutation: true,
      });
      result = await this.#jsonObject(response);
    } else {
      const endpoint = existing
        ? `${this.#itemUrl(String(existing.id))}/createUploadSession`
        : `${this.#itemUrl(String(parent.id))}:/${encodeURIComponent(name)}:/createUploadSession`;
      const item: Metadata = {
        "@microsoft.graph.conflictBehavior": existing ? "replace" : "fail",
        name,
      };
      if (this.#driveType === "personal") item.fileSize = total;
      const sessionResponse = await this.#request("POST", endpoint, {
        operation: "write",
        target: path,
        json: { item },
        mutation: true,
      });
      const payload = await this.#jsonObject(sessionResponse);
      let session: string;
      try {
        session = signedUrl(payload.uploadUrl);
      } catch {
        throw new IndeterminateOperationError(
          "Graph upload session was not returned",
          { operation: "write", target: path, provider: "microsoft" },
        );
      }
      try {
        result = await this.#upload(session, source, total);
      } catch (error) {
        if (error instanceof InvalidUploadSourceError) {
          await this.#cancelUpload(session);
        }
        throw error;
      }
    }
    const normalized = normalize_path(path);
    const entry = this.#entry(result, normalized);
    if (!existing) {
      const ids: string[] = [];
      for await (const item of this.#pages(String(parent.id))) {
        if (item.name === name) ids.push(String(item.id));
      }
      if (ids.length > 1) {
        throw new ConflictError("Graph creation raced with another item", {
          operation: "write",
          target: normalized,
          provider: "microsoft",
          item_ids: ids,
        });
      }
    }
    return entry;
  }

  async #cancelUpload(session: string): Promise<void> {
    try {
      await this.#fetch(session, { method: "DELETE", redirect: "manual" });
    } catch {
      /* cancellation is best effort */
    }
  }

  #nextOffset(payload: Metadata): number {
    const ranges = payload.nextExpectedRanges;
    const first = Array.isArray(ranges) ? ranges[0] : null;
    const match = typeof first === "string" ? /^(\d+)-/.exec(first) : null;
    const offset = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(offset)) {
      throw new IndeterminateOperationError(
        "Graph upload returned an invalid next range",
      );
    }
    return offset;
  }

  async #uploadStatus(
    session: string,
  ): Promise<[number | null, Metadata | null]> {
    let response: Response;
    try {
      response = await this.#fetch(session, {
        method: "GET",
        redirect: "manual",
      });
    } catch {
      throw new IndeterminateOperationError(
        "Graph upload status is unavailable",
      );
    }
    if (response.status === 404) {
      throw new IndeterminateOperationError(
        "Graph upload session expired before completion",
      );
    }
    if (response.status !== 200) {
      throw this.#error(response, "write", undefined, true);
    }
    const payload = await this.#jsonObject(response);
    if (record(payload.file)) return [null, payload];
    return [this.#nextOffset(payload), null];
  }

  async #upload(
    session: string,
    source: ByteSource,
    total: number,
  ): Promise<Metadata> {
    let offset = 0;
    while (offset < total) {
      const length = Math.min(CHUNK_SIZE, total - offset);
      const fragment = await source.fragment(offset, length);
      if (fragment.length !== length) {
        throw new InvalidUploadSourceError("stream is shorter than size");
      }
      if (offset + length === total) await source.ensureEnd();
      const [nextOffset, completed] = await this.#putFragment(
        session,
        fragment,
        offset,
        total,
      );
      if (completed) {
        if (offset + length !== total) {
          throw new IndeterminateOperationError(
            "Graph upload completed before declared size",
          );
        }
        return completed;
      }
      if (nextOffset !== offset + length) {
        throw new IndeterminateOperationError(
          "Graph upload did not acknowledge its fragment",
        );
      }
      offset = nextOffset;
    }
    const [, completed] = await this.#uploadStatus(session);
    if (completed) return completed;
    throw new IndeterminateOperationError("Graph upload completion is unknown");
  }

  async #putFragment(
    session: string,
    fragment: Uint8Array,
    start: number,
    total: number,
  ): Promise<[number, Metadata | null]> {
    const end = start + fragment.length;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response | null;
      try {
        response = await this.#fetch(session, {
          method: "PUT",
          redirect: "manual",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Range": `bytes ${start}-${end - 1}/${total}`,
          },
          body: new Uint8Array(fragment),
        });
      } catch {
        response = null;
      }
      if (response) {
        if (response.status === 200 || response.status === 201) {
          return [end, await this.#jsonObject(response)];
        }
        if (response.status === 202) {
          const next = this.#nextOffset(await this.#jsonObject(response));
          if (next === end) return [next, null];
          if (next !== start) {
            throw new IndeterminateOperationError(
              "Graph upload acknowledged a partial fragment",
            );
          }
          continue;
        }
        if (![429, 500, 502, 503, 504].includes(response.status)) {
          throw this.#error(response, "write", undefined, true);
        }
      }
      const [offset, completed] = await this.#uploadStatus(session);
      if (completed) return [end, completed];
      if (offset === end) return [end, null];
      if (offset !== start) {
        throw new IndeterminateOperationError(
          "Graph upload status has a partial fragment",
        );
      }
    }
    throw new IndeterminateOperationError("Graph upload retry limit reached");
  }
}

export class OneDriveStorage extends GraphStorage {
  constructor(options: OneDriveStorageOptions) {
    if (options.auth.tenant_id !== "consumers") {
      throw new InvalidArgumentError(
        "OneDrive Personal requires a consumers tenant auth",
      );
    }
    super(options, "personal");
  }
}

export class SharePointStorage extends GraphStorage {
  constructor(options: SharePointStorageOptions) {
    if (
      !options.siteId ||
      ["common", "consumers"].includes(options.auth.tenant_id)
    ) {
      throw new InvalidArgumentError(
        "SharePoint requires a site and tenant-specific auth",
      );
    }
    super(options, "documentLibrary", options.siteId);
  }
}
