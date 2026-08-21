import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredFile } from "../discovery/index.ts";
import { indexableFile } from "../indexing/test-helpers.ts";
import { SafeFileAccess } from "./file-access.ts";
import { MemoryManifest } from "./test-helpers.ts";

let fixtureDir = "";
let root = "";
const rootIdentity = "indexing-test-root";

beforeEach(async () => {
  fixtureDir = await realpath(await mkdtemp(join(tmpdir(), "kbiss-file-api-")));
  root = join(fixtureDir, "root");
  await mkdir(root);
});

afterEach(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

function record(relativePath: string, overrides: Partial<DiscoveredFile> = {}): DiscoveredFile {
  return indexableFile(relativePath, "hash", {
    rootIdentity,
    canonicalPath: join(root, relativePath),
    ...overrides,
  });
}

function access(files: readonly DiscoveredFile[], options = {}) {
  return new SafeFileAccess(
    { identity: rootIdentity, path: root },
    new MemoryManifest(rootIdentity, files),
    options,
  );
}

describe("safe file access", () => {
  test("returns bounded metadata and incrementally streams a regular file", async () => {
    await writeFile(join(root, "notes.txt"), "hello from the repository");
    const file = record("notes.txt");
    const files = access([file]);
    expect(files.metadata(file.fileId)).toMatchObject({
      ok: true,
      value: { fileId: file.fileId, relativePath: "notes.txt" },
    });
    const response = await files.content(file.fileId);
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.value.headers.get("content-length")).toBe("25");
      expect(await response.value.text()).toBe("hello from the repository");
    }
    const cancelled = await files.content(file.fileId);
    if (cancelled.ok) await cancelled.value.body?.cancel();
    expect(files.metadata("f".repeat(64))).toMatchObject({
      ok: false,
      error: { code: "FILE_NOT_FOUND" },
    });
  });

  test("rejects traversal records and mismatched root identities before reading", async () => {
    const traversal = record("../secret.txt");
    const wrongRoot = record("notes.txt", { rootIdentity: "another-root" });
    expect(await access([traversal]).content(traversal.fileId)).toMatchObject({
      ok: false,
      error: { code: "FILE_UNSAFE" },
    });
    expect(await access([wrongRoot]).content(wrongRoot.fileId)).toMatchObject({
      ok: false,
      error: { code: "FILE_UNSAFE" },
    });
  });

  test("rejects symlinks outside the root and detects a symlink swap during open", async () => {
    const outside = join(fixtureDir, "outside.txt");
    await writeFile(outside, "private");
    await symlink(outside, join(root, "link.txt"));
    const linked = record("link.txt");
    expect(await access([linked]).content(linked.fileId)).toMatchObject({
      ok: false,
      error: { code: "FILE_UNSAFE" },
    });

    await unlink(join(root, "link.txt"));
    await writeFile(join(root, "inside.txt"), "safe");
    await symlink(join(root, "inside.txt"), join(root, "link.txt"));
    const swapped = access([linked], {
      beforeOpen: async () => {
        await unlink(join(root, "link.txt"));
        await symlink(outside, join(root, "link.txt"));
      },
    });
    expect(await swapped.content(linked.fileId)).toMatchObject({
      ok: false,
      error: { code: "FILE_UNSAFE" },
    });
  });

  test("handles deletion races, non-files, and oversized files with safe errors", async () => {
    const gone = record("gone.txt");
    expect(await access([gone]).content(gone.fileId)).toMatchObject({
      ok: false,
      error: { code: "FILE_NOT_FOUND" },
    });

    await mkdir(join(root, "folder"));
    const folder = record("folder");
    expect(await access([folder]).content(folder.fileId)).toMatchObject({
      ok: false,
      error: { code: "FILE_NOT_REGULAR" },
    });

    await writeFile(join(root, "large.txt"), "12345");
    const large = record("large.txt");
    expect(await access([large], { maxBytes: 4 }).content(large.fileId)).toMatchObject({
      ok: false,
      error: { code: "FILE_TOO_LARGE" },
    });

    await writeFile(join(root, "racy.txt"), "temporary");
    const racy = record("racy.txt");
    expect(
      await access([racy], { beforeOpen: () => unlink(join(root, "racy.txt")) }).content(
        racy.fileId,
      ),
    ).toMatchObject({ ok: false, error: { code: "FILE_NOT_FOUND" } });
  });
});
