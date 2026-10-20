import { NotFoundError } from "./errors.js";
import type { ItemRef, StorageCapabilities, StorageEntry } from "./model.js";

export type StorageTarget = string | ItemRef;
export type UploadSource = Uint8Array | AsyncIterable<Uint8Array>;

export interface WriteOptions {
  overwrite?: boolean;
  expected_version?: string | null;
  size?: number | null;
}

export abstract class FileStorage {
  abstract get capabilities(): StorageCapabilities;
  abstract stat(target: StorageTarget): Promise<StorageEntry>;

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
    return true;
  }

  abstract list(target: StorageTarget): AsyncIterable<StorageEntry>;
  abstract read(target: StorageTarget): Promise<Uint8Array>;
  abstract open_reader(
    target: StorageTarget,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array>;
  abstract read_range(
    target: StorageTarget,
    offset: number,
    length: number,
  ): Promise<Uint8Array>;
  abstract write(
    path: string,
    data: UploadSource,
    options?: WriteOptions,
  ): Promise<StorageEntry>;
  abstract mkdir(path: string): Promise<StorageEntry>;
  abstract move(
    target: StorageTarget,
    destination: string,
  ): Promise<StorageEntry>;
  abstract delete(target: StorageTarget): Promise<void>;
}
