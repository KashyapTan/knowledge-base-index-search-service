import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredFile, FileChange } from "./contracts.ts";
import { JsonFileManifest } from "./manifest.ts";

let fixture = "";
const rootIdentity = "root-identity";

function record(relativePath: string): DiscoveredFile {
  return {
    fileId: `id-${relativePath}`,
    rootIdentity,
    relativePath,
    canonicalPath: `/source/${relativePath}`,
    filename: relativePath.split("/").at(-1) ?? relativePath,
    extension: ".txt",
    format: "text",
    mimeFamily: "text/plain",
    fingerprint: {
      size: 4,
      modifiedAtMs: 1,
      modifiedAtNs: "1000000",
      changedAtNs: "1000000",
      timestampPrecisionMs: 1,
      contentHash: "hash",
    },
    readStatus: "ready",
    indexStatus: "pending",
  };
}

function change(file: DiscoveredFile): FileChange {
  return {
    kind: "added",
    source: "scan",
    fileId: file.fileId,
    relativePath: file.relativePath,
    current: file,
  };
}

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "kbiss-manifest-")));
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe("JSON file manifest", () => {
  test("atomically persists a stable snapshot and notifies current subscribers", async () => {
    const path = join(fixture, "metadata", "manifest.json");
    const opened = await JsonFileManifest.open(path, rootIdentity);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const received: FileChange[][] = [];
    const unsubscribe = opened.value.subscribe((changes) => received.push([...changes]));
    const later = record("z.txt");
    const earlier = record("a.txt");
    expect(await opened.value.replace([later, earlier], [change(later)])).toEqual({
      ok: true,
      value: undefined,
    });
    expect(opened.value.snapshot().map((file) => file.relativePath)).toEqual(["a.txt", "z.txt"]);
    expect(opened.value.get(later.fileId)).toEqual(later);
    expect(received).toHaveLength(1);
    unsubscribe();
    await opened.value.replace([earlier], []);
    expect(received).toHaveLength(1);

    const reloaded = await JsonFileManifest.open(path, rootIdentity);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value.snapshot()).toEqual([earlier]);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  test("promotes a complete pending manifest left by an interrupted rename", async () => {
    const path = join(fixture, "manifest.json");
    const pending = {
      version: 1,
      rootIdentity,
      files: [record("recovered.txt")],
    };
    await writeFile(`${path}.pending`, JSON.stringify(pending));
    const opened = await JsonFileManifest.open(path, rootIdentity);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.value.snapshot()[0]?.relativePath).toBe("recovered.txt");
    expect(await Bun.file(path).exists()).toBe(true);
    expect(await Bun.file(`${path}.pending`).exists()).toBe(false);
  });

  test("keeps a valid committed manifest and discards a partial pending write", async () => {
    const path = join(fixture, "manifest.json");
    const first = await JsonFileManifest.open(path, rootIdentity);
    if (!first.ok) throw new Error(first.error.message);
    await first.value.replace([record("committed.txt")], []);
    await writeFile(`${path}.pending`, '{"version":1');
    const reopened = await JsonFileManifest.open(path, rootIdentity);
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.value.snapshot()[0]?.relativePath).toBe("committed.txt");
    expect(await Bun.file(`${path}.pending`).exists()).toBe(false);
  });

  test("recovers corrupt state as an empty snapshot for full reconciliation", async () => {
    const path = join(fixture, "manifest.json");
    await writeFile(path, "not-json");
    await writeFile(`${path}.pending`, "partial");
    const opened = await JsonFileManifest.open(path, rootIdentity);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.value.snapshot()).toEqual([]);
  });

  test("returns structured read and write failures", async () => {
    const blocker = join(fixture, "blocker");
    await writeFile(blocker, "file");
    const unreadable = await JsonFileManifest.open(join(blocker, "manifest.json"), rootIdentity);
    expect(unreadable).toMatchObject({ ok: false, error: { code: "MANIFEST_READ_FAILED" } });

    const directory = join(fixture, "writable");
    await mkdir(directory);
    const path = join(directory, "manifest.json");
    const opened = await JsonFileManifest.open(path, rootIdentity);
    if (!opened.ok) throw new Error(opened.error.message);
    await rm(directory, { recursive: true });
    await writeFile(directory, "now a file");
    const result = await opened.value.replace([record("file.txt")], []);
    expect(result).toMatchObject({ ok: false, error: { code: "MANIFEST_WRITE_FAILED" } });
  });
});
