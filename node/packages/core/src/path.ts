import { InvalidPathError } from "./errors.js";

export function normalize_path(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new InvalidPathError("path must be a nonempty string");
  }
  if (path.includes("\\") || path.includes("\0")) {
    throw new InvalidPathError("path contains an invalid character");
  }
  const components: string[] = [];
  for (const component of path.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      throw new InvalidPathError("parent traversal is not allowed");
    }
    components.push(component);
  }
  return `/${components.join("/")}`;
}

export function split_parent(path: string): [string, string] {
  const normalized = normalize_path(path);
  if (normalized === "/") {
    throw new InvalidPathError("the root has no parent");
  }
  const index = normalized.lastIndexOf("/");
  return [normalized.slice(0, index) || "/", normalized.slice(index + 1)];
}
