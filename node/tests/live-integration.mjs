// Opt-in real-account check. This file is intentionally excluded from npm test.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash, randomUUID } from "node:crypto";
import {
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { GoogleAuth, GoogleDriveStorage } from "@pydemia/drivefs-gdrive";
import {
  GraphAuth,
  OneDriveStorage,
  SharePointStorage,
} from "@pydemia/drivefs-microsoft";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LARGE_SIZE = 4 * 1024 * 1024 + 17;

function required(value, label) {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

export class PrivateConfig {
  static async load(path) {
    const actual = await realpath(path);
    const inside = relative(REPO_ROOT, actual);
    if (
      inside === "" ||
      (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
    ) {
      throw new Error("live config must be outside the repository");
    }
    const details = await stat(actual);
    if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
      throw new Error("live config must be readable only by its owner");
    }
    const data = JSON.parse(await readFile(actual, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("live config must be a JSON object");
    }
    const provider = required(data.provider, "provider");
    if (!["gdrive", "onedrive", "sharepoint"].includes(provider)) {
      throw new Error("provider must be gdrive, onedrive, or sharepoint");
    }
    required(data.root_id, "root_id");
    required(data.client_id, "client_id");
    if (provider === "gdrive") {
      required(data.client_secret, "client_secret");
    } else {
      required(data.drive_id, "drive_id");
      required(data.tenant_id, "tenant_id");
      if (provider === "onedrive" && data.tenant_id !== "consumers") {
        throw new Error("OneDrive Personal requires tenant_id=consumers");
      }
      if (provider === "sharepoint") {
        required(data.site_id, "site_id");
        if (["common", "consumers"].includes(data.tenant_id)) {
          throw new Error("SharePoint requires a tenant-specific ID");
        }
      }
    }
    if (
      !data.token ||
      typeof data.token !== "object" ||
      Array.isArray(data.token)
    ) {
      throw new Error("token must be a JSON object");
    }
    required(data.token.access_token, "token.access_token");
    required(data.token.refresh_token, "token.refresh_token");
    return new PrivateConfig(actual, data);
  }

  constructor(path, data) {
    this.path = path;
    this.data = data;
    this.provider = data.provider;
    this.saveCount = 0;
  }

  load() {
    return {
      ...this.data.token,
      // Force an actual refresh before the first provider request.
      expires_at: this.saveCount
        ? this.data.token.expires_at
        : Date.now() - 60_000,
    };
  }

  async save(token) {
    const replacement = {
      ...this.data,
      token: {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: token.expires_at,
      },
    };
    const temporary = resolve(
      dirname(this.path),
      `.drivefs-live-${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(
          `${JSON.stringify(replacement, null, 2)}\n`,
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    this.data = replacement;
    this.saveCount += 1;
  }
}

function storageFor(config) {
  const data = config.data;
  if (config.provider === "gdrive") {
    return new GoogleDriveStorage({
      rootId: data.root_id,
      auth: new GoogleAuth({
        store: config,
        client_id: data.client_id,
        client_secret: data.client_secret,
      }),
    });
  }
  const auth = new GraphAuth({
    store: config,
    tenant_id: data.tenant_id,
    client_id: data.client_id,
    client_secret: data.client_secret,
    scopes: data.scopes,
  });
  if (config.provider === "onedrive") {
    return new OneDriveStorage({
      driveId: data.drive_id,
      rootId: data.root_id,
      auth,
    });
  }
  return new SharePointStorage({
    siteId: data.site_id,
    driveId: data.drive_id,
    rootId: data.root_id,
    auth,
  });
}

async function names(storage, path) {
  const result = [];
  for await (const entry of storage.list(path)) result.push(entry.name);
  return result.sort();
}

async function* chunks(payload) {
  for (let offset = 0; offset < payload.length; offset += 128 * 1024) {
    yield payload.subarray(offset, offset + 128 * 1024);
  }
}

export async function check(storage, config) {
  assert.equal((await storage.stat("/")).kind, "directory");
  assert.ok(config.saveCount >= 1, "token refresh was not persisted");
  const scratch = `/drivefs-live-${randomUUID()}`;
  assert.equal(await storage.exists(scratch), false);
  console.log(`SCRATCH ${scratch}`);
  try {
    const folder = await storage.mkdir(scratch);
    assert.equal(folder.kind, "directory");
    const small = await storage.write(
      `${scratch}/small.bin`,
      Buffer.from("first"),
    );
    assert.equal(
      Buffer.from(await storage.read(small.ref)).toString(),
      "first",
    );
    assert.equal(
      Buffer.from(await storage.read_range(small.ref, 1, 3)).toString(),
      "irs",
    );
    assert.deepEqual(await names(storage, scratch), ["small.bin"]);
    const replacement = await storage.write(
      `${scratch}/small.bin`,
      Buffer.from("second"),
      {
        overwrite: true,
      },
    );
    assert.equal(
      Buffer.from(await storage.read(replacement.ref)).toString(),
      "second",
    );
    const moved = await storage.move(replacement.ref, `${scratch}/moved.bin`);
    assert.equal((await storage.stat(moved.ref)).path, `${scratch}/moved.bin`);
    assert.equal(await storage.exists(`${scratch}/small.bin`), false);

    const payload = Buffer.allocUnsafe(LARGE_SIZE);
    for (let index = 0; index < payload.length; index += 1)
      payload[index] = index % 256;
    const large = await storage.write(`${scratch}/large.bin`, chunks(payload), {
      size: payload.length,
    });
    assert.equal(large.size, payload.length);
    assert.deepEqual(
      Buffer.from(await storage.read_range(large.ref, 1023, 4097)),
      payload.subarray(1023, 5120),
    );
    const digest = createHash("sha256");
    for await (const chunk of storage.open_reader(large.ref))
      digest.update(chunk);
    assert.deepEqual(
      digest.digest(),
      createHash("sha256").update(payload).digest(),
    );
    assert.deepEqual(await names(storage, scratch), ["large.bin", "moved.bin"]);
  } finally {
    // Only the UUID directory created by this run is eligible for cleanup.
    if (await storage.exists(scratch)) {
      for await (const item of storage.list(scratch))
        await storage.delete(item.ref);
      await storage.delete(scratch);
    }
  }
  assert.equal(await storage.exists(scratch), false);
}

async function main() {
  const path = process.env.DRIVEFS_LIVE_CONFIG;
  if (!path) throw new Error("DRIVEFS_LIVE_CONFIG is required");
  const config = await PrivateConfig.load(path);
  await check(storageFor(config), config);
  console.log(
    `PASS node ${config.provider}: refresh, lifecycle, large stream, cleanup`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`FAIL node ${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}
