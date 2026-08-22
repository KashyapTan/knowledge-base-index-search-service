import { createHash } from "node:crypto";
import type { AppConfig } from "../config/index.ts";
import type { DiscoveredFile, FileChange } from "../discovery/index.ts";
import type { ExtractedFile } from "../extraction/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type {
  IndexedChunkRecord,
  IndexedFileRecord,
  IndexingDependencies,
  IndexingError,
  IndexingFileError,
  IndexingProgress,
  IndexingRunResult,
  IndexingService,
} from "./contracts.ts";

interface MutableProgress {
  phase: IndexingProgress["phase"];
  currentFile?: string;
  totalFiles: number;
  processedFiles: number;
  unchangedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  deletedFiles: number;
  totalChunks: number;
  embeddedChunks: number;
  reusedChunks: number;
  committedChunks: number;
  batchesCompleted: number;
  errors: IndexingFileError[];
  estimatedCompletionMs?: number;
}

function stableFingerprint(file: DiscoveredFile): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        size: file.fingerprint.size,
        modifiedAtNs: file.fingerprint.modifiedAtNs,
        changedAtNs: file.fingerprint.changedAtNs,
        contentHash: file.fingerprint.contentHash ?? "",
      }),
    )
    .digest("hex");
}

function currentRecord(
  config: AppConfig,
  file: DiscoveredFile,
  extracted: ExtractedFile,
  now: number,
): IndexedFileRecord {
  return {
    fileId: file.fileId,
    relativePath: file.relativePath,
    filename: file.filename,
    format: file.format,
    mimeFamily: file.mimeFamily,
    fingerprintHash: stableFingerprint(file),
    size: file.fingerprint.size,
    modifiedAtMs: file.fingerprint.modifiedAtMs,
    modifiedAtNs: file.fingerprint.modifiedAtNs,
    changedAtNs: file.fingerprint.changedAtNs,
    timestampPrecisionMs: file.fingerprint.timestampPrecisionMs,
    extractionStatus: "extracted",
    indexStatus: "indexed",
    contentHash: file.fingerprint.contentHash ?? "",
    lastError: "",
    chunkCount: extracted.chunks.length,
    extractorVersion: config.index.extractorVersion,
    chunkerVersion: config.index.chunkerVersion,
    indexSchemaVersion: config.index.schemaVersion,
    indexedAtMs: now,
  };
}

function chunkRecord(
  config: AppConfig,
  file: DiscoveredFile,
  chunk: ExtractedFile["chunks"][number],
  vector: readonly number[],
): IndexedChunkRecord {
  return {
    chunkId: chunk.chunkId,
    fileId: chunk.fileId,
    relativePath: chunk.relativePath,
    filename: file.filename,
    format: file.format,
    ordinal: chunk.ordinal,
    displayText: chunk.displayText,
    searchText: chunk.searchText,
    vector,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    headingTrail: chunk.headingTrail,
    symbols: chunk.symbols,
    headingText: chunk.headingTrail.join(" > "),
    symbolText: chunk.symbols.join(" "),
    contentHash: chunk.contentHash,
    fileContentHash: file.fingerprint.contentHash ?? "",
    tokenCount: chunk.tokenCount,
    extractorVersion: chunk.extractorVersion,
    chunkerVersion: chunk.chunkerVersion,
    indexSchemaVersion: config.index.schemaVersion,
  };
}

function snapshot(progress: MutableProgress): IndexingProgress {
  return {
    phase: progress.phase,
    ...(progress.currentFile === undefined ? {} : { currentFile: progress.currentFile }),
    totalFiles: progress.totalFiles,
    processedFiles: progress.processedFiles,
    unchangedFiles: progress.unchangedFiles,
    skippedFiles: progress.skippedFiles,
    failedFiles: progress.failedFiles,
    deletedFiles: progress.deletedFiles,
    totalChunks: progress.totalChunks,
    embeddedChunks: progress.embeddedChunks,
    reusedChunks: progress.reusedChunks,
    committedChunks: progress.committedChunks,
    batchesCompleted: progress.batchesCompleted,
    errors: [...progress.errors],
    ...(progress.estimatedCompletionMs === undefined
      ? {}
      : { estimatedCompletionMs: progress.estimatedCompletionMs }),
  };
}

export class RepositoryIndexingService implements IndexingService {
  readonly #config: AppConfig;
  readonly #dependencies: IndexingDependencies;
  readonly #listeners = new Set<(progress: IndexingProgress) => void>();
  readonly #now: () => number;

  constructor(
    config: AppConfig,
    dependencies: IndexingDependencies,
    options: { readonly now?: () => number } = {},
  ) {
    this.#config = config;
    this.#dependencies = dependencies;
    this.#now = options.now ?? Date.now;
  }

  subscribeProgress(listener: (progress: IndexingProgress) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  indexFiles(
    files: readonly DiscoveredFile[],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<IndexingRunResult, IndexingError>> {
    return this.#run(files, [], options.signal);
  }

  applyChanges(
    changes: readonly FileChange[],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<IndexingRunResult, IndexingError>> {
    const deletions = changes.filter((change) => change.kind === "deleted");
    const files = changes
      .filter((change) => change.kind !== "deleted" && change.kind !== "unchanged")
      .flatMap((change) => (change.current ? [change.current] : []));
    return this.#run(files, deletions, options.signal);
  }

  async #run(
    files: readonly DiscoveredFile[],
    deletions: readonly FileChange[],
    signal?: AbortSignal,
  ): Promise<Result<IndexingRunResult, IndexingError>> {
    const progress: MutableProgress = {
      phase: "preparing",
      totalFiles: files.length + deletions.length,
      processedFiles: 0,
      unchangedFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      deletedFiles: 0,
      totalChunks: 0,
      embeddedChunks: 0,
      reusedChunks: 0,
      committedChunks: 0,
      batchesCompleted: 0,
      errors: [],
    };
    const startedAt = this.#now();
    let searchDataChanged = false;
    this.#publish(progress);
    const warm = await this.#dependencies.embeddings.warmUp();
    if (!warm.ok) {
      return err({ code: "INDEXING_FATAL", message: warm.error.message });
    }

    for (const change of deletions) {
      if (this.#cancelled(signal, progress)) return this.#cancelError();
      progress.currentFile = change.relativePath;
      progress.phase = "deleting";
      this.#publish(progress);
      const deleted = await this.#dependencies.store.deleteFile(change.fileId);
      if (!deleted.ok)
        this.#recordError(progress, change.fileId, change.relativePath, deleted.error);
      else {
        progress.deletedFiles += 1;
        searchDataChanged = true;
      }
      progress.processedFiles += 1;
      this.#estimate(progress, startedAt);
      this.#publish(progress);
    }

    const ordered = [...files].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
    const existing = await this.#dependencies.store.getFiles(ordered.map((file) => file.fileId));
    if (!existing.ok) return err({ code: "INDEXING_FATAL", message: existing.error.message });
    const existingById = new Map(existing.value.map((file) => [file.fileId, file]));
    for (const file of ordered) {
      if (this.#cancelled(signal, progress)) return this.#cancelError();
      progress.currentFile = file.relativePath;
      this.#publish(progress);
      const outcome = await this.#indexOne(file, existingById.get(file.fileId), progress, signal);
      if (!outcome.ok && outcome.error.code === "INDEXING_CANCELLED") {
        progress.phase = "cancelled";
        delete progress.currentFile;
        this.#publish(progress);
        return outcome;
      }
      if (!outcome.ok) return outcome;
      searchDataChanged ||= outcome.value;
      progress.processedFiles += 1;
      this.#estimate(progress, startedAt);
      this.#publish(progress);
    }

    delete progress.currentFile;
    progress.phase = "finalizing";
    this.#publish(progress);
    if (searchDataChanged) {
      const refreshed = await this.#dependencies.store.refreshSearchIndexes();
      if (!refreshed.ok) {
        return err({ code: "INDEXING_FATAL", message: refreshed.error.message });
      }
    }
    progress.phase = "complete";
    delete progress.estimatedCompletionMs;
    this.#publish(progress);
    return ok({ progress: snapshot(progress) });
  }

  async #indexOne(
    file: DiscoveredFile,
    existingRecord: IndexedFileRecord | undefined,
    progress: MutableProgress,
    signal?: AbortSignal,
  ): Promise<Result<boolean, IndexingError>> {
    if (file.readStatus !== "ready" || !file.fingerprint.contentHash) {
      const issue = {
        code: "FILE_NOT_READY",
        message: file.lastError ?? "The discovered file is not ready for indexing.",
      };
      if (file.readStatus === "unsupported" || file.readStatus === "malformed") {
        // Expected non-text content is a skip, not an indexing incident. markFileFailed still
        // removes stale chunks if a formerly searchable file became binary or unsupported.
        progress.skippedFiles += 1;
        if (!existingRecord || existingRecord.indexStatus === "failed") return ok(false);
        const stored = await this.#dependencies.store.markFileFailed(file, issue);
        if (!stored.ok) {
          this.#recordError(progress, file.fileId, file.relativePath, stored.error);
          return ok(false);
        }
        return ok(true);
      }
      const stored = await this.#dependencies.store.markFileFailed(file, issue);
      if (!stored.ok) {
        this.#recordError(progress, file.fileId, file.relativePath, stored.error);
      } else {
        this.#recordError(progress, file.fileId, file.relativePath, issue);
      }
      return ok(stored.ok);
    }
    const isCompatible =
      existingRecord?.indexStatus === "indexed" &&
      existingRecord.contentHash === file.fingerprint.contentHash &&
      existingRecord.extractorVersion === this.#config.index.extractorVersion &&
      existingRecord.chunkerVersion === this.#config.index.chunkerVersion &&
      existingRecord.indexSchemaVersion === this.#config.index.schemaVersion;
    if (isCompatible && existingRecord?.fingerprintHash === stableFingerprint(file)) {
      progress.unchangedFiles += 1;
      return ok(false);
    }

    if (isCompatible && existingRecord) {
      const chunks = await this.#dependencies.store.getChunks(file.fileId);
      if (!chunks.ok) {
        this.#recordError(progress, file.fileId, file.relativePath, chunks.error);
        return ok(false);
      }
      progress.phase = "committing";
      this.#publish(progress);
      const metadataOnly: IndexedFileRecord = {
        ...existingRecord,
        fingerprintHash: stableFingerprint(file),
        size: file.fingerprint.size,
        modifiedAtMs: file.fingerprint.modifiedAtMs,
        modifiedAtNs: file.fingerprint.modifiedAtNs,
        changedAtNs: file.fingerprint.changedAtNs,
        timestampPrecisionMs: file.fingerprint.timestampPrecisionMs,
        indexedAtMs: this.#now(),
      };
      const committed = await this.#dependencies.store.replaceFile(metadataOnly, chunks.value);
      if (!committed.ok)
        this.#recordError(progress, file.fileId, file.relativePath, committed.error);
      else progress.unchangedFiles += 1;
      return ok(false);
    }

    progress.phase = "extracting";
    this.#publish(progress);
    const extraction = await this.#dependencies.extraction.process(file);
    if (!extraction.ok) {
      const marked = await this.#dependencies.store.markFileFailed(file, extraction.error);
      this.#recordError(
        progress,
        file.fileId,
        file.relativePath,
        marked.ok ? extraction.error : marked.error,
      );
      return ok(marked.ok);
    }
    progress.totalChunks += extraction.value.chunks.length;

    const priorChunks = await this.#dependencies.store.getChunks(file.fileId);
    if (!priorChunks.ok) {
      this.#recordError(progress, file.fileId, file.relativePath, priorChunks.error);
      return ok(false);
    }
    const reusable = new Map(
      priorChunks.value
        .filter(
          (chunk) =>
            chunk.vector.length === this.#config.embedding.vectorDimension &&
            chunk.extractorVersion === this.#config.index.extractorVersion &&
            chunk.chunkerVersion === this.#config.index.chunkerVersion,
        )
        .map((chunk) => [`${chunk.chunkId}\0${chunk.contentHash}`, chunk.vector] as const),
    );
    const missing = extraction.value.chunks.filter(
      (chunk) => !reusable.has(`${chunk.chunkId}\0${chunk.contentHash}`),
    );
    let embedded: readonly (readonly number[])[] = [];
    if (missing.length > 0) {
      progress.phase = "embedding";
      this.#publish(progress);
      const result = await this.#dependencies.embeddings.embedDocuments(
        missing.map((chunk) => chunk.searchText),
        {
          ...(signal ? { signal } : {}),
          onBatch: () => {
            progress.batchesCompleted += 1;
            this.#publish(progress);
          },
        },
      );
      if (!result.ok) {
        if (result.error.code === "EMBEDDING_CANCELLED") return this.#cancelError();
        const marked = await this.#dependencies.store.markFileFailed(file, result.error);
        this.#recordError(
          progress,
          file.fileId,
          file.relativePath,
          marked.ok ? result.error : marked.error,
        );
        return ok(marked.ok);
      }
      embedded = result.value;
      progress.embeddedChunks += embedded.length;
    }
    const newVectors = new Map(
      missing.map((chunk, index) => [chunk.chunkId, embedded[index]] as const),
    );
    const records: IndexedChunkRecord[] = [];
    for (const chunk of extraction.value.chunks) {
      const reused = reusable.get(`${chunk.chunkId}\0${chunk.contentHash}`);
      const vector = reused ?? newVectors.get(chunk.chunkId);
      if (!vector) {
        this.#recordError(progress, file.fileId, file.relativePath, {
          code: "INFERENCE_FAILED",
          message: "An embedding result was missing for a prepared chunk.",
        });
        return ok(false);
      }
      if (reused) progress.reusedChunks += 1;
      records.push(chunkRecord(this.#config, file, chunk, vector));
    }

    if (this.#cancelled(signal, progress)) return this.#cancelError();
    progress.phase = "committing";
    this.#publish(progress);
    const committed = await this.#dependencies.store.replaceFile(
      currentRecord(this.#config, file, extraction.value, this.#now()),
      records,
    );
    if (!committed.ok) {
      this.#recordError(progress, file.fileId, file.relativePath, committed.error);
      return ok(false);
    }
    progress.committedChunks += records.length;
    return ok(true);
  }

  #recordError(
    progress: MutableProgress,
    fileId: string,
    relativePath: string,
    issue: { readonly code: string; readonly message: string },
  ): void {
    progress.failedFiles += 1;
    progress.errors.push({ fileId, relativePath, code: issue.code, message: issue.message });
  }

  #cancelled(signal: AbortSignal | undefined, progress: MutableProgress): boolean {
    if (!signal?.aborted) return false;
    progress.phase = "cancelled";
    delete progress.currentFile;
    this.#publish(progress);
    return true;
  }

  #cancelError(): Result<never, IndexingError> {
    return err({ code: "INDEXING_CANCELLED", message: "Indexing was cancelled." });
  }

  #estimate(progress: MutableProgress, startedAt: number): void {
    if (progress.processedFiles === 0 || progress.processedFiles >= progress.totalFiles) {
      delete progress.estimatedCompletionMs;
      return;
    }
    const now = this.#now();
    const elapsed = Math.max(0, now - startedAt);
    const remaining =
      (elapsed / progress.processedFiles) * (progress.totalFiles - progress.processedFiles);
    progress.estimatedCompletionMs = now + Math.round(remaining);
  }

  #publish(progress: MutableProgress): void {
    const value = snapshot(progress);
    for (const listener of this.#listeners) listener(value);
  }
}

export function createIndexingService(
  config: AppConfig,
  dependencies: IndexingDependencies,
  options?: ConstructorParameters<typeof RepositoryIndexingService>[2],
): RepositoryIndexingService {
  return new RepositoryIndexingService(config, dependencies, options);
}
