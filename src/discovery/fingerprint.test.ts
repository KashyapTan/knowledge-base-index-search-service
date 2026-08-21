import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fingerprintFile,
  fingerprintMetadata,
  metadataMatches,
  safeFileError,
} from "./fingerprint.ts";
import { formatForExtension } from "./formats.ts";

let fixture = "";

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "kbiss-fingerprint-")));
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe("streamed fingerprints", () => {
  test("hashes a large file in multiple chunks without retaining its contents", async () => {
    const path = join(fixture, "large.txt");
    await writeFile(path, "abc123\n".repeat(30_000));
    const canonical = await realpath(path);
    const result = await fingerprintFile(path, canonical, formatForExtension(".txt"));
    expect(result.status).toBe("ready");
    expect(result.chunksRead).toBeGreaterThan(1);
    expect(result.fingerprint.size).toBe(210_000);
    expect(result.fingerprint.contentHash).toHaveLength(64);
  });

  test("classifies invalid UTF-8 and binary NUL data per file", async () => {
    const invalid = join(fixture, "invalid.md");
    const binary = join(fixture, "binary.data");
    await writeFile(invalid, new Uint8Array([0xc3, 0x28]));
    await writeFile(binary, new Uint8Array([65, 0, 66]));
    const invalidResult = await fingerprintFile(
      invalid,
      await realpath(invalid),
      formatForExtension(".md"),
    );
    const binaryResult = await fingerprintFile(binary, await realpath(binary));
    expect(invalidResult).toMatchObject({
      status: "malformed",
      descriptor: { format: "markdown" },
    });
    expect(binaryResult).toMatchObject({
      status: "unsupported",
      descriptor: { format: "unknown" },
    });
  });

  test("detects a canonicalization race before reading a retargeted symlink", async () => {
    const first = join(fixture, "first.txt");
    const second = join(fixture, "second.txt");
    const link = join(fixture, "current.txt");
    await writeFile(first, "first");
    await writeFile(second, "second");
    await symlink(first, link);
    const expected = await realpath(link);
    await unlink(link);
    await symlink(second, link);
    await expect(fingerprintFile(link, expected)).rejects.toThrow("target changed");
  });

  test("compares portable metadata while preserving local filesystem identity", async () => {
    const path = join(fixture, "meta.txt");
    await writeFile(path, "metadata");
    const stats = await stat(path, { bigint: true });
    const first = fingerprintMetadata(stats, "hash");
    expect(first.deviceId).toBe(stats.dev.toString());
    expect(first.inode).toBe(stats.ino.toString());
    expect(metadataMatches(first, { ...first })).toBe(true);
    expect(metadataMatches(first, { ...first, size: first.size + 1 })).toBe(false);
  });

  test("maps filesystem failures to display-safe summaries", () => {
    expect(safeFileError(Object.assign(new Error("secret"), { code: "EACCES" }))).toBe(
      "The file is not readable.",
    );
    expect(safeFileError(Object.assign(new Error("secret"), { code: "ENOENT" }))).toContain(
      "disappeared",
    );
    expect(safeFileError(Object.assign(new Error("secret"), { code: "ELOOP" }))).toContain("cycle");
    expect(safeFileError(new Error("secret path"))).toBe("The file could not be inspected.");
  });
});
