import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { IndexedChunkRecord, IndexedFileRecord } from "./contracts.ts";
import { CHUNKS_TABLE, openLanceIndex } from "./lance-store.ts";
import { indexableFile, indexingConfig } from "./test-helpers.ts";

let fixture = "";

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "kbiss-lance-index-"));
  await Promise.all([
    mkdir(join(fixture, "root")),
    mkdir(join(fixture, "state", "metadata"), { recursive: true }),
    mkdir(join(fixture, "cache")),
  ]);
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

function fileRecord(contentHash = "hash-one"): IndexedFileRecord {
  return {
    fileId: "file-1",
    relativePath: "docs/one.md",
    filename: "one.md",
    format: "markdown",
    mimeFamily: "text/markdown",
    fingerprintHash: contentHash,
    size: 8,
    modifiedAtMs: 10,
    modifiedAtNs: "10000000",
    changedAtNs: "10000000",
    timestampPrecisionMs: 1,
    extractionStatus: "extracted",
    indexStatus: "indexed",
    contentHash,
    lastError: "",
    chunkCount: 1,
    extractorVersion: 1,
    chunkerVersion: 1,
    indexSchemaVersion: 1,
    indexedAtMs: 20,
  };
}

function chunkRecord(
  chunkId = "chunk-1",
  text = "searchable text",
  vector: readonly number[] = [1, 0, 0, 0],
): IndexedChunkRecord {
  return {
    chunkId,
    fileId: "file-1",
    relativePath: "docs/one.md",
    filename: "one.md",
    format: "markdown",
    ordinal: 0,
    displayText: text,
    searchText: `Path: docs/one.md\n${text}`,
    vector,
    startLine: 1,
    endLine: 1,
    startOffset: 0,
    endOffset: text.length,
    headingTrail: ["Docs"],
    symbols: ["one"],
    headingText: "Docs",
    symbolText: "one",
    contentHash: `hash-${chunkId}`,
    fileContentHash: "hash-one",
    tokenCount: 2,
    extractorVersion: 1,
    chunkerVersion: 1,
    indexSchemaVersion: 1,
  };
}

describe("LanceDB index storage", () => {
  test("creates explicit schemas, persists records, and enforces vector dimensions", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const opened = await openLanceIndex(config);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const stored = await opened.value.replaceFile(fileRecord(), [chunkRecord()]);
    if (!stored.ok) throw new Error(JSON.stringify(stored.error));
    expect(stored.ok).toBe(true);
    expect(await opened.value.getFile("file-1")).toEqual({ ok: true, value: fileRecord() });
    const chunks = await opened.value.getChunks("file-1");
    expect(chunks.ok).toBe(true);
    if (chunks.ok) {
      expect(chunks.value).toHaveLength(1);
      expect(chunks.value[0]?.headingTrail).toEqual(["Docs"]);
      expect(chunks.value[0]?.vector).toEqual([1, 0, 0, 0]);
    }
    const invalid = await opened.value.replaceFile(fileRecord(), [
      chunkRecord("wrong", "wrong", [1, 0]),
    ]);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe("INDEX_SCHEMA_INVALID");
    opened.value.close();
    expect(await Bun.file(config.paths.compatibilityFile).exists()).toBe(true);
  });

  test("atomically replaces one file's chunk set and makes retries idempotent", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const opened = await openLanceIndex(config);
    if (!opened.ok) throw new Error(opened.error.message);
    await opened.value.replaceFile(fileRecord(), [
      chunkRecord("old-a", "old a"),
      { ...chunkRecord("kept", "kept"), ordinal: 1 },
    ]);
    const otherFile = {
      ...fileRecord("other-hash"),
      fileId: "file-2",
      relativePath: "docs/two.md",
      filename: "two.md",
    };
    const otherChunk = {
      ...chunkRecord("other", "other text"),
      fileId: "file-2",
      relativePath: "docs/two.md",
      filename: "two.md",
      fileContentHash: "other-hash",
    };
    await opened.value.replaceFile(otherFile, [otherChunk]);
    const replacement = [
      chunkRecord("kept", "kept"),
      { ...chunkRecord("new-c", "new c"), ordinal: 1 },
    ];
    expect(await opened.value.replaceFile(fileRecord("hash-two"), replacement)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await opened.value.replaceFile(fileRecord("hash-two"), replacement)).toEqual({
      ok: true,
      value: undefined,
    });
    const chunks = await opened.value.getChunks("file-1");
    expect(chunks.ok && chunks.value.map((chunk) => chunk.chunkId)).toEqual(["kept", "new-c"]);
    const unaffected = await opened.value.getChunks("file-2");
    expect(unaffected.ok && unaffected.value.map((chunk) => chunk.chunkId)).toEqual(["other"]);
    opened.value.close();
  });

  test("removes failed and deleted files without leaving stale chunks", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const opened = await openLanceIndex(config);
    if (!opened.ok) throw new Error(opened.error.message);
    await opened.value.replaceFile(fileRecord(), [chunkRecord()]);
    const failed = await opened.value.markFileFailed(
      indexableFile("docs/one.md", "failed", { fileId: "file-1" }),
      {
        code: "EXTRACTION_FAILED",
        message: "Safe summary",
      },
    );
    expect(failed.ok).toBe(true);
    expect(await opened.value.getChunks("file-1")).toEqual({ ok: true, value: [] });

    await opened.value.replaceFile(fileRecord(), [chunkRecord()]);
    expect(await opened.value.deleteFile("file-1")).toEqual({ ok: true, value: undefined });
    expect(await opened.value.deleteFile("file-1")).toEqual({ ok: true, value: undefined });
    expect(await opened.value.getFile("file-1")).toEqual({ ok: true, value: undefined });
    opened.value.close();
  });

  test("requires an explicit rebuild for incompatible or corrupt compatibility state", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const initial = await openLanceIndex(config);
    if (!initial.ok) throw new Error(initial.error.message);
    await initial.value.replaceFile(fileRecord(), [chunkRecord()]);
    initial.value.close();

    const incompatible = {
      ...config,
      embedding: { ...config.embedding, vectorDimension: 5 },
      compatibility: {
        ...config.compatibility,
        embedding: { ...config.compatibility.embedding, vectorDimension: 5 },
      },
    };
    const refused = await openLanceIndex(incompatible);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("INDEX_REBUILD_REQUIRED");
    const rebuilt = await openLanceIndex(incompatible, { rebuildIfNeeded: true });
    expect(rebuilt.ok).toBe(true);
    if (rebuilt.ok) {
      expect(await rebuilt.value.getFile("file-1")).toEqual({ ok: true, value: undefined });
      rebuilt.value.close();
    }

    await writeFile(incompatible.paths.compatibilityFile, "not-json");
    const corrupt = await openLanceIndex(incompatible);
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.error.code).toBe("INDEX_REBUILD_REQUIRED");
  });

  test("treats a partially missing compatible schema as a controlled rebuild", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const initial = await openLanceIndex(config);
    if (!initial.ok) throw new Error(initial.error.message);
    initial.value.close();
    const connection = await lancedb.connect(config.paths.lanceDbDir);
    await connection.dropTable(CHUNKS_TABLE);
    connection.close();

    const refused = await openLanceIndex(config);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("INDEX_REBUILD_REQUIRED");
    const rebuilt = await openLanceIndex(config, { rebuildIfNeeded: true });
    expect(rebuilt.ok).toBe(true);
    if (rebuilt.ok) rebuilt.value.close();

    const malformedConnection = await lancedb.connect(config.paths.lanceDbDir);
    await malformedConnection.dropTable(CHUNKS_TABLE);
    const malformed = await malformedConnection.createTable(CHUNKS_TABLE, [{ wrong: "schema" }]);
    malformed.close();
    malformedConnection.close();
    const invalid = await openLanceIndex(config);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe("INDEX_SCHEMA_INVALID");
    const repaired = await openLanceIndex(config, { rebuildIfNeeded: true });
    expect(repaired.ok).toBe(true);
    if (repaired.ok) repaired.value.close();
  });

  test("builds BM25/scalar indexes and keeps exact vector scanning below the ANN threshold", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const opened = await openLanceIndex(config, { annThreshold: 100 });
    if (!opened.ok) throw new Error(opened.error.message);
    await opened.value.replaceFile(fileRecord(), [chunkRecord()]);
    expect(await opened.value.refreshSearchIndexes()).toEqual({ ok: true, value: undefined });
    opened.value.close();

    const connection = await lancedb.connect(config.paths.lanceDbDir);
    const chunks = await connection.openTable(CHUNKS_TABLE);
    const indices = await chunks.listIndices();
    expect(indices.some((index) => index.columns.includes("search_text"))).toBe(true);
    expect(indices.some((index) => index.columns.includes("file_id"))).toBe(true);
    expect(indices.some((index) => index.columns.includes("vector"))).toBe(false);
    chunks.close();
    connection.close();
  });
});
