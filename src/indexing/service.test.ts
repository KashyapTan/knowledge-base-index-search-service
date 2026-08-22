import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { FileChange } from "../discovery/index.ts";
import type { IndexingProgress, IndexStore } from "./contracts.ts";
import { FakeEmbeddingProvider } from "./fake-embedding-provider.ts";
import { CHUNKS_TABLE, openLanceIndex } from "./lance-store.ts";
import { createIndexingService } from "./service.ts";
import {
  extracted,
  FixtureExtractionPipeline,
  indexableFile,
  indexingConfig,
  searchChunk,
} from "./test-helpers.ts";

let fixture = "";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for a deterministic pipeline barrier.");
}

function storeWith(delegate: IndexStore, overrides: Partial<IndexStore>): IndexStore {
  return {
    getFile: delegate.getFile.bind(delegate),
    getFiles: delegate.getFiles.bind(delegate),
    getChunks: delegate.getChunks.bind(delegate),
    getChunksForFiles: delegate.getChunksForFiles.bind(delegate),
    getReusableChunksForFiles: delegate.getReusableChunksForFiles.bind(delegate),
    updateFiles: delegate.updateFiles.bind(delegate),
    replaceFile: delegate.replaceFile.bind(delegate),
    replaceFiles: delegate.replaceFiles.bind(delegate),
    markFileFailed: delegate.markFileFailed.bind(delegate),
    deleteFile: delegate.deleteFile.bind(delegate),
    refreshSearchIndexes: delegate.refreshSearchIndexes.bind(delegate),
    close: delegate.close.bind(delegate),
    ...overrides,
  };
}

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "kbiss-indexing-service-"));
  await Promise.all([
    mkdir(join(fixture, "root")),
    mkdir(join(fixture, "state", "metadata"), { recursive: true }),
    mkdir(join(fixture, "cache")),
  ]);
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe("resumable indexing orchestration", () => {
  test("skips an unchanged corpus and reuses unchanged chunks in an edited file", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const first = indexableFile("docs/guide.md", "file-v1");
    const second = indexableFile("docs/guide.md", "file-v2", {
      fileId: first.fileId,
      fingerprint: {
        ...first.fingerprint,
        contentHash: "file-v2",
        modifiedAtMs: 20,
        modifiedAtNs: "20000000",
        changedAtNs: "20000000",
      },
    });
    const kept = searchChunk(first, "kept", "stable paragraph", 1);
    const extraction = new FixtureExtractionPipeline([
      ["file-v1", extracted(first, [searchChunk(first, "removed", "old paragraph", 0), kept])],
      [
        "file-v2",
        extracted(second, [
          { ...kept, ordinal: 0 },
          searchChunk(second, "added", "new paragraph", 1),
        ]),
      ],
    ]);
    const embeddings = new FakeEmbeddingProvider({ dimension: 4, batchSize: 1 });
    const opened = await openLanceIndex(config);
    if (!opened.ok) throw new Error(opened.error.message);
    let refreshCalls = 0;
    const delegate = opened.value;
    const store: IndexStore = {
      getFile: delegate.getFile.bind(delegate),
      getFiles: delegate.getFiles.bind(delegate),
      getChunks: delegate.getChunks.bind(delegate),
      getChunksForFiles: delegate.getChunksForFiles.bind(delegate),
      getReusableChunksForFiles: delegate.getReusableChunksForFiles.bind(delegate),
      updateFiles: delegate.updateFiles.bind(delegate),
      replaceFile: delegate.replaceFile.bind(delegate),
      replaceFiles: delegate.replaceFiles.bind(delegate),
      markFileFailed: delegate.markFileFailed.bind(delegate),
      deleteFile: delegate.deleteFile.bind(delegate),
      async refreshSearchIndexes() {
        refreshCalls += 1;
        return delegate.refreshSearchIndexes();
      },
      close: delegate.close.bind(delegate),
    };
    const service = createIndexingService(config, {
      extraction,
      embeddings,
      store,
    });
    const events: IndexingProgress[] = [];
    const unsubscribe = service.subscribeProgress((progress) => events.push(progress));

    const initial = await service.indexFiles([first]);
    expect(initial.ok).toBe(true);
    if (initial.ok) {
      expect(initial.value.progress.embeddedChunks).toBe(2);
      expect(initial.value.progress.committedChunks).toBe(2);
      expect(initial.value.progress.batchesCompleted).toBe(2);
    }
    expect(embeddings.embeddedTexts).toHaveLength(2);
    expect(extraction.calls).toBe(1);
    expect(refreshCalls).toBe(1);

    const unchanged = await service.indexFiles([first]);
    expect(unchanged.ok && unchanged.value.progress.unchangedFiles).toBe(1);
    expect(embeddings.embeddedTexts).toHaveLength(2);
    expect(extraction.calls).toBe(1);
    expect(refreshCalls).toBe(1);

    const metadataOnly = {
      ...first,
      fingerprint: {
        ...first.fingerprint,
        modifiedAtMs: 15,
        modifiedAtNs: "15000000",
        changedAtNs: "15000000",
      },
    };
    const metadataRun = await service.indexFiles([metadataOnly]);
    expect(metadataRun.ok && metadataRun.value.progress.unchangedFiles).toBe(1);
    expect(embeddings.embeddedTexts).toHaveLength(2);
    expect(extraction.calls).toBe(1);
    expect(refreshCalls).toBe(1);

    const changed = await service.indexFiles([second]);
    expect(changed.ok).toBe(true);
    if (changed.ok) {
      expect(changed.value.progress.embeddedChunks).toBe(1);
      expect(changed.value.progress.reusedChunks).toBe(1);
      expect(changed.value.progress.committedChunks).toBe(2);
    }
    expect(embeddings.embeddedTexts).toHaveLength(3);
    expect(refreshCalls).toBe(2);
    const chunks = await opened.value.getChunks(first.fileId);
    expect(chunks.ok && chunks.value.map((chunk) => chunk.chunkId)).toEqual(["kept", "added"]);
    expect(events.some((event) => event.phase === "extracting")).toBe(true);
    expect(events.some((event) => event.phase === "embedding")).toBe(true);
    expect(events.some((event) => event.currentFile === "docs/guide.md")).toBe(true);
    expect(events.at(-1)).toMatchObject({ phase: "complete" });
    expect(events.at(-1)?.currentFile).toBeUndefined();
    unsubscribe();
    opened.value.close();
  });

  test("applies deletion and per-file failure changes without stopping healthy work", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const good = indexableFile("good.md", "good");
    const bad = indexableFile("bad.md", "bad", {
      readStatus: "unreadable",
      lastError: "The file is unreadable.",
    });
    const binary = indexableFile("image.png", "binary", {
      extension: ".png",
      format: "unknown",
      mimeFamily: "application/octet-stream",
      readStatus: "malformed",
      indexStatus: "skipped",
      lastError: "The file is not valid UTF-8 text.",
    });
    const extraction = new FixtureExtractionPipeline([
      ["good", extracted(good, [searchChunk(good, "good-chunk", "good text", 0)])],
    ]);
    const opened = await openLanceIndex(config);
    if (!opened.ok) throw new Error(opened.error.message);
    const service = createIndexingService(config, {
      extraction,
      embeddings: new FakeEmbeddingProvider({ dimension: 4 }),
      store: opened.value,
    });
    const progressEvents: IndexingProgress[] = [];
    service.subscribeProgress((progress) => progressEvents.push(progress));
    const first = await service.indexFiles([bad, binary, good]);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.progress.failedFiles).toBe(1);
      expect(first.value.progress.skippedFiles).toBe(1);
      expect(first.value.progress.errors[0]).toMatchObject({
        fileId: bad.fileId,
        code: "FILE_NOT_READY",
      });
      expect(first.value.progress.processedFiles).toBe(3);
    }
    expect(progressEvents.some((progress) => progress.estimatedCompletionMs !== undefined)).toBe(
      true,
    );
    const deletion: FileChange = {
      kind: "deleted",
      fileId: good.fileId,
      relativePath: good.relativePath,
      source: "watch",
      previous: good,
    };
    const removed = await service.applyChanges([deletion]);
    expect(removed.ok && removed.value.progress.deletedFiles).toBe(1);
    expect(
      progressEvents.some(
        (progress) => progress.phase === "deleting" && progress.currentFile === good.relativePath,
      ),
    ).toBe(true);
    expect(progressEvents.at(-1)?.currentFile).toBeUndefined();
    expect(await opened.value.getFile(good.fileId)).toEqual({ ok: true, value: undefined });
    opened.value.close();
  });

  test("cancels without committing a partial file", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const file = indexableFile("cancel.md", "cancel");
    const extraction = new FixtureExtractionPipeline([
      ["cancel", extracted(file, [searchChunk(file, "cancel-chunk", "cancel text", 0)])],
    ]);
    const opened = await openLanceIndex(config);
    if (!opened.ok) throw new Error(opened.error.message);
    const controller = new AbortController();
    controller.abort();
    const service = createIndexingService(config, {
      extraction,
      embeddings: new FakeEmbeddingProvider({ dimension: 4 }),
      store: opened.value,
    });
    const result = await service.indexFiles([file], { signal: controller.signal });
    expect(result).toEqual({
      ok: false,
      error: { code: "INDEXING_CANCELLED", message: "Indexing was cancelled." },
    });
    expect(await opened.value.getFile(file.fileId)).toEqual({ ok: true, value: undefined });
    opened.value.close();
  });

  test("records inference failure safely and removes stale chunks", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const first = indexableFile("failure.md", "before");
    const changed = indexableFile("failure.md", "after", {
      fileId: first.fileId,
      fingerprint: { ...first.fingerprint, contentHash: "after", changedAtNs: "20000000" },
    });
    const extraction = new FixtureExtractionPipeline([
      ["before", extracted(first, [searchChunk(first, "before", "healthy text", 0)])],
      ["after", extracted(changed, [searchChunk(changed, "after", "please fail", 0)])],
    ]);
    const opened = await openLanceIndex(config);
    if (!opened.ok) throw new Error(opened.error.message);
    const service = createIndexingService(config, {
      extraction,
      embeddings: new FakeEmbeddingProvider({ dimension: 4, failOnText: "please fail" }),
      store: opened.value,
    });
    expect((await service.indexFiles([first])).ok).toBe(true);
    expect((await opened.value.getChunks(first.fileId)).ok).toBe(true);
    const failed = await service.indexFiles([changed]);
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect(failed.value.progress.failedFiles).toBe(1);
      expect(failed.value.progress.errors[0]?.code).toBe("INFERENCE_FAILED");
    }
    expect(await opened.value.getChunks(first.fileId)).toEqual({ ok: true, value: [] });
    const file = await opened.value.getFile(first.fileId);
    expect(file.ok && file.value?.indexStatus).toBe("failed");
    opened.value.close();
  });

  test("resumes after interruption between atomic chunk replacement and the file commit", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const file = indexableFile("resume.md", "resume");
    const prepared = extracted(file, [
      searchChunk(file, "resume-a", "first", 0),
      searchChunk(file, "resume-b", "second", 1),
    ]);
    const firstProvider = new FakeEmbeddingProvider({ dimension: 4 });
    const interrupted = await openLanceIndex(config, {
      beforeFileCommit: async () => {
        throw new Error("simulated interruption");
      },
    });
    if (!interrupted.ok) throw new Error(interrupted.error.message);
    const firstService = createIndexingService(config, {
      extraction: new FixtureExtractionPipeline([["resume", prepared]]),
      embeddings: firstProvider,
      store: interrupted.value,
    });
    const firstRun = await firstService.indexFiles([file]);
    expect(firstRun.ok).toBe(true);
    if (firstRun.ok) expect(firstRun.value.progress.failedFiles).toBe(1);
    expect(firstProvider.embeddedTexts).toHaveLength(2);
    expect(await interrupted.value.getFile(file.fileId)).toEqual({ ok: true, value: undefined });
    const staged = await interrupted.value.getChunks(file.fileId);
    expect(staged.ok && staged.value).toHaveLength(2);
    interrupted.value.close();

    const resumed = await openLanceIndex(config);
    if (!resumed.ok) throw new Error(resumed.error.message);
    const resumeProvider = new FakeEmbeddingProvider({ dimension: 4 });
    const resumeService = createIndexingService(config, {
      extraction: new FixtureExtractionPipeline([["resume", prepared]]),
      embeddings: resumeProvider,
      store: resumed.value,
    });
    const resumedRun = await resumeService.indexFiles([file]);
    expect(resumedRun.ok).toBe(true);
    if (resumedRun.ok) {
      expect(resumedRun.value.progress.reusedChunks).toBe(2);
      expect(resumedRun.value.progress.committedChunks).toBe(2);
    }
    expect(resumeProvider.embeddedTexts).toHaveLength(0);
    expect((await resumed.value.getFile(file.fileId)).ok).toBe(true);
    const finalChunks = await resumed.value.getChunks(file.fileId);
    expect(finalChunks.ok && finalChunks.value.map((chunk) => chunk.chunkId)).toEqual([
      "resume-a",
      "resume-b",
    ]);
    resumed.value.close();
  });

  test("prepares files concurrently, embeds across file boundaries, and uses one batched writer", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const files = [
      indexableFile("a.md", "a"),
      indexableFile("b.md", "b"),
      indexableFile("c.md", "c"),
    ];
    let active = 0;
    let maxActive = 0;
    const extraction = {
      async process(file: (typeof files)[number]) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(10);
        active -= 1;
        return {
          ok: true as const,
          value: extracted(file, [searchChunk(file, `${file.filename}-chunk`, file.filename, 0)]),
        };
      },
    };
    const embeddings = new FakeEmbeddingProvider({ dimension: 4, batchSize: 2 });
    const opened = await openLanceIndex(config);
    if (!opened.ok) throw new Error(opened.error.message);
    let projectedChunkReadCalls = 0;
    let batchWriteCalls = 0;
    const delegate = opened.value;
    const store: IndexStore = {
      getFile: delegate.getFile.bind(delegate),
      getFiles: delegate.getFiles.bind(delegate),
      getChunks: delegate.getChunks.bind(delegate),
      async getChunksForFiles(fileIds) {
        return delegate.getChunksForFiles(fileIds);
      },
      async getReusableChunksForFiles(fileIds) {
        projectedChunkReadCalls += 1;
        return delegate.getReusableChunksForFiles(fileIds);
      },
      updateFiles: delegate.updateFiles.bind(delegate),
      replaceFile: delegate.replaceFile.bind(delegate),
      async replaceFiles(entries) {
        batchWriteCalls += 1;
        return delegate.replaceFiles(entries);
      },
      markFileFailed: delegate.markFileFailed.bind(delegate),
      deleteFile: delegate.deleteFile.bind(delegate),
      refreshSearchIndexes: delegate.refreshSearchIndexes.bind(delegate),
      close: delegate.close.bind(delegate),
    };
    const service = createIndexingService(config, { extraction, embeddings, store });
    const result = await service.indexFiles(files);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.progress).toMatchObject({
        committedChunks: 3,
        embeddedChunks: 3,
        batchesCompleted: 2,
        failedFiles: 0,
      });
      expect(result.value.timing.totalMs).toBeGreaterThanOrEqual(0);
      expect(result.value.timing.preparationMs).toBeGreaterThanOrEqual(10);
    }
    expect(maxActive).toBe(3);
    expect(projectedChunkReadCalls).toBe(1);
    expect(batchWriteCalls).toBe(1);
    expect(embeddings.embeddedTexts).toHaveLength(3);
    opened.value.close();
  });

  test("overlaps adjacent stages, preserves writer order, and keeps in-flight windows bounded", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const files = [
      indexableFile("a.md", "a"),
      indexableFile("b.md", "b"),
      indexableFile("c.md", "c"),
    ];
    const extractionCalls: string[] = [];
    const extraction = {
      async process(file: (typeof files)[number]) {
        extractionCalls.push(file.relativePath);
        await Bun.sleep(2);
        return {
          ok: true as const,
          value: extracted(file, [searchChunk(file, `${file.filename}-chunk`, file.filename, 0)]),
        };
      },
    };
    const embeddings = new FakeEmbeddingProvider({ dimension: 4, batchSize: 1 });
    const originalEmbed = embeddings.embedDocuments.bind(embeddings);
    const firstEmbedding = deferred();
    let firstEmbeddingStarted = false;
    let secondEmbeddingStarted = false;
    let embeddingCalls = 0;
    embeddings.embedDocuments = async (texts, options) => {
      embeddingCalls += 1;
      if (embeddingCalls === 1) {
        firstEmbeddingStarted = true;
        await firstEmbedding.promise;
      } else secondEmbeddingStarted = true;
      return originalEmbed(texts, options);
    };
    const opened = await openLanceIndex(config);
    if (!opened.ok) throw new Error(opened.error.message);
    const delegate = opened.value;
    const firstCommit = deferred();
    let firstCommitStarted = false;
    let activeWriters = 0;
    let maximumWriters = 0;
    const commitOrder: string[] = [];
    const projectedBatches: string[][] = [];
    let fullChunkReads = 0;
    const store: IndexStore = {
      getFile: delegate.getFile.bind(delegate),
      getFiles: delegate.getFiles.bind(delegate),
      getChunks: delegate.getChunks.bind(delegate),
      async getChunksForFiles(fileIds) {
        fullChunkReads += 1;
        return delegate.getChunksForFiles(fileIds);
      },
      async getReusableChunksForFiles(fileIds) {
        projectedBatches.push([...fileIds]);
        return delegate.getReusableChunksForFiles(fileIds);
      },
      updateFiles: delegate.updateFiles.bind(delegate),
      replaceFile: delegate.replaceFile.bind(delegate),
      async replaceFiles(entries) {
        activeWriters += 1;
        maximumWriters = Math.max(maximumWriters, activeWriters);
        commitOrder.push(entries[0]?.file.relativePath ?? "missing");
        if (commitOrder.length === 1) {
          firstCommitStarted = true;
          await firstCommit.promise;
        }
        const result = await delegate.replaceFiles(entries);
        activeWriters -= 1;
        return result;
      },
      markFileFailed: delegate.markFileFailed.bind(delegate),
      deleteFile: delegate.deleteFile.bind(delegate),
      refreshSearchIndexes: delegate.refreshSearchIndexes.bind(delegate),
      close: delegate.close.bind(delegate),
    };
    const service = createIndexingService(
      config,
      { extraction, embeddings, store },
      {
        preparationWindowSize: 1,
        preparedWindowCapacity: 2,
        embeddedWindowCapacity: 2,
      },
    );
    const run = service.indexFiles(files);
    await waitFor(() => firstEmbeddingStarted && extractionCalls.includes("b.md"));
    firstEmbedding.resolve();
    await waitFor(() => firstCommitStarted && secondEmbeddingStarted);
    firstCommit.resolve();
    const result = await run;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timing.maximumInFlight).toMatchObject({
        embeddedWindows: 2,
        vectorBytes: 32,
      });
      const inFlight = result.value.timing.maximumInFlight;
      if (!inFlight) throw new Error("Pipeline in-flight metrics were not reported.");
      if (typeof inFlight.preparedWindows !== "number") {
        throw new Error(`Invalid pipeline metrics: ${JSON.stringify(inFlight)}`);
      }
      expect(inFlight.preparedWindows).toBeLessThanOrEqual(2);
      expect(result.value.timing.stageWaitMs?.preparation).toBeGreaterThan(0);
      expect(result.value.timing.pipelineWallMs).toBeGreaterThan(0);
    }
    expect(maximumWriters).toBe(1);
    expect(commitOrder).toEqual(["a.md", "b.md", "c.md"]);
    expect(projectedBatches).toEqual(files.map((file) => [file.fileId]));
    expect(fullChunkReads).toBe(0);
    opened.value.close();
  });

  test("reuses moved embedding inputs as a deterministic multiset", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const first = indexableFile("moved.md", "before");
    const changed = indexableFile("moved.md", "after", {
      fileId: first.fileId,
      fingerprint: { ...first.fingerprint, contentHash: "after", changedAtNs: "20000000" },
    });
    const oldChunks = [
      searchChunk(first, "old-a", "identical block", 0),
      searchChunk(first, "old-b", "identical block", 1),
    ];
    const movedChunks = [
      { ...searchChunk(changed, "new-a", "identical block", 0), startLine: 50, endLine: 50 },
      { ...searchChunk(changed, "new-b", "identical block", 1), startLine: 60, endLine: 60 },
      { ...searchChunk(changed, "new-c", "identical block", 2), startLine: 70, endLine: 70 },
    ];
    const extraction = new FixtureExtractionPipeline([
      ["before", extracted(first, oldChunks)],
      ["after", extracted(changed, movedChunks)],
    ]);
    const embeddings = new FakeEmbeddingProvider({ dimension: 4 });
    const opened = await openLanceIndex(config);
    if (!opened.ok) throw new Error(opened.error.message);
    const service = createIndexingService(config, { extraction, embeddings, store: opened.value });
    expect((await service.indexFiles([first])).ok).toBe(true);
    embeddings.embeddedTexts.length = 0;
    const result = await service.indexFiles([changed]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.progress.reusedChunks).toBe(2);
      expect(result.value.progress.embeddedChunks).toBe(1);
    }
    expect(embeddings.embeddedTexts).toHaveLength(1);
    const stored = await opened.value.getChunks(first.fileId);
    expect(stored.ok && stored.value.map((chunk) => chunk.chunkId)).toEqual([
      "new-a",
      "new-b",
      "new-c",
    ]);
    opened.value.close();
  });

  test("commits a mass metadata-only change without extraction, inference, or chunk versions", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const files = Array.from({ length: 24 }, (_, index) =>
      indexableFile(`mass/${String(index).padStart(2, "0")}.md`, `content-${index}`),
    );
    const extraction = new FixtureExtractionPipeline(
      files.map((file) => [
        file.fingerprint.contentHash ?? "",
        extracted(file, [searchChunk(file, `${file.filename}-chunk`, file.filename, 0)]),
      ]),
    );
    const embeddings = new FakeEmbeddingProvider({ dimension: 4 });
    const opened = await openLanceIndex(config);
    if (!opened.ok) throw new Error(opened.error.message);
    const service = createIndexingService(
      config,
      { extraction, embeddings, store: opened.value },
      {
        preparationWindowSize: 5,
      },
    );
    expect((await service.indexFiles(files)).ok).toBe(true);
    const connection = await lancedb.connect(config.paths.lanceDbDir);
    const chunks = await connection.openTable(CHUNKS_TABLE);
    const beforeVersion = await chunks.version();
    chunks.close();
    connection.close();
    const extractionCalls = extraction.calls;
    embeddings.embeddedTexts.length = 0;
    const touched = files.map((file) => ({
      ...file,
      fingerprint: {
        ...file.fingerprint,
        modifiedAtMs: file.fingerprint.modifiedAtMs + 100,
        modifiedAtNs: String(Number(file.fingerprint.modifiedAtNs) + 100_000_000),
        changedAtNs: String(Number(file.fingerprint.changedAtNs) + 100_000_000),
      },
    }));
    const result = await service.indexFiles(touched);
    expect(result.ok && result.value.progress.unchangedFiles).toBe(24);
    expect(extraction.calls).toBe(extractionCalls);
    expect(embeddings.embeddedTexts).toEqual([]);
    const afterConnection = await lancedb.connect(config.paths.lanceDbDir);
    const afterChunks = await afterConnection.openTable(CHUNKS_TABLE);
    expect(await afterChunks.version()).toBe(beforeVersion);
    afterChunks.close();
    afterConnection.close();
    opened.value.close();
  });

  test("rejects reuse when an encoding/profile compatibility field differs", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const first = indexableFile("profile.md", "before");
    const changed = indexableFile("profile.md", "after", {
      fileId: first.fileId,
      fingerprint: { ...first.fingerprint, contentHash: "after", changedAtNs: "20000000" },
    });
    const extraction = new FixtureExtractionPipeline([
      ["before", extracted(first, [searchChunk(first, "old", "stable input", 0)])],
      ["after", extracted(changed, [searchChunk(changed, "new", "stable input", 0)])],
    ]);
    const opened = await openLanceIndex(config);
    if (!opened.ok) throw new Error(opened.error.message);
    const initialProvider = new FakeEmbeddingProvider({ dimension: 4 });
    expect(
      (
        await createIndexingService(config, {
          extraction,
          embeddings: initialProvider,
          store: opened.value,
        }).indexFiles([first])
      ).ok,
    ).toBe(true);
    const delegate = opened.value;
    const incompatibleStore: IndexStore = {
      getFile: delegate.getFile.bind(delegate),
      getFiles: delegate.getFiles.bind(delegate),
      getChunks: delegate.getChunks.bind(delegate),
      getChunksForFiles: delegate.getChunksForFiles.bind(delegate),
      async getReusableChunksForFiles(fileIds) {
        const result = await delegate.getReusableChunksForFiles(fileIds);
        return result.ok
          ? {
              ok: true as const,
              value: result.value.map((chunk) => ({
                ...chunk,
                documentEncodingVersion: chunk.documentEncodingVersion + 1,
              })),
            }
          : result;
      },
      updateFiles: delegate.updateFiles.bind(delegate),
      replaceFile: delegate.replaceFile.bind(delegate),
      replaceFiles: delegate.replaceFiles.bind(delegate),
      markFileFailed: delegate.markFileFailed.bind(delegate),
      deleteFile: delegate.deleteFile.bind(delegate),
      refreshSearchIndexes: delegate.refreshSearchIndexes.bind(delegate),
      close: delegate.close.bind(delegate),
    };
    const provider = new FakeEmbeddingProvider({ dimension: 4 });
    const result = await createIndexingService(config, {
      extraction,
      embeddings: provider,
      store: incompatibleStore,
    }).indexFiles([changed]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.progress.reusedChunks).toBe(0);
      expect(result.value.progress.embeddedChunks).toBe(1);
    }
    opened.value.close();
  });

  test("cancels active preparation after it settles without advancing a file marker", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const file = indexableFile("active.md", "active");
    const barrier = deferred();
    let started = false;
    const extraction = {
      async process() {
        started = true;
        await barrier.promise;
        return {
          ok: true as const,
          value: extracted(file, [searchChunk(file, "active", "text", 0)]),
        };
      },
    };
    const opened = await openLanceIndex(config);
    if (!opened.ok) throw new Error(opened.error.message);
    const controller = new AbortController();
    const service = createIndexingService(config, {
      extraction,
      embeddings: new FakeEmbeddingProvider({ dimension: 4 }),
      store: opened.value,
    });
    const run = service.indexFiles([file], { signal: controller.signal });
    await waitFor(() => started);
    controller.abort();
    barrier.resolve();
    expect(await run).toMatchObject({ ok: false, error: { code: "INDEXING_CANCELLED" } });
    expect(await opened.value.getFile(file.fileId)).toEqual({ ok: true, value: undefined });
    opened.value.close();
  });

  test("drains a fatal projected-read failure without changing the prior file marker", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const first = indexableFile("projected.md", "before");
    const changed = indexableFile("projected.md", "after", {
      fileId: first.fileId,
      fingerprint: { ...first.fingerprint, contentHash: "after", changedAtNs: "20000000" },
    });
    const extraction = new FixtureExtractionPipeline([
      ["before", extracted(first, [searchChunk(first, "before", "before", 0)])],
      ["after", extracted(changed, [searchChunk(changed, "after", "after", 0)])],
    ]);
    const opened = await openLanceIndex(config);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(
      (
        await createIndexingService(config, {
          extraction,
          embeddings: new FakeEmbeddingProvider({ dimension: 4 }),
          store: opened.value,
        }).indexFiles([first])
      ).ok,
    ).toBe(true);
    const store = storeWith(opened.value, {
      async getReusableChunksForFiles() {
        return {
          ok: false as const,
          error: { code: "INDEX_READ_FAILED" as const, message: "projected read failed" },
        };
      },
    });
    const result = await Promise.race([
      createIndexingService(config, {
        extraction,
        embeddings: new FakeEmbeddingProvider({ dimension: 4 }),
        store,
      }).indexFiles([changed]),
      Bun.sleep(500).then(() => {
        throw new Error("The failed preparation stage deadlocked.");
      }),
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: "INDEXING_FATAL" } });
    expect(await opened.value.getFile(first.fileId)).toMatchObject({
      ok: true,
      value: { contentHash: "before" },
    });
    opened.value.close();
  });

  test("drains a thrown writer failure without committing an incomplete window", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const file = indexableFile("writer.md", "writer");
    const opened = await openLanceIndex(config);
    if (!opened.ok) throw new Error(opened.error.message);
    const store = storeWith(opened.value, {
      async replaceFiles() {
        throw new Error("writer failed");
      },
    });
    const result = await Promise.race([
      createIndexingService(config, {
        extraction: new FixtureExtractionPipeline([
          ["writer", extracted(file, [searchChunk(file, "writer", "writer", 0)])],
        ]),
        embeddings: new FakeEmbeddingProvider({ dimension: 4 }),
        store,
      }).indexFiles([file]),
      Bun.sleep(500).then(() => {
        throw new Error("The failed commit stage deadlocked.");
      }),
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: "INDEXING_FATAL" } });
    expect(await opened.value.getFile(file.fileId)).toEqual({ ok: true, value: undefined });
    opened.value.close();
  });
});
