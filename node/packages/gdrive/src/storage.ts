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

import { GoogleAuth } from "./auth.js";

const API_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const BINARY_MIME = "application/octet-stream";
const FIELDS =
  "id,name,mimeType,size,modifiedTime,version,parents,trashed,driveId";
const PAGE_FIELDS = `nextPageToken,incompleteSearch,files(${FIELDS})`;
const CHUNK_SIZE = 8 * 256 * 1024;

type Metadata = Record<string, unknown>;

export interface GoogleDriveStorageOptions {
  rootId: string;
  auth: GoogleAuth;
  /** Allows HTTP fixture injection without changing the public operations. */
  fetch?: typeof fetch;
}

function escapeQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
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

export class GoogleDriveStorage extends FileStorage {
  readonly #rootId: string;
  readonly #auth: GoogleAuth;
  readonly #fetch: typeof fetch;
  readonly #scope = new RefScope();

  constructor(options: GoogleDriveStorageOptions) {
    super();
    if (!options.rootId) {
      throw new InvalidArgumentError("rootId must be nonempty");
    }
    this.#rootId = options.rootId;
    this.#auth = options.auth;
    this.#fetch = options.fetch ?? fetch;
  }

  get capabilities(): StorageCapabilities {
    return { conditional_replace: false };
  }

  async #error(
    response: Response,
    operation: string,
    target: string | undefined,
    mutation: boolean,
  ): Promise<Error> {
    const context = {
      operation,
      target,
      provider: "gdrive",
      retry_after: retryAfter(response),
    };
    const status = response.status;
    if (status === 401) {
      return new AuthenticationError("Google authentication failed", context);
    }
    if (status === 404) {
      return new NotFoundError("Google item was not found", context);
    }
    if (status === 409 || status === 412) {
      return new ConflictError("Google item changed concurrently", context);
    }
    if (status === 429) {
      return new RateLimitError("Google request was throttled", context);
    }
    if (status === 403) {
      let reason: unknown;
      try {
        const body = (await response.json()) as {
          error?: { errors?: { reason?: unknown }[] };
        };
        reason = body.error?.errors?.[0]?.reason;
      } catch {
        /* status still maps safely */
      }
      if (
        reason === "rateLimitExceeded" ||
        reason === "userRateLimitExceeded"
      ) {
        return new RateLimitError("Google request was throttled", context);
      }
      if (reason === "storageQuotaExceeded" || reason === "quotaExceeded") {
        return new QuotaExceededError("Google storage quota exceeded", context);
      }
      return new PermissionDeniedError("Google permission denied", context);
    }
    if (status >= 500) {
      return mutation
        ? new IndeterminateOperationError(
            "Google mutation result is unknown",
            context,
          )
        : new ProviderUnavailableError(
            "Google service is unavailable",
            context,
          );
    }
    return new ProviderError("Google request failed", context);
  }

  async #discard(response: Response): Promise<void> {
    if (!response.body || response.bodyUsed || response.body.locked) return;
    try {
      await response.body.cancel();
    } catch {
      /* response is already closing */
    }
  }

  async #request(
    method: string,
    url: string,
    options: {
      operation: string;
      target?: string;
      params?: Record<string, string>;
      json?: Metadata;
      body?: BodyInit;
      headers?: Record<string, string> | undefined;
      expected?: number[];
      mutation?: boolean;
      signal?: AbortSignal | undefined;
    },
  ): Promise<Response> {
    let refreshed = false;
    let attempt = 0;
    const mutation = options.mutation ?? false;
    const expected = options.expected ?? [200];
    const requestUrl = new URL(url);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      requestUrl.searchParams.set(key, value);
    }
    for (;;) {
      const token = await this.#auth.access_token(this.#fetch);
      const headers = new Headers(options.headers);
      headers.set("Authorization", `Bearer ${token}`);
      if (options.json !== undefined) {
        headers.set("Content-Type", "application/json; charset=UTF-8");
      }
      let response: Response;
      try {
        response = await this.#fetch(requestUrl, {
          method,
          headers,
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
        throw new ErrorType("Google transport failed", {
          operation: options.operation,
          target: options.target,
          provider: "gdrive",
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
      const error = await this.#error(
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
      throw new ProviderError("Google response was not JSON");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ProviderError("Google response had an invalid shape");
    }
    return payload as Metadata;
  }

  async #get(id: string): Promise<Metadata> {
    const response = await this.#request(
      "GET",
      `${API_URL}/${encodeURIComponent(id)}`,
      {
        operation: "stat",
        target: id,
        params: { fields: FIELDS },
      },
    );
    return this.#jsonObject(response);
  }

  async #root(): Promise<Metadata> {
    const root = await this.#get(this.#rootId);
    if (root.trashed || root.mimeType !== FOLDER_MIME || root.driveId) {
      throw new NotFoundError("configured Google root is unavailable");
    }
    return root;
  }

  async *#pages(parentId: string, name?: string): AsyncGenerator<Metadata> {
    let query = `'${escapeQuery(parentId)}' in parents and trashed = false`;
    if (name !== undefined) query += ` and name = '${escapeQuery(name)}'`;
    let pageToken: string | undefined;
    const seen = new Set<string>();
    for (;;) {
      const params: Record<string, string> = {
        q: query,
        fields: PAGE_FIELDS,
        pageSize: "1000",
      };
      if (pageToken) params.pageToken = pageToken;
      const response = await this.#request("GET", API_URL, {
        operation: "list",
        target: parentId,
        params,
      });
      const payload = await this.#jsonObject(response);
      if (payload.incompleteSearch) {
        throw new ProviderError("Google returned an incomplete listing");
      }
      if (!Array.isArray(payload.files)) {
        throw new ProviderError("Google listing omitted files");
      }
      for (const item of payload.files) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new ProviderError("Google listing had an invalid item");
        }
        const metadata = item as Metadata;
        if (
          metadata.trashed ||
          (name !== undefined && metadata.name !== name)
        ) {
          continue;
        }
        yield metadata;
      }
      const next = payload.nextPageToken;
      if (!next) return;
      if (typeof next !== "string" || seen.has(next)) {
        throw new ProviderError("Google pagination token was invalid");
      }
      seen.add(next);
      pageToken = next;
    }
  }

  async #findChild(parentId: string, name: string): Promise<Metadata | null> {
    let match: Metadata | null = null;
    const ids: string[] = [];
    for await (const item of this.#pages(parentId, name)) {
      match = item;
      ids.push(String(item.id));
      if (ids.length > 1) {
        throw new AmbiguousPathError("Google path matches multiple items", {
          provider: "gdrive",
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
        throw new ProviderError("Google parent chain contains a cycle");
      }
      seen.add(current);
      const item = await this.#get(current);
      first ??= item;
      if (
        item.trashed ||
        !Array.isArray(item.parents) ||
        item.parents.length !== 1 ||
        typeof item.parents[0] !== "string"
      ) {
        throw new NotFoundError("Google item is outside this root");
      }
      if (typeof item.name !== "string" || !item.name) {
        throw new ProviderError("Google item has an invalid name");
      }
      parts.push(item.name);
      current = item.parents[0];
    }
    await this.#root();
    if (!first) throw new ProviderError("Google item was not resolved");
    return [first, `/${parts.reverse().join("/")}`];
  }

  async #resolve(target: StorageTarget): Promise<[Metadata, string]> {
    if (target instanceof ItemRef) {
      const [id] = this.#scope.resolve(target);
      return this.#pathForId(id);
    }
    const path = normalize_path(target);
    let item = await this.#root();
    if (path === "/") return [item, path];
    for (const name of path.slice(1).split("/")) {
      this.#requireDirectory(item);
      const child = await this.#findChild(String(item.id), name);
      if (!child) {
        throw new NotFoundError("Google path does not exist", {
          target: path,
          provider: "gdrive",
        });
      }
      item = child;
    }
    return [item, path];
  }

  #kind(item: Metadata): EntryKind {
    const mime = item.mimeType;
    if (mime === FOLDER_MIME) return "directory";
    if (
      typeof mime === "string" &&
      mime.startsWith("application/vnd.google-apps.")
    )
      return "other";
    return "file";
  }

  #requireDirectory(item: Metadata): void {
    if (this.#kind(item) !== "directory") {
      throw new NotDirectoryError("Google item is not a directory");
    }
  }

  #requireFile(item: Metadata): void {
    const kind = this.#kind(item);
    if (kind === "directory") {
      throw new IsDirectoryError("Google item is a directory");
    }
    if (kind === "other") {
      throw new UnsupportedOperationError("Google item is not a binary file");
    }
  }

  #entry(item: Metadata, path: string): StorageEntry {
    if (typeof item.id !== "string") {
      throw new ProviderError("Google item omitted its ID");
    }
    const name = item.name ?? "";
    if (typeof name !== "string") {
      throw new ProviderError("Google item had an invalid name");
    }
    const size = item.size === undefined ? null : Number(item.size);
    if (size !== null && (!Number.isSafeInteger(size) || size < 0)) {
      throw new ProviderError("Google item had an invalid size");
    }
    const modified = item.modifiedTime;
    const modified_at =
      typeof modified === "string" ? new Date(modified) : null;
    if (modified_at && Number.isNaN(modified_at.getTime())) {
      throw new ProviderError("Google item had an invalid timestamp");
    }
    return {
      ref: this.#scope.make(item.id),
      id: item.id,
      path,
      name,
      kind: this.#kind(item),
      size,
      modified_at,
      mime_type: typeof item.mimeType === "string" ? item.mimeType : null,
      version: item.version === undefined ? null : String(item.version),
    };
  }

  async stat(target: StorageTarget): Promise<StorageEntry> {
    const [item, path] = await this.#resolve(target);
    return this.#entry(item, path);
  }

  async *list(target: StorageTarget): AsyncIterable<StorageEntry> {
    const [item, path] = await this.#resolve(target);
    this.#requireDirectory(item);
    for await (const child of this.#pages(String(item.id))) {
      if (typeof child.name !== "string" || !child.name) {
        throw new ProviderError("Google listing had an invalid name");
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
    const headers = range ? { Range: range } : undefined;
    return this.#request(
      "GET",
      `${API_URL}/${encodeURIComponent(String(item.id))}`,
      {
        operation: "read",
        target: String(item.id),
        params: { alt: "media" },
        headers,
        expected: range ? [200, 206, 416] : [200],
        signal,
      },
    );
  }

  async read(target: StorageTarget): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.open_reader(target)) chunks.push(chunk);
    return joinBytes(chunks);
  }

  async *open_reader(
    target: StorageTarget,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const response = await this.#download(target, undefined, signal);
    const reader = response.body?.getReader();
    if (!reader) return;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        yield value;
      }
    } catch {
      throw new ProviderUnavailableError("Google download stream failed", {
        provider: "gdrive",
      });
    } finally {
      await reader.cancel();
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
      length < 0 ||
      (length > 0 && offset > Number.MAX_SAFE_INTEGER - (length - 1))
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
      throw new ProviderError("Google ignored the requested byte range");
    }
    const contentRange = response.headers.get("Content-Range") ?? "";
    if (!contentRange.startsWith(`bytes ${offset}-`)) {
      await this.#discard(response);
      throw new ProviderError("Google returned a different byte range");
    }
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (received < length) {
        const { value, done } = await reader.read();
        if (done) break;
        const piece = value.subarray(0, length - received);
        chunks.push(piece);
        received += piece.length;
      }
    } catch {
      throw new ProviderUnavailableError("Google range stream failed", {
        provider: "gdrive",
      });
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return joinBytes(chunks);
  }

  async mkdir(path: string): Promise<StorageEntry> {
    const [parentPath, name] = split_parent(path);
    const [parent] = await this.#resolve(parentPath);
    this.#requireDirectory(parent);
    try {
      if (await this.#findChild(String(parent.id), name)) {
        throw new AlreadyExistsError("Google destination already exists");
      }
    } catch (error) {
      if (error instanceof AmbiguousPathError) {
        throw new AlreadyExistsError("Google destination already exists");
      }
      throw error;
    }
    const response = await this.#request("POST", API_URL, {
      operation: "mkdir",
      target: path,
      params: { fields: FIELDS },
      json: { name, mimeType: FOLDER_MIME, parents: [parent.id] },
      expected: [200, 201],
      mutation: true,
    });
    return this.#entry(await this.#jsonObject(response), normalize_path(path));
  }

  async move(
    target: StorageTarget,
    destination: string,
  ): Promise<StorageEntry> {
    const [item, oldPath] = await this.#resolve(target);
    if (item.id === this.#rootId) {
      throw new UnsupportedOperationError("cannot move the Google root");
    }
    if (this.#kind(item) === "other") {
      throw new UnsupportedOperationError("cannot move this Google item");
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
        throw new AlreadyExistsError("Google destination already exists");
      }
    } catch (error) {
      if (error instanceof AmbiguousPathError) {
        throw new AlreadyExistsError("Google destination already exists");
      }
      throw error;
    }
    if (!Array.isArray(item.parents) || item.parents.length !== 1) {
      throw new ProviderError("Google item has invalid parents");
    }
    const params: Record<string, string> = { fields: FIELDS };
    if (item.parents[0] !== parent.id) {
      params.addParents = String(parent.id);
      params.removeParents = String(item.parents[0]);
    }
    const response = await this.#request(
      "PATCH",
      `${API_URL}/${encodeURIComponent(String(item.id))}`,
      {
        operation: "move",
        target: oldPath,
        params,
        json: { name },
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
      throw new UnsupportedOperationError("cannot delete the Google root");
    }
    if (this.#kind(item) === "other") {
      throw new UnsupportedOperationError("cannot delete this Google item");
    }
    if (this.#kind(item) === "directory") {
      const children = this.#pages(String(item.id));
      try {
        const first = await children.next();
        if (!first.done) {
          throw new DirectoryNotEmptyError("Google directory is not empty");
        }
      } finally {
        await children.return(undefined);
      }
    }
    await this.#request(
      "PATCH",
      `${API_URL}/${encodeURIComponent(String(item.id))}`,
      {
        operation: "delete",
        target: path,
        json: { trashed: true },
        params: { fields: "id,trashed" },
        mutation: true,
      },
    );
  }

  async write(
    path: string,
    data: UploadSource,
    options: WriteOptions = {},
  ): Promise<StorageEntry> {
    const overwrite = options.overwrite ?? false;
    const expectedVersion = options.expected_version ?? null;
    if (expectedVersion !== null && !overwrite) {
      throw new InvalidArgumentError(
        "expected_version requires overwrite=true",
      );
    }
    if (expectedVersion !== null) {
      throw new UnsupportedOperationError(
        "Google conditional replacement is unverified",
      );
    }
    const total = data instanceof Uint8Array ? data.length : options.size;
    if (
      data instanceof Uint8Array &&
      options.size !== undefined &&
      options.size !== null &&
      options.size !== total
    ) {
      throw new InvalidUploadSourceError("byte count differs from size");
    }
    if (
      !Number.isSafeInteger(total) ||
      total === undefined ||
      total === null ||
      total < 0
    ) {
      throw new InvalidUploadSourceError("stream requires a nonnegative size");
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
        throw new AlreadyExistsError("Google destination already exists");
      }
      throw error;
    }
    if (existing) {
      if (!overwrite) {
        throw new AlreadyExistsError("Google destination already exists");
      }
      this.#requireFile(existing);
    }
    const metadata: Metadata = existing
      ? {}
      : {
          name,
          parents: [parent.id],
          mimeType: BINARY_MIME,
        };
    let result: Metadata;
    if (total === 0) {
      await source.ensureEnd();
      let response: Response;
      if (!existing) {
        response = await this.#request("POST", API_URL, {
          operation: "write",
          target: path,
          params: { fields: FIELDS },
          json: metadata,
          expected: [200, 201],
          mutation: true,
        });
      } else {
        response = await this.#request(
          "PATCH",
          `${UPLOAD_URL}/${encodeURIComponent(String(existing.id))}`,
          {
            operation: "write",
            target: path,
            params: { uploadType: "media", fields: FIELDS },
            headers: { "Content-Type": BINARY_MIME },
            body: new Uint8Array(),
            mutation: true,
          },
        );
      }
      result = await this.#jsonObject(response);
    } else {
      const uploadUrl = existing
        ? `${UPLOAD_URL}/${encodeURIComponent(String(existing.id))}`
        : UPLOAD_URL;
      const response = await this.#request(
        existing ? "PATCH" : "POST",
        uploadUrl,
        {
          operation: "write",
          target: path,
          params: { uploadType: "resumable", fields: FIELDS },
          json: metadata,
          headers: {
            "X-Upload-Content-Type": BINARY_MIME,
            "X-Upload-Content-Length": String(total),
          },
          mutation: true,
        },
      );
      const session = response.headers.get("Location");
      if (!session || !this.#validSessionUrl(session)) {
        throw new IndeterminateOperationError(
          "Google upload session was not returned",
          {
            operation: "write",
            target: path,
            provider: "gdrive",
          },
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
      for await (const item of this.#pages(String(parent.id), name)) {
        ids.push(String(item.id));
      }
      if (ids.length > 1) {
        throw new ConflictError("Google creation raced with another item", {
          operation: "write",
          target: normalized,
          provider: "gdrive",
          item_ids: ids,
        });
      }
    }
    return entry;
  }

  #validSessionUrl(session: string): boolean {
    try {
      const url = new URL(session);
      return (
        url.protocol === "https:" &&
        (url.hostname === "googleapis.com" ||
          url.hostname.endsWith(".googleapis.com"))
      );
    } catch {
      return false;
    }
  }

  async #cancelUpload(session: string): Promise<void> {
    try {
      await this.#fetch(session, { method: "DELETE" });
    } catch {
      /* best effort */
    }
  }

  #acknowledged(response: Response): number {
    const value = response.headers.get("Range");
    if (!value) return 0;
    const match = /^bytes=0-(\d+)$/.exec(value);
    if (!match) {
      throw new IndeterminateOperationError(
        "Google upload acknowledged an invalid range",
      );
    }
    return Number(match[1]) + 1;
  }

  async #uploadStatus(
    session: string,
    total: number,
  ): Promise<[number, Metadata | null]> {
    let response: Response;
    try {
      response = await this.#fetch(session, {
        method: "PUT",
        headers: { "Content-Range": `bytes */${total}` },
        body: new Uint8Array(),
      });
    } catch {
      throw new IndeterminateOperationError(
        "Google upload status is unavailable",
      );
    }
    if (response.status === 200 || response.status === 201) {
      return [total, await this.#jsonObject(response)];
    }
    if (response.status === 308) {
      return [this.#acknowledged(response), null];
    }
    if (response.status === 404) {
      throw new IndeterminateOperationError(
        "Google upload session expired before completion",
      );
    }
    throw await this.#error(response, "write", undefined, true);
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
      const [acknowledged, completed] = await this.#putFragment(
        session,
        fragment,
        offset,
        total,
      );
      if (completed) {
        if (acknowledged !== total) {
          throw new IndeterminateOperationError(
            "Google upload completed before declared size",
          );
        }
        return completed;
      }
      if (acknowledged !== offset + length) {
        throw new IndeterminateOperationError(
          "Google upload did not acknowledge its fragment",
        );
      }
      offset = acknowledged;
    }
    const [acknowledged, completed] = await this.#uploadStatus(session, total);
    if (acknowledged === total && completed) return completed;
    throw new IndeterminateOperationError(
      "Google upload completion is unknown",
    );
  }

  async #putFragment(
    session: string,
    initial: Uint8Array,
    initialStart: number,
    total: number,
  ): Promise<[number, Metadata | null]> {
    let start = initialStart;
    let fragment = initial;
    const end = initialStart + initial.length;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response | null;
      try {
        response = await this.#fetch(session, {
          method: "PUT",
          headers: {
            "Content-Type": BINARY_MIME,
            "Content-Range": `bytes ${start}-${end - 1}/${total}`,
          },
          body: new Uint8Array(fragment),
        });
      } catch {
        response = null;
      }
      if (response) {
        if (response.status === 200 || response.status === 201) {
          return [total, await this.#jsonObject(response)];
        }
        if (response.status === 308) {
          const acknowledged = this.#acknowledged(response);
          if (acknowledged === end) return [acknowledged, null];
          if (acknowledged < start || acknowledged > end) {
            throw new IndeterminateOperationError(
              "Google upload acknowledged an unexpected range",
            );
          }
          fragment = fragment.subarray(acknowledged - start);
          start = acknowledged;
          continue;
        }
        if (![429, 500, 502, 503, 504].includes(response.status)) {
          throw await this.#error(response, "write", undefined, true);
        }
      }
      const [acknowledged, completed] = await this.#uploadStatus(
        session,
        total,
      );
      if (completed) return [acknowledged, completed];
      if (acknowledged === end) return [acknowledged, null];
      if (acknowledged < start || acknowledged > end) {
        throw new IndeterminateOperationError(
          "Google upload status has an unexpected range",
        );
      }
      fragment = fragment.subarray(acknowledged - start);
      start = acknowledged;
    }
    throw new IndeterminateOperationError("Google upload retry limit reached");
  }
}
