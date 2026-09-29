import {
  AlreadyExistsError,
  AmbiguousPathError,
  ConflictError,
  DirectoryNotEmptyError,
  FileStorage,
  InvalidArgumentError,
  InvalidPathError,
  InvalidUploadSourceError,
  IsDirectoryError,
  ItemRef,
  NotDirectoryError,
  NotFoundError,
  RefScope,
  UnsupportedOperationError,
  normalize_path,
  split_parent,
} from "@pydemia/drivefs";

export class FakeStorage extends FileStorage {
  constructor({ page_size = 2 } = {}) {
    super();
    this.scope = new RefScope();
    this.nodes = new Map([["root", this._node("root", null, "", "directory")]]);
    this.page_size = page_size;
    this.stat_failure = null;
    this.list_failure_after_page = null;
    this.closed_readers = 0;
  }

  get capabilities() {
    return { conditional_replace: true };
  }

  _node(id, parent, name, kind, content = new Uint8Array()) {
    return { id, parent, name, kind, content, version: 1, trashed: false };
  }

  fail_next_stat(error) {
    this.stat_failure = error;
  }

  fail_list_after_page(error) {
    this.list_failure_after_page = error;
  }

  inject(path, { kind = "file", content = new Uint8Array() } = {}) {
    const [parent_path, name] = split_parent(path);
    const parent = this._resolve(parent_path);
    this._require_directory(parent);
    const id = crypto.randomUUID();
    const node = this._node(id, parent.id, name, kind, content);
    this.nodes.set(id, node);
    return this._entry(node);
  }

  detach(ref) {
    const [id] = this.scope.resolve(ref);
    this.nodes.get(id).parent = null;
  }

  _children(parent_id) {
    return [...this.nodes.values()].filter(
      (node) => node.parent === parent_id && !node.trashed,
    );
  }

  _within_root(node) {
    const seen = new Set();
    while (node.id !== "root") {
      if (seen.has(node.id) || node.parent === null || node.trashed) {
        return false;
      }
      seen.add(node.id);
      node = this.nodes.get(node.parent);
      if (!node) return false;
    }
    return true;
  }

  _resolve(target) {
    if (target instanceof ItemRef) {
      const [id] = this.scope.resolve(target);
      const node = this.nodes.get(id);
      if (!node || !this._within_root(node)) {
        throw new NotFoundError("item is outside this storage root");
      }
      return node;
    }
    const path = normalize_path(target);
    let node = this.nodes.get("root");
    if (path === "/") return node;
    for (const name of path.slice(1).split("/")) {
      this._require_directory(node);
      const matches = this._children(node.id).filter(
        (child) => child.name === name,
      );
      if (matches.length === 0) {
        throw new NotFoundError("path does not exist", { target: path });
      }
      if (matches.length > 1) {
        throw new AmbiguousPathError("path matches multiple items", {
          target: path,
          item_ids: matches.map((child) => child.id),
        });
      }
      node = matches[0];
    }
    return node;
  }

  _path(node) {
    const parts = [];
    while (node.id !== "root") {
      parts.push(node.name);
      if (node.parent === null) {
        throw new NotFoundError("item is outside this storage root");
      }
      node = this.nodes.get(node.parent);
    }
    return `/${parts.reverse().join("/")}`;
  }

  _entry(node) {
    return {
      ref: this.scope.make(node.id),
      id: node.id,
      path: this._path(node),
      name: node.name,
      kind: node.kind,
      size: node.kind === "file" ? node.content.length : null,
      modified_at: null,
      mime_type: null,
      version: node.kind === "file" ? String(node.version) : null,
    };
  }

  _require_directory(node) {
    if (node.kind !== "directory") {
      throw new NotDirectoryError("item is not a directory");
    }
  }

  _require_file(node) {
    if (node.kind === "directory") {
      throw new IsDirectoryError("item is a directory");
    }
    if (node.kind === "other") {
      throw new UnsupportedOperationError("item is not a binary file");
    }
  }

  async stat(target) {
    if (this.stat_failure) {
      const error = this.stat_failure;
      this.stat_failure = null;
      throw error;
    }
    return this._entry(this._resolve(target));
  }

  async *list(target) {
    const node = this._resolve(target);
    this._require_directory(node);
    const children = this._children(node.id);
    for (let index = 0; index < children.length; index += this.page_size) {
      if (index && this.list_failure_after_page) {
        const error = this.list_failure_after_page;
        this.list_failure_after_page = null;
        throw error;
      }
      for (const child of children.slice(index, index + this.page_size)) {
        yield this._entry(child);
      }
    }
  }

  async read(target) {
    const node = this._resolve(target);
    this._require_file(node);
    return node.content;
  }

  async *open_reader(target, signal) {
    try {
      const bytes = await this.read(target);
      if (signal?.aborted) throw signal.reason;
      yield bytes;
    } finally {
      this.closed_readers += 1;
    }
  }

  async read_range(target, offset, length) {
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
    const bytes = await this.read(target);
    return bytes.slice(offset, offset + length);
  }

  async _upload_bytes(data, size) {
    if (data instanceof Uint8Array) {
      if (size !== null && size !== undefined && size !== data.length) {
        throw new InvalidUploadSourceError("byte count differs from size");
      }
      return data;
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new InvalidUploadSourceError("stream requires a nonnegative size");
    }
    const chunks = [];
    let count = 0;
    for await (const chunk of data) {
      if (!(chunk instanceof Uint8Array)) {
        throw new InvalidUploadSourceError("stream must return bytes");
      }
      count += chunk.length;
      if (count > size) {
        throw new InvalidUploadSourceError("stream exceeds declared size");
      }
      chunks.push(chunk);
    }
    if (count !== size) {
      throw new InvalidUploadSourceError("stream is shorter than size");
    }
    const result = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  async write(path, data, options = {}) {
    const { overwrite = false, expected_version = null, size = null } = options;
    if (expected_version !== null && !overwrite) {
      throw new InvalidArgumentError(
        "expected_version requires overwrite=true",
      );
    }
    const [parent_path, name] = split_parent(path);
    const content = await this._upload_bytes(data, size);
    const parent = this._resolve(parent_path);
    this._require_directory(parent);
    const matches = this._children(parent.id).filter(
      (child) => child.name === name,
    );
    if (matches.length > 1) {
      throw new AmbiguousPathError("destination is ambiguous");
    }
    if (matches.length) {
      if (!overwrite) {
        throw new AlreadyExistsError("destination exists");
      }
      const node = matches[0];
      this._require_file(node);
      if (
        expected_version !== null &&
        expected_version !== String(node.version)
      ) {
        throw new ConflictError("version differs");
      }
      node.content = content;
      node.version += 1;
      return this._entry(node);
    }
    if (expected_version !== null) {
      throw new NotFoundError("replace target does not exist");
    }
    return this.inject(path, { content });
  }

  async mkdir(path) {
    const [parent_path, name] = split_parent(path);
    const parent = this._resolve(parent_path);
    this._require_directory(parent);
    if (this._children(parent.id).some((child) => child.name === name)) {
      throw new AlreadyExistsError("destination exists");
    }
    return this.inject(path, { kind: "directory" });
  }

  async move(target, destination) {
    const node = this._resolve(target);
    if (node.id === "root") {
      throw new UnsupportedOperationError("cannot move the root");
    }
    if (node.kind === "other") {
      throw new UnsupportedOperationError("cannot move this item kind");
    }
    const [parent_path, name] = split_parent(destination);
    const parent = this._resolve(parent_path);
    this._require_directory(parent);
    if (parent.id === node.id || this._is_descendant(parent, node)) {
      throw new InvalidPathError("cannot move into own descendant");
    }
    if (this._children(parent.id).some((child) => child.name === name)) {
      throw new AlreadyExistsError("destination exists");
    }
    node.parent = parent.id;
    node.name = name;
    return this._entry(node);
  }

  _is_descendant(candidate, ancestor) {
    while (candidate.parent !== null) {
      if (candidate.parent === ancestor.id) return true;
      candidate = this.nodes.get(candidate.parent);
    }
    return false;
  }

  async delete(target) {
    const node = this._resolve(target);
    if (node.id === "root") {
      throw new UnsupportedOperationError("cannot delete the root");
    }
    if (node.kind === "other") {
      throw new UnsupportedOperationError("cannot delete this item kind");
    }
    if (node.kind === "directory" && this._children(node.id).length) {
      throw new DirectoryNotEmptyError("directory is not empty");
    }
    node.trashed = true;
  }
}
