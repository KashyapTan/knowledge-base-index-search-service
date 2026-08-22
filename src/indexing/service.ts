import { createHash } from "node:crypto";
import type { AppConfig } from "../config/index.ts";
import type { DiscoveredFile, FileChange } from "../discovery/index.ts";
import type { ExtractedFile, SearchChunk } from "../extraction/index.ts";
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
  IndexingTiming,
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

type TimingStage = Exclude<keyof IndexingTiming, "totalMs">;
type MutableTiming = Record<TimingStage, number>;

interface FileIssue {
  readonly code: string;
  readonly message: string;
}

type PreparedFile =
  | { readonly kind: "unchanged"; readonly file: DiscoveredFile }
  | {
      readonly kind: "skipped";
      readonly file: DiscoveredFile;
      readonly issue: FileIssue;
      readonly shouldStore: boolean;
    }
  | { readonly kind: "failed"; readonly file: DiscoveredFile; readonly issue: FileIssue }
  | {
      readonly kind: "metadata";
      readonly file: DiscoveredFile;
      readonly record: IndexedFileRecord;
      readonly chunks: readonly IndexedChunkRecord[];
    }
  | {
      readonly kind: "content";
      readonly file: DiscoveredFile;
      readonly extracted: ExtractedFile;
      readonly reusable: ReadonlyMap<string, readonly number[]>;
      readonly missing: readonly SearchChunk[];
    };

interface EmbeddedFile {
  readonly prepared: Extract<PreparedFile, { readonly kind: "content" }>;
  readonly vectors?: readonly (readonly number[])[];
  readonly error?: FileIssue;
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

function isCompatible(
  config: AppConfig,
  file: DiscoveredFile,
  record?: IndexedFileRecord,
): boolean {
  return (
    record?.indexStatus === "indexed" &&
    record.contentHash === file.fingerprint.contentHash &&
    record.extractorVersion === config.index.extractorVersion &&
    record.chunkerVersion === config.index.chunkerVersion &&
    record.indexSchemaVersion === config.index.schemaVersion
  );
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

function metadataRecord(
  record: IndexedFileRecord,
  file: DiscoveredFile,
  now: number,
): IndexedFileRecord {
  return {
    ...record,
    fingerprintHash: stableFingerprint(file),
    size: file.fingerprint.size,
    modifiedAtMs: file.fingerprint.modifiedAtMs,
    modifiedAtNs: file.fingerprint.modifiedAtNs,
    changedAtNs: file.fingerprint.changedAtNs,
    timestampPrecisionMs: file.fingerprint.timestampPrecisionMs,
    indexedAtMs: now,
  };
}

function chunkRecord(
  config: AppConfig,
  file: DiscoveredFile,
  chunk: SearchChunk,
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

function timingSnapshot(timing: MutableTiming, totalMs: number): IndexingTiming {
  return { totalMs, ...timing };
}

export class RepositoryIndexingService implements IndexingService {
  readonly #config: AppConfig;
  readonly #dependencies: IndexingDependencies;
  readonly #listeners = new Set<(progress: IndexingProgress) => void>();
  readonly #now: () => number;
  readonly #clock: () => number;
  readonly #windowSize: number;

  constructor(
    config: AppConfig,
    dependencies: IndexingDependencies,
    options: {
      readonly now?: () => number;
      readonly clock?: () => number;
      readonly preparationWindowSize?: number;
    } = {},
  ) {
    this.#config = config;
    this.#dependencies = dependencies;
    this.#now = options.now ?? Date.now;
    this.#clock = options.clock ?? performance.now.bind(performance);
    this.#windowSize = Math.max(1, Math.min(256, options.preparationWindowSize ?? 64));
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
    const timing: MutableTiming = {
      warmUpMs: 0,
      preparationMs: 0,
      embeddingMs: 0,
      commitMs: 0,
      finalizationMs: 0,
    };
    const startedAt = this.#now();
    const totalStarted = this.#clock();
    let searchDataChanged = false;
    this.#publish(progress);

    const warm = await this.#timed(timing, "warmUpMs", () =>
      this.#dependencies.embeddings.warmUp(),
    );
    if (!warm.ok) return err({ code: "INDEXING_FATAL", message: warm.error.message });

    for (const change of deletions) {
      if (this.#cancelled(signal, progress)) return this.#cancelError();
      progress.currentFile = change.relativePath;
      progress.phase = "deleting";
      this.#publish(progress);
      const deleted = await this.#timed(timing, "commitMs", () =>
        this.#dependencies.store.deleteFile(change.fileId),
      );
      if (!deleted.ok)
        this.#recordError(progress, change.fileId, change.relativePath, deleted.error);
      else {
        progress.deletedFiles += 1;
        searchDataChanged = true;
      }
      this.#processed(progress, startedAt);
    }

    const ordered = [...files].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
    const existing = await this.#timed(timing, "preparationMs", () =>
      this.#dependencies.store.getFiles(ordered.map((file) => file.fileId)),
    );
    if (!existing.ok) return err({ code: "INDEXING_FATAL", message: existing.error.message });
    const existingById = new Map(existing.value.map((file) => [file.fileId, file]));
    const priorCandidateIds = ordered
      .filter((file) => {
        const record = existingById.get(file.fileId);
        return (
          file.readStatus === "ready" &&
          Boolean(file.fingerprint.contentHash) &&
          !(
            isCompatible(this.#config, file, record) &&
            record?.fingerprintHash === stableFingerprint(file)
          )
        );
      })
      .map((file) => file.fileId);
    const prior = await this.#timed(timing, "preparationMs", () =>
      this.#dependencies.store.getChunksForFiles(priorCandidateIds),
    );
    if (!prior.ok) return err({ code: "INDEXING_FATAL", message: prior.error.message });
    const priorByFile = new Map<string, IndexedChunkRecord[]>();
    for (const chunk of prior.value) {
      const chunks = priorByFile.get(chunk.fileId) ?? [];
      chunks.push(chunk);
      priorByFile.set(chunk.fileId, chunks);
    }

    for (let offset = 0; offset < ordered.length; offset += this.#windowSize) {
      if (this.#cancelled(signal, progress)) return this.#cancelError();
      const window = ordered.slice(offset, offset + this.#windowSize);
      const prepared = await this.#timed(timing, "preparationMs", () =>
        Promise.all(
          window.map((file) =>
            this.#prepareFile(
              file,
              existingById.get(file.fileId),
              priorByFile.get(file.fileId) ?? [],
              progress,
            ),
          ),
        ),
      );
      if (this.#cancelled(signal, progress)) return this.#cancelError();
      for (const item of prepared) {
        if (item.kind === "content") progress.totalChunks += item.extracted.chunks.length;
      }
      const embedded = await this.#timed(timing, "embeddingMs", () =>
        this.#embedWindow(prepared, progress, signal),
      );
      if (!embedded.ok) return embedded;
      if (this.#cancelled(signal, progress)) return this.#cancelError();
      const committed = await this.#timed(timing, "commitMs", () =>
        this.#commitWindow(prepared, embedded.value, progress, startedAt),
      );
      searchDataChanged ||= committed;
    }

    delete progress.currentFile;
    progress.phase = "finalizing";
    this.#publish(progress);
    if (searchDataChanged) {
      const refreshed = await this.#timed(timing, "finalizationMs", () =>
        this.#dependencies.store.refreshSearchIndexes(),
      );
      if (!refreshed.ok) return err({ code: "INDEXING_FATAL", message: refreshed.error.message });
    }
    progress.phase = "complete";
    delete progress.estimatedCompletionMs;
    this.#publish(progress);
    return ok({
      progress: snapshot(progress),
      timing: timingSnapshot(timing, this.#clock() - totalStarted),
    });
  }

  async #prepareFile(
    file: DiscoveredFile,
    existing: IndexedFileRecord | undefined,
    priorChunks: readonly IndexedChunkRecord[],
    progress: MutableProgress,
  ): Promise<PreparedFile> {
    progress.currentFile = file.relativePath;
    if (file.readStatus !== "ready" || !file.fingerprint.contentHash) {
      const issue = {
        code: "FILE_NOT_READY",
        message: file.lastError ?? "The discovered file is not ready for indexing.",
      };
      if (file.readStatus === "unsupported" || file.readStatus === "malformed") {
        return {
          kind: "skipped",
          file,
          issue,
          shouldStore: Boolean(existing && existing.indexStatus !== "failed"),
        };
      }
      return { kind: "failed", file, issue };
    }
    if (
      isCompatible(this.#config, file, existing) &&
      existing?.fingerprintHash === stableFingerprint(file)
    ) {
      return { kind: "unchanged", file };
    }
    if (isCompatible(this.#config, file, existing) && existing) {
      return {
        kind: "metadata",
        file,
        record: metadataRecord(existing, file, this.#now()),
        chunks: priorChunks,
      };
    }

    progress.phase = "extracting";
    this.#publish(progress);
    const extraction = await this.#dependencies.extraction.process(file);
    if (!extraction.ok) return { kind: "failed", file, issue: extraction.error };
    const reusable = new Map(
      priorChunks
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
    return { kind: "content", file, extracted: extraction.value, reusable, missing };
  }

  async #embedWindow(
    prepared: readonly PreparedFile[],
    progress: MutableProgress,
    signal?: AbortSignal,
  ): Promise<Result<readonly EmbeddedFile[], IndexingError>> {
    const content = prepared.filter(
      (item): item is Extract<PreparedFile, { readonly kind: "content" }> =>
        item.kind === "content",
    );
    const missing = content.flatMap((item) => item.missing);
    if (missing.length === 0) return ok(content.map((item) => ({ prepared: item, vectors: [] })));
    progress.phase = "embedding";
    this.#publish(progress);
    const onBatch = () => {
      progress.batchesCompleted += 1;
      this.#publish(progress);
    };
    const result = await this.#dependencies.embeddings.embedDocuments(
      missing.map((chunk) => chunk.searchText),
      {
        ...(signal ? { signal } : {}),
        onBatch,
        tokenCounts: missing.map((chunk) => chunk.tokenCount),
      },
    );
    if (result.ok) {
      progress.embeddedChunks += result.value.length;
      let cursor = 0;
      return ok(
        content.map((item) => {
          const vectors = result.value.slice(cursor, cursor + item.missing.length);
          cursor += item.missing.length;
          return { prepared: item, vectors };
        }),
      );
    }
    if (result.error.code === "EMBEDDING_CANCELLED") return this.#cancelError();

    // A failed corpus-wide batch is retried file-by-file so one malformed input cannot poison
    // otherwise healthy files. This slow path is used only after an inference failure.
    const isolated: EmbeddedFile[] = [];
    for (const item of content) {
      if (item.missing.length === 0) {
        isolated.push({ prepared: item, vectors: [] });
        continue;
      }
      const retry = await this.#dependencies.embeddings.embedDocuments(
        item.missing.map((chunk) => chunk.searchText),
        {
          ...(signal ? { signal } : {}),
          onBatch,
          tokenCounts: item.missing.map((chunk) => chunk.tokenCount),
        },
      );
      if (!retry.ok && retry.error.code === "EMBEDDING_CANCELLED") return this.#cancelError();
      if (retry.ok) {
        progress.embeddedChunks += retry.value.length;
        isolated.push({ prepared: item, vectors: retry.value });
      } else {
        isolated.push({ prepared: item, error: retry.error });
      }
    }
    return ok(isolated);
  }

  async #commitWindow(
    prepared: readonly PreparedFile[],
    embedded: readonly EmbeddedFile[],
    progress: MutableProgress,
    startedAt: number,
  ): Promise<boolean> {
    let searchDataChanged = false;
    const embeddedByFile = new Map(embedded.map((item) => [item.prepared.file.fileId, item]));
    const entries: Array<{
      readonly file: IndexedFileRecord;
      readonly chunks: readonly IndexedChunkRecord[];
      readonly source: PreparedFile;
    }> = [];

    for (const item of prepared) {
      progress.currentFile = item.file.relativePath;
      if (item.kind === "unchanged") {
        progress.unchangedFiles += 1;
        continue;
      }
      if (item.kind === "skipped") {
        progress.skippedFiles += 1;
        if (item.shouldStore) {
          const stored = await this.#dependencies.store.markFileFailed(item.file, item.issue);
          if (!stored.ok)
            this.#recordError(progress, item.file.fileId, item.file.relativePath, stored.error);
          else searchDataChanged = true;
        }
        continue;
      }
      if (item.kind === "failed") {
        const stored = await this.#dependencies.store.markFileFailed(item.file, item.issue);
        this.#recordError(
          progress,
          item.file.fileId,
          item.file.relativePath,
          stored.ok ? item.issue : stored.error,
        );
        searchDataChanged ||= stored.ok;
        continue;
      }
      if (item.kind === "metadata") {
        entries.push({ file: item.record, chunks: item.chunks, source: item });
        continue;
      }

      const result = embeddedByFile.get(item.file.fileId);
      if (!result || result.error) {
        const issue = result?.error ?? {
          code: "INFERENCE_FAILED",
          message: "An embedding result was missing for a prepared file.",
        };
        const stored = await this.#dependencies.store.markFileFailed(item.file, issue);
        this.#recordError(
          progress,
          item.file.fileId,
          item.file.relativePath,
          stored.ok ? issue : stored.error,
        );
        searchDataChanged ||= stored.ok;
        continue;
      }
      const newVectors = new Map(
        item.missing.map((chunk, index) => [chunk.chunkId, result.vectors?.[index]] as const),
      );
      const records: IndexedChunkRecord[] = [];
      let invalid = false;
      for (const chunk of item.extracted.chunks) {
        const reused = item.reusable.get(`${chunk.chunkId}\0${chunk.contentHash}`);
        const vector = reused ?? newVectors.get(chunk.chunkId);
        if (!vector) {
          invalid = true;
          break;
        }
        records.push(chunkRecord(this.#config, item.file, chunk, vector));
      }
      if (invalid) {
        const issue = {
          code: "INFERENCE_FAILED",
          message: "An embedding result was missing for a prepared chunk.",
        };
        const stored = await this.#dependencies.store.markFileFailed(item.file, issue);
        this.#recordError(
          progress,
          item.file.fileId,
          item.file.relativePath,
          stored.ok ? issue : stored.error,
        );
        searchDataChanged ||= stored.ok;
        continue;
      }
      entries.push({
        file: currentRecord(this.#config, item.file, item.extracted, this.#now()),
        chunks: records,
        source: item,
      });
    }

    if (entries.length > 0) {
      progress.phase = "committing";
      this.#publish(progress);
      const committed = await this.#dependencies.store.replaceFiles(entries);
      if (!committed.ok) {
        for (const entry of entries) {
          this.#recordError(
            progress,
            entry.source.file.fileId,
            entry.source.file.relativePath,
            committed.error,
          );
        }
      } else {
        for (const entry of entries) {
          if (entry.source.kind === "metadata") progress.unchangedFiles += 1;
          if (entry.source.kind === "content") {
            progress.reusedChunks += entry.source.extracted.chunks.filter((chunk) =>
              entry.source.kind === "content"
                ? entry.source.reusable.has(`${chunk.chunkId}\0${chunk.contentHash}`)
                : false,
            ).length;
            progress.committedChunks += entry.chunks.length;
            searchDataChanged = true;
          }
        }
      }
    }
    for (const item of prepared) {
      progress.currentFile = item.file.relativePath;
      this.#processed(progress, startedAt);
    }
    return searchDataChanged;
  }

  async #timed<T>(
    timing: MutableTiming,
    stage: TimingStage,
    operation: () => Promise<T>,
  ): Promise<T> {
    const started = this.#clock();
    try {
      return await operation();
    } finally {
      timing[stage] += this.#clock() - started;
    }
  }

  #recordError(
    progress: MutableProgress,
    fileId: string,
    relativePath: string,
    issue: FileIssue,
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

  #processed(progress: MutableProgress, startedAt: number): void {
    progress.processedFiles += 1;
    this.#estimate(progress, startedAt);
    this.#publish(progress);
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
