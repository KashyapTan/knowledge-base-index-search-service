import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileChange } from "../discovery/index.ts";
import type { IndexingProgress, IndexStore } from "./contracts.ts";
import { FakeEmbeddingProvider } from "./fake-embedding-provider.ts";
import { openLanceIndex } from "./lance-store.ts";
import { createIndexingService } from "./service.ts";
import {
  extracted,
  FixtureExtractionPipeline,
  indexableFile,
  indexingConfig,
  searchChunk,
} from "./test-helpers.ts";

let fixture = "";

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
      replaceFile: delegate.replaceFile.bind(delegate),
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
});
