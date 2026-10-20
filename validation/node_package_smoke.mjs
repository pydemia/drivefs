/** Public imports from installed npm tarballs, with no workspace links. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const core = await import("@pydemia/drivefs");
const corePackage = JSON.parse(
  readFileSync("./node_modules/@pydemia/drivefs/package.json", "utf8"),
);
assert.deepEqual(corePackage.dependencies ?? {}, {});
assert.equal(core.normalize_path("notes/./file"), "/notes/file");

if (process.argv[2] === "core") {
  console.log("core tarball: import, API, no runtime dependencies OK");
  process.exit(0);
}
if (process.argv[2] === "gdrive" || process.argv[2] === "microsoft") {
  const selected = process.argv[2];
  await import(`@pydemia/drivefs-${selected}`);
  const other = selected === "gdrive" ? "microsoft" : "gdrive";
  assert.equal(existsSync(`./node_modules/@pydemia/drivefs-${other}`), false);
  console.log(`${selected} tarball: selected plugin and core only OK`);
  process.exit(0);
}
assert.equal(process.argv[2], "full");

const google = await import("@pydemia/drivefs-gdrive");
const graph = await import("@pydemia/drivefs-microsoft");
for (const name of ["drivefs-gdrive", "drivefs-microsoft"]) {
  const manifest = JSON.parse(
    readFileSync(`./node_modules/@pydemia/${name}/package.json`, "utf8"),
  );
  assert.deepEqual(Object.keys(manifest.dependencies), ["@pydemia/drivefs"]);
}

const bytes = new TextEncoder().encode("abcdefghij");
let driveType = "personal";
let signedAuthorizationSeen = false;
function json(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function fixture(input, init = {}) {
  const url = new URL(input);
  const path = url.pathname;
  const headers = new Headers(init.headers);
  if (url.hostname === "download.example") {
    if (headers.has("Authorization")) signedAuthorizationSeen = true;
    const range = headers.get("Range");
    if (range) {
      const [start, requestedEnd] = range
        .replace("bytes=", "")
        .split("-")
        .map(Number);
      const end = Math.min(requestedEnd, bytes.length - 1);
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/${bytes.length}` },
      });
    }
    return new Response(bytes);
  }
  if (url.hostname === "www.googleapis.com") {
    const root = {
      id: "root",
      name: "root",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["my-drive"],
      trashed: false,
    };
    const item = {
      id: "file",
      name: "data.bin",
      mimeType: "application/octet-stream",
      size: String(bytes.length),
      parents: ["root"],
      trashed: false,
    };
    if (path === "/drive/v3/files/root") return json(root);
    if (path === "/drive/v3/files") return json({ files: [item] });
    if (path === "/drive/v3/files/file") {
      if (url.searchParams.get("alt") === "media") {
        const range = headers.get("Range");
        if (!range) return new Response(bytes);
        const [start, requestedEnd] = range
          .replace("bytes=", "")
          .split("-")
          .map(Number);
        const end = Math.min(requestedEnd, bytes.length - 1);
        return new Response(bytes.slice(start, end + 1), {
          status: 206,
          headers: { "Content-Range": `bytes ${start}-${end}/${bytes.length}` },
        });
      }
      return json(item);
    }
  }
  if (url.hostname === "graph.microsoft.com") {
    if (path === "/v1.0/sites/site/drives") {
      return json({ value: [{ id: "drive" }] });
    }
    if (path === "/v1.0/drives/drive") return json({ driveType });
    if (path === "/v1.0/drives/drive/items/root") {
      return json({
        id: "root",
        name: "root",
        folder: {},
        sharepointIds: { siteId: "site" },
      });
    }
    if (path === "/v1.0/drives/drive/items/root/children") {
      return json({
        value: [
          {
            id: "file",
            name: "data.bin",
            file: { mimeType: "application/octet-stream" },
            size: bytes.length,
            parentReference: { id: "root", driveId: "drive" },
          },
        ],
      });
    }
    if (path === "/v1.0/drives/drive/items/file/content") {
      return new Response(null, {
        status: 302,
        headers: { Location: "https://download.example/file" },
      });
    }
  }
  throw new Error(`unexpected fixture request: ${url.hostname} ${path}`);
}

const gdrive = new google.GoogleDriveStorage({
  rootId: "root",
  auth: new google.GoogleAuth({
    store: new google.MemoryCredentialStore({ access_token: "token" }),
  }),
  fetch: fixture,
});
assert.equal((await gdrive.stat("/data.bin")).kind, "file");
assert.equal(
  new TextDecoder().decode(await gdrive.read_range("/data.bin", 2, 3)),
  "cde",
);

const personal = new graph.OneDriveStorage({
  driveId: "drive",
  rootId: "root",
  auth: new graph.GraphAuth({
    tenant_id: "consumers",
    client_id: "client",
    store: new graph.MemoryCredentialStore({ access_token: "token" }),
  }),
  fetch: fixture,
});
assert.equal((await personal.stat("/data.bin")).size, bytes.length);
assert.equal(
  new TextDecoder().decode(await personal.read_range("/data.bin", 1, 3)),
  "bcd",
);

driveType = "documentLibrary";
const sharepoint = new graph.SharePointStorage({
  siteId: "site",
  driveId: "drive",
  rootId: "root",
  auth: new graph.GraphAuth({
    tenant_id: "tenant",
    client_id: "client",
    store: new graph.MemoryCredentialStore({ access_token: "token" }),
  }),
  fetch: fixture,
});
assert.equal((await sharepoint.stat("/data.bin")).kind, "file");
assert.equal(
  new TextDecoder().decode(await sharepoint.read_range("/data.bin", 3, 2)),
  "de",
);
assert.equal(signedAuthorizationSeen, false);
console.log("three tarballs: public provider API and dependency layers OK");
