import { createHash } from "node:crypto";
import { isAbsolute, posix, relative } from "node:path";

export function normalizeRelativePath(root: string, absolutePath: string): string | undefined {
  const candidate = relative(root, absolutePath).replaceAll("\\", "/").normalize("NFC");
  if (!candidate || candidate === ".." || candidate.startsWith("../") || isAbsolute(candidate)) {
    return undefined;
  }
  const normalized = posix.normalize(candidate);
  return normalized === ".." || normalized.startsWith("../") ? undefined : normalized;
}

export function createFileId(rootIdentity: string, relativePath: string): string {
  return createHash("sha256")
    .update(`file-v1\0${rootIdentity}\0${relativePath}`, "utf8")
    .digest("hex");
}
