/** Install built tarballs outside the checkout and run public API smoke checks. */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactDir = resolve(process.argv[2] ?? "");
if (process.argv.length !== 3) {
  throw new Error("usage: verify_node_artifacts.mjs TARBALL_DIR");
}
const names = {
  core: /^pydemia-drivefs-\d.*\.tgz$/,
  gdrive: /^pydemia-drivefs-gdrive-\d.*\.tgz$/,
  microsoft: /^pydemia-drivefs-microsoft-\d.*\.tgz$/,
};
const tarballs = {};
for (const [name, pattern] of Object.entries(names)) {
  const matches = readdirSync(artifactDir).filter((file) => pattern.test(file));
  if (matches.length !== 1) {
    throw new Error(`expected one ${name} tarball, found ${matches.length}`);
  }
  tarballs[name] = join(artifactDir, matches[0]);
}

function run(command, args, cwd) {
  console.log("+", command, ...args);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.status}`);
}

const npmCli = [
  process.env.npm_execpath,
  join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  join(
    dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  ),
].find((candidate) => candidate && existsSync(candidate));
if (!npmCli) throw new Error("could not locate npm CLI next to Node.js");

const cases = {
  core: ["core"],
  gdrive: ["core", "gdrive"],
  microsoft: ["core", "microsoft"],
  full: ["core", "gdrive", "microsoft"],
};
const temporary = mkdtempSync(join(tmpdir(), "drivefs-node-tarballs-"));
try {
  for (const [name, selected] of Object.entries(cases)) {
    const directory = join(temporary, name);
    const packageJson = {
      name: `drivefs-artifact-smoke-${name}`,
      private: true,
      type: "module",
    };
    mkdirSync(directory);
    writeFileSync(join(directory, "package.json"), JSON.stringify(packageJson));
    copyFileSync(
      join(root, "validation", "node_package_smoke.mjs"),
      join(directory, "node_package_smoke.mjs"),
    );
    run(
      process.execPath,
      [
        npmCli,
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...selected.map((packageName) => tarballs[packageName]),
      ],
      directory,
    );
    run(process.execPath, ["node_package_smoke.mjs", name], directory);
  }
} finally {
  const tempRoot = realpathSync(tmpdir());
  const target = realpathSync(temporary);
  if (
    !target.startsWith(tempRoot + sep) ||
    !basename(target).startsWith("drivefs-node-tarballs-")
  ) {
    throw new Error(`refusing to remove unexpected directory: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}
