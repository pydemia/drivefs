import { NotFoundError } from "./errors.js";

export type EntryKind = "file" | "directory" | "other";

const ref_data = new WeakMap<
  ItemRef,
  { owner: symbol; native_id: string; container_id: string | null }
>();

export class ItemRef {
  /** Callers should retain but not construct or serialize refs. */
  constructor() {}

  toString(): string {
    return "ItemRef(<opaque>)";
  }
}

export interface StorageEntry {
  ref: ItemRef;
  id: string;
  path: string;
  name: string;
  kind: EntryKind;
  size: number | null;
  modified_at: Date | null;
  mime_type: string | null;
  version: string | null;
}

export interface StorageCapabilities {
  conditional_replace: boolean;
}

export class RefScope {
  readonly #owner = Symbol("storage instance");

  make(native_id: string, container_id: string | null = null): ItemRef {
    const ref = new ItemRef();
    ref_data.set(ref, { owner: this.#owner, native_id, container_id });
    return ref;
  }

  resolve(ref: ItemRef): [string, string | null] {
    const data = ref_data.get(ref);
    if (!data || data.owner !== this.#owner) {
      throw new NotFoundError("reference belongs to another storage");
    }
    return [data.native_id, data.container_id];
  }
}
