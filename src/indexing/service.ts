import { createHash } from "node:crypto";
import type { AppConfig } from "../config/index.ts";
import type { DiscoveredFile, FileChange } from "../discovery/index.ts";
import type { ExtractedFile, SearchChunk } from "../extraction/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type {
  EmbeddingBatchMetric,
  EmbeddingVector,
  IndexedChunkRecord,
  IndexedFileRecord,
  IndexingDependencies,
  IndexingError,
  IndexingFileError,
  IndexingProgress,
  IndexingRunResult,
  IndexingService,
  IndexingTiming,
  ReusableChunkRecord,
} from "./contracts.ts";

const EMBEDDING_INPUT_VERSION = 1;

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

interface MutableTiming {
  warmUpMs: number;
  preparationMs: number;
  embeddingMs: number;
  commitMs: number;
  finalizationMs: number;
  stageWaitMs: { preparation: number; embedding: number; commit: number };
  pipelineWallMs: number;
  maximumInFlight: {
    preparedWindows: number;
    embeddedWindows: number;
    preparedFiles: number;
    preparedChunks: number;
    vectorBytes: number;
  };
  embeddingUtilization: {
    usefulTokens: number;
    paddedTokens: number;
    inferenceMs: number;
    batches: number;
  };
}

interface FileIssue {
  readonly code: string;
  readonly message: string;
}

interface PreparedChunk {
  readonly chunk: SearchChunk;
  readonly embeddingInputHash: string;
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
    }
  | {
      readonly kind: "content";
      readonly file: DiscoveredFile;
      readonly extracted: ExtractedFile;
      readonly chunks: readonly PreparedChunk[];
      readonly reusable: ReadonlyMap<string, EmbeddingVector>;
      readonly missing: readonly PreparedChunk[];
    };

interface PreparedWindow {
  readonly index: number;
  readonly files: readonly PreparedFile[];
  readonly preparedFiles: number;
  readonly preparedChunks: number;
}

interface EmbeddedFile {
  readonly prepared: Extract<PreparedFile, { readonly kind: "content" }>;
  readonly vectors?: readonly EmbeddingVector[];
  readonly error?: FileIssue;
}

interface EmbeddedWindow {
  readonly prepared: PreparedWindow;
  readonly files: readonly EmbeddedFile[];
  readonly vectorBytes: number;
}

class AsyncChannel<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<(item: T | undefined) => void> = [];
  #closed = false;

  push(item: T): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter) waiter(item);
    else this.#items.push(item);
    return true;
  }

  shift(signal: AbortSignal): Promise<T | undefined> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.#closed || signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const finish = (value: T | undefined) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => {
        const index = this.#waiters.indexOf(finish);
        if (index >= 0) this.#waiters.splice(index, 1);
        finish(undefined);
      };
      this.#waiters.push(finish);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  close(discard = false): void {
    this.#closed = true;
    if (discard) this.#items.length = 0;
    if (this.#items.length === 0) {
      for (const waiter of this.#waiters.splice(0)) waiter(undefined);
    }
  }
}

class AsyncSemaphore {
  readonly #waiters: Array<(acquired: boolean) => void> = [];
  #available: number;
  #closed = false;

  constructor(capacity: number) {
    this.#available = capacity;
  }

  acquire(signal: AbortSignal): Promise<boolean> {
    if (this.#closed || signal.aborted) return Promise.resolve(false);
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const finish = (acquired: boolean) => {
        signal.removeEventListener("abort", abort);
        resolve(acquired);
      };
      const abort = () => {
        const index = this.#waiters.indexOf(finish);
        if (index >= 0) this.#waiters.splice(index, 1);
        finish(false);
      };
      this.#waiters.push(finish);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  release(): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter(true);
    else this.#available += 1;
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter(false);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableFingerprint(file: DiscoveredFile): string {
  return sha256(
    JSON.stringify({
      size: file.fingerprint.size,
      modifiedAtNs: file.fingerprint.modifiedAtNs,
      changedAtNs: file.fingerprint.changedAtNs,
      contentHash: file.fingerprint.contentHash ?? "",
    }),
  );
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
    indexedAtMs: now,
  };
}

function embeddingInputHash(dependencies: IndexingDependencies, chunk: SearchChunk): string {
  return sha256(
    `embedding-input-v${EMBEDDING_INPUT_VERSION}\0${dependencies.embeddings.encodeDocument(chunk.searchText)}`,
  );
}

function reusableCompatibility(config: AppConfig, candidate: ReusableChunkRecord): boolean {
  const profile = config.embedding.profile;
  return (
    candidate.embeddingInputVersion === EMBEDDING_INPUT_VERSION &&
    candidate.embeddingModelId === config.embedding.modelId &&
    candidate.embeddingRevision === profile.revision &&
    candidate.embeddingProfileVersion === profile.profileVersion &&
    candidate.embeddingDimension === config.embedding.vectorDimension &&
    candidate.poolingVersion === profile.pooling.version &&
    candidate.documentEncodingVersion === profile.documentEncoding.version &&
    candidate.tokenizerVersion === profile.tokenizer.version &&
    candidate.normalization === config.embedding.normalization &&
    candidate.extractorVersion === config.index.extractorVersion &&
    candidate.chunkerVersion === config.index.chunkerVersion &&
    candidate.indexSchemaVersion === config.index.schemaVersion &&
    candidate.vector.length === config.embedding.vectorDimension &&
    candidate.vector.every(Number.isFinite)
  );
}

function chunkRecord(
  config: AppConfig,
  file: DiscoveredFile,
  prepared: PreparedChunk,
  vector: EmbeddingVector,
): IndexedChunkRecord {
  const chunk = prepared.chunk;
  return {
    chunkId: chunk.chunkId,
    fileId: chunk.fileId,
    relativePath: chunk.relativePath,
    filename: file.filename,
    format: file.format,
    ordinal: chunk.ordinal,
    displayText: chunk.displayText,
    searchText: chunk.searchText,
    embeddingInputHash: prepared.embeddingInputHash,
    embeddingInputVersion: EMBEDDING_INPUT_VERSION,
    embeddingModelId: config.embedding.modelId,
    embeddingRevision: config.embedding.profile.revision,
    embeddingProfileVersion: config.embedding.profile.profileVersion,
    embeddingDimension: config.embedding.vectorDimension,
    poolingVersion: config.embedding.profile.pooling.version,
    documentEncodingVersion: config.embedding.profile.documentEncoding.version,
    tokenizerVersion: config.embedding.profile.tokenizer.version,
    normalization: config.embedding.normalization,
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
  return {
    totalMs,
    warmUpMs: timing.warmUpMs,
    preparationMs: timing.preparationMs,
    embeddingMs: timing.embeddingMs,
    commitMs: timing.commitMs,
    finalizationMs: timing.finalizationMs,
    stageWaitMs: { ...timing.stageWaitMs },
    pipelineWallMs: timing.pipelineWallMs,
    maximumInFlight: { ...timing.maximumInFlight },
    embeddingUtilization: { ...timing.embeddingUtilization },
  };
}

function elapsed(clock: () => number, started: number): number {
  return Math.max(0, clock() - started);
}

export class RepositoryIndexingService implements IndexingService {
  readonly #config: AppConfig;
  readonly #dependencies: IndexingDependencies;
  readonly #listeners = new Set<(progress: IndexingProgress) => void>();
  readonly #now: () => number;
  readonly #clock: () => number;
  readonly #windowSize: number;
  readonly #preparedCapacity: number;
  readonly #embeddedCapacity: number;

  constructor(
    config: AppConfig,
    dependencies: IndexingDependencies,
    options: {
      readonly now?: () => number;
      readonly clock?: () => number;
      readonly preparationWindowSize?: number;
      readonly preparedWindowCapacity?: number;
      readonly embeddedWindowCapacity?: number;
    } = {},
  ) {
    this.#config = config;
    this.#dependencies = dependencies;
    this.#now = options.now ?? Date.now;
    this.#clock = options.clock ?? performance.now.bind(performance);
    this.#windowSize = Math.max(1, Math.min(256, options.preparationWindowSize ?? 32));
    this.#preparedCapacity = Math.max(1, Math.min(4, options.preparedWindowCapacity ?? 2));
    this.#embeddedCapacity = Math.max(1, Math.min(4, options.embeddedWindowCapacity ?? 2));
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
      stageWaitMs: { preparation: 0, embedding: 0, commit: 0 },
      pipelineWallMs: 0,
      maximumInFlight: {
        preparedWindows: 0,
        embeddedWindows: 0,
        preparedFiles: 0,
        preparedChunks: 0,
        vectorBytes: 0,
      },
      embeddingUtilization: { usefulTokens: 0, paddedTokens: 0, inferenceMs: 0, batches: 0 },
    };
    const startedAt = this.#now();
    const totalStarted = this.#clock();
    let searchDataChanged = false;
    this.#publish(progress);

    const warmStarted = this.#clock();
    const warm = await this.#dependencies.embeddings.warmUp();
    timing.warmUpMs += elapsed(this.#clock, warmStarted);
    if (!warm.ok) return err({ code: "INDEXING_FATAL", message: warm.error.message });

    for (const change of deletions) {
      if (signal?.aborted) return this.#cancel(progress);
      progress.currentFile = change.relativePath;
      progress.phase = "deleting";
      this.#publish(progress);
      const commitStarted = this.#clock();
      const deleted = await this.#dependencies.store.deleteFile(change.fileId);
      timing.commitMs += elapsed(this.#clock, commitStarted);
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
    if (ordered.length > 0) {
      const pipelineStarted = this.#clock();
      const pipelined = await this.#runPipeline(ordered, progress, timing, startedAt, signal);
      timing.pipelineWallMs = elapsed(this.#clock, pipelineStarted);
      if (!pipelined.ok) {
        if (pipelined.error.code === "INDEXING_CANCELLED") return this.#cancel(progress);
        return pipelined;
      }
      searchDataChanged ||= pipelined.value;
    }

    delete progress.currentFile;
    progress.phase = "finalizing";
    this.#publish(progress);
    if (searchDataChanged) {
      const finalStarted = this.#clock();
      const refreshed = await this.#dependencies.store.refreshSearchIndexes();
      timing.finalizationMs += elapsed(this.#clock, finalStarted);
      if (!refreshed.ok) return err({ code: "INDEXING_FATAL", message: refreshed.error.message });
    }
    progress.phase = "complete";
    delete progress.estimatedCompletionMs;
    this.#publish(progress);
    return ok({
      progress: snapshot(progress),
      timing: timingSnapshot(timing, elapsed(this.#clock, totalStarted)),
    });
  }

  async #runPipeline(
    ordered: readonly DiscoveredFile[],
    progress: MutableProgress,
    timing: MutableTiming,
    startedAt: number,
    externalSignal?: AbortSignal,
  ): Promise<Result<boolean, IndexingError>> {
    const controller = new AbortController();
    const signal = controller.signal;
    const prepared = new AsyncChannel<PreparedWindow>();
    const embedded = new AsyncChannel<EmbeddedWindow>();
    const preparedSlots = new AsyncSemaphore(this.#preparedCapacity);
    const embeddedSlots = new AsyncSemaphore(this.#embeddedCapacity);
    let preparedWindows = 0;
    let embeddedWindows = 0;
    let preparedFiles = 0;
    let preparedChunks = 0;
    let vectorBytes = 0;
    let fatal: IndexingError | undefined;
    let changed = false;

    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) controller.abort();

    const fail = (error: IndexingError) => {
      fatal ??= error;
      controller.abort();
      prepared.close(true);
      embedded.close(true);
      preparedSlots.close();
      embeddedSlots.close();
    };
    const updateMaximum = () => {
      timing.maximumInFlight.preparedWindows = Math.max(
        timing.maximumInFlight.preparedWindows,
        preparedWindows,
      );
      timing.maximumInFlight.embeddedWindows = Math.max(
        timing.maximumInFlight.embeddedWindows,
        embeddedWindows,
      );
      timing.maximumInFlight.preparedFiles = Math.max(
        timing.maximumInFlight.preparedFiles,
        preparedFiles,
      );
      timing.maximumInFlight.preparedChunks = Math.max(
        timing.maximumInFlight.preparedChunks,
        preparedChunks,
      );
      timing.maximumInFlight.vectorBytes = Math.max(
        timing.maximumInFlight.vectorBytes,
        vectorBytes,
      );
    };

    const produce = async () => {
      try {
        for (
          let offset = 0, index = 0;
          offset < ordered.length;
          offset += this.#windowSize, index++
        ) {
          const waitStarted = this.#clock();
          const acquired = await preparedSlots.acquire(signal);
          timing.stageWaitMs.preparation += elapsed(this.#clock, waitStarted);
          if (!acquired || signal.aborted) break;
          const busyStarted = this.#clock();
          const result = await this.#prepareWindow(
            index,
            ordered.slice(offset, offset + this.#windowSize),
            progress,
            signal,
          );
          timing.preparationMs += elapsed(this.#clock, busyStarted);
          if (!result.ok) {
            preparedSlots.release();
            fail(result.error);
            break;
          }
          if (signal.aborted) {
            preparedSlots.release();
            break;
          }
          preparedWindows += 1;
          preparedFiles += result.value.preparedFiles;
          preparedChunks += result.value.preparedChunks;
          updateMaximum();
          if (!prepared.push(result.value)) {
            preparedSlots.release();
            break;
          }
        }
      } catch (error) {
        fail({
          code: "INDEXING_FATAL",
          message: error instanceof Error ? error.message : "Index preparation failed.",
        });
      } finally {
        prepared.close();
      }
    };

    const embedWindows = async () => {
      try {
        for (;;) {
          const waitStarted = this.#clock();
          const window = await prepared.shift(signal);
          timing.stageWaitMs.embedding += elapsed(this.#clock, waitStarted);
          if (!window) break;
          const vectorWaitStarted = this.#clock();
          const acquired = await embeddedSlots.acquire(signal);
          timing.stageWaitMs.embedding += elapsed(this.#clock, vectorWaitStarted);
          if (!acquired || signal.aborted) {
            preparedSlots.release();
            break;
          }
          const busyStarted = this.#clock();
          const result = await this.#embedWindow(window, progress, timing, signal);
          timing.embeddingMs += elapsed(this.#clock, busyStarted);
          if (!result.ok) {
            embeddedSlots.release();
            preparedSlots.release();
            if (result.error.code === "INDEXING_CANCELLED") controller.abort();
            else fail(result.error);
            break;
          }
          preparedWindows -= 1;
          preparedFiles -= window.preparedFiles;
          preparedChunks -= window.preparedChunks;
          preparedSlots.release();
          if (signal.aborted) {
            embeddedSlots.release();
            break;
          }
          embeddedWindows += 1;
          vectorBytes += result.value.vectorBytes;
          updateMaximum();
          if (!embedded.push(result.value)) {
            embeddedSlots.release();
            break;
          }
        }
      } catch (error) {
        fail({
          code: "INDEXING_FATAL",
          message: error instanceof Error ? error.message : "Embedding failed.",
        });
      } finally {
        embedded.close();
      }
    };

    const commitWindows = async () => {
      try {
        let expectedIndex = 0;
        for (;;) {
          const waitStarted = this.#clock();
          const window = await embedded.shift(signal);
          timing.stageWaitMs.commit += elapsed(this.#clock, waitStarted);
          if (!window) break;
          if (signal.aborted) {
            embeddedSlots.release();
            break;
          }
          if (window.prepared.index !== expectedIndex) {
            fail({
              code: "INDEXING_FATAL",
              message: "Index windows reached the writer out of order.",
            });
            embeddedSlots.release();
            break;
          }
          expectedIndex += 1;
          const busyStarted = this.#clock();
          const windowChanged = await this.#commitWindow(window, progress, startedAt, signal);
          changed ||= windowChanged;
          timing.commitMs += elapsed(this.#clock, busyStarted);
          embeddedWindows -= 1;
          vectorBytes -= window.vectorBytes;
          embeddedSlots.release();
        }
      } catch (error) {
        fail({
          code: "INDEXING_FATAL",
          message: error instanceof Error ? error.message : "Index persistence failed.",
        });
      }
    };

    await Promise.all([produce(), embedWindows(), commitWindows()]);
    externalSignal?.removeEventListener("abort", abort);
    preparedSlots.close();
    embeddedSlots.close();
    if (fatal) return err(fatal);
    if (externalSignal?.aborted || signal.aborted) return this.#cancelError();
    return ok(changed);
  }

  async #prepareWindow(
    index: number,
    window: readonly DiscoveredFile[],
    progress: MutableProgress,
    signal: AbortSignal,
  ): Promise<Result<PreparedWindow, IndexingError>> {
    const existing = await this.#dependencies.store.getFiles(window.map((file) => file.fileId));
    if (!existing.ok) return err({ code: "INDEXING_FATAL", message: existing.error.message });
    const existingById = new Map(existing.value.map((file) => [file.fileId, file]));
    const priorIds = window
      .filter((file) => {
        const record = existingById.get(file.fileId);
        return (
          file.readStatus === "ready" &&
          Boolean(file.fingerprint.contentHash) &&
          !isCompatible(this.#config, file, record)
        );
      })
      .map((file) => file.fileId);
    const prior = await this.#dependencies.store.getReusableChunksForFiles(priorIds);
    if (!prior.ok) return err({ code: "INDEXING_FATAL", message: prior.error.message });
    const priorByFile = new Map<string, ReusableChunkRecord[]>();
    for (const chunk of prior.value) {
      const values = priorByFile.get(chunk.fileId) ?? [];
      values.push(chunk);
      priorByFile.set(chunk.fileId, values);
    }
    const files = await Promise.all(
      window.map((file) =>
        this.#prepareFile(
          file,
          existingById.get(file.fileId),
          priorByFile.get(file.fileId) ?? [],
          progress,
          signal,
        ),
      ),
    );
    let chunks = 0;
    for (const file of files) {
      if (file.kind === "content") {
        chunks += file.chunks.length;
        progress.totalChunks += file.chunks.length;
      }
    }
    return ok({ index, files, preparedFiles: files.length, preparedChunks: chunks });
  }

  async #prepareFile(
    file: DiscoveredFile,
    existing: IndexedFileRecord | undefined,
    priorChunks: readonly ReusableChunkRecord[],
    progress: MutableProgress,
    signal: AbortSignal,
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
      };
    }

    progress.phase = "extracting";
    this.#publish(progress);
    const extraction = await this.#dependencies.extraction.process(file, { signal });
    if (!extraction.ok) return { kind: "failed", file, issue: extraction.error };
    const chunks = extraction.value.chunks.map((chunk) => ({
      chunk,
      embeddingInputHash: embeddingInputHash(this.#dependencies, chunk),
    }));
    const reusableByInput = new Map<string, ReusableChunkRecord[]>();
    for (const candidate of priorChunks) {
      if (!reusableCompatibility(this.#config, candidate)) continue;
      const values = reusableByInput.get(candidate.embeddingInputHash) ?? [];
      values.push(candidate);
      reusableByInput.set(candidate.embeddingInputHash, values);
    }
    for (const values of reusableByInput.values()) {
      values.sort((left, right) => left.chunkId.localeCompare(right.chunkId));
    }
    const reusable = new Map<string, EmbeddingVector>();
    const missing: PreparedChunk[] = [];
    for (const prepared of chunks) {
      const candidates = reusableByInput.get(prepared.embeddingInputHash);
      const candidate = candidates?.shift();
      if (candidate) reusable.set(prepared.chunk.chunkId, candidate.vector);
      else missing.push(prepared);
    }
    return { kind: "content", file, extracted: extraction.value, chunks, reusable, missing };
  }

  async #embedWindow(
    prepared: PreparedWindow,
    progress: MutableProgress,
    timing: MutableTiming,
    signal: AbortSignal,
  ): Promise<Result<EmbeddedWindow, IndexingError>> {
    const content = prepared.files.filter(
      (item): item is Extract<PreparedFile, { readonly kind: "content" }> =>
        item.kind === "content",
    );
    const missing = content.flatMap((item) => item.missing);
    const reusedCount = content.reduce((sum, item) => sum + item.reusable.size, 0);
    const vectorBytes =
      (missing.length + reusedCount) *
      this.#config.embedding.vectorDimension *
      Float32Array.BYTES_PER_ELEMENT;
    if (missing.length === 0) {
      return ok({
        prepared,
        files: content.map((item) => ({ prepared: item, vectors: [] })),
        vectorBytes,
      });
    }
    progress.phase = "embedding";
    this.#publish(progress);
    const onBatch = (_completed: number, _total: number, metric?: EmbeddingBatchMetric) => {
      progress.batchesCompleted += 1;
      if (metric) {
        timing.embeddingUtilization.usefulTokens += metric.usefulTokens;
        timing.embeddingUtilization.paddedTokens += metric.paddedTokens;
        timing.embeddingUtilization.inferenceMs += metric.inferenceMs;
        timing.embeddingUtilization.batches += 1;
        timing.stageWaitMs.embedding += metric.queueWaitMs;
      }
      this.#publish(progress);
    };
    const result = await this.#dependencies.embeddings.embedDocuments(
      missing.map((item) => item.chunk.searchText),
      {
        signal,
        onBatch,
        tokenCounts: missing.map((item) => item.chunk.tokenCount),
      },
    );
    if (result.ok) {
      progress.embeddedChunks += result.value.length;
      let cursor = 0;
      return ok({
        prepared,
        vectorBytes,
        files: content.map((item) => {
          const vectors = result.value.slice(cursor, cursor + item.missing.length);
          cursor += item.missing.length;
          return { prepared: item, vectors };
        }),
      });
    }
    if (result.error.code === "EMBEDDING_CANCELLED") return this.#cancelError();

    const isolated: EmbeddedFile[] = [];
    for (const item of content) {
      if (signal.aborted) return this.#cancelError();
      if (item.missing.length === 0) {
        isolated.push({ prepared: item, vectors: [] });
        continue;
      }
      const retry = await this.#dependencies.embeddings.embedDocuments(
        item.missing.map((chunk) => chunk.chunk.searchText),
        {
          signal,
          onBatch,
          tokenCounts: item.missing.map((chunk) => chunk.chunk.tokenCount),
        },
      );
      if (!retry.ok && retry.error.code === "EMBEDDING_CANCELLED") return this.#cancelError();
      if (retry.ok) {
        progress.embeddedChunks += retry.value.length;
        isolated.push({ prepared: item, vectors: retry.value });
      } else isolated.push({ prepared: item, error: retry.error });
    }
    return ok({ prepared, files: isolated, vectorBytes });
  }

  async #commitWindow(
    window: EmbeddedWindow,
    progress: MutableProgress,
    startedAt: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    let searchDataChanged = false;
    const embeddedByFile = new Map(window.files.map((item) => [item.prepared.file.fileId, item]));
    const metadata: Array<Extract<PreparedFile, { readonly kind: "metadata" }>> = [];
    const entries: Array<{
      readonly file: IndexedFileRecord;
      readonly chunks: readonly IndexedChunkRecord[];
      readonly source: Extract<PreparedFile, { readonly kind: "content" }>;
    }> = [];

    for (const item of window.prepared.files) {
      progress.currentFile = item.file.relativePath;
      if (item.kind === "unchanged") {
        progress.unchangedFiles += 1;
        continue;
      }
      if (item.kind === "metadata") {
        metadata.push(item);
        continue;
      }
      if (signal.aborted) break;
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
        item.missing.map((chunk, index) => [chunk.chunk.chunkId, result.vectors?.[index]] as const),
      );
      const records: IndexedChunkRecord[] = [];
      for (const chunk of item.chunks) {
        const vector =
          item.reusable.get(chunk.chunk.chunkId) ?? newVectors.get(chunk.chunk.chunkId);
        if (!vector) break;
        records.push(chunkRecord(this.#config, item.file, chunk, vector));
      }
      if (records.length !== item.chunks.length) {
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

    if (!signal.aborted && metadata.length > 0) {
      progress.phase = "committing";
      this.#publish(progress);
      const updated = await this.#dependencies.store.updateFiles(
        metadata.map((item) => item.record),
      );
      if (!updated.ok) {
        for (const item of metadata) {
          this.#recordError(progress, item.file.fileId, item.file.relativePath, updated.error);
        }
      } else progress.unchangedFiles += metadata.length;
    }
    if (!signal.aborted && entries.length > 0) {
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
          progress.reusedChunks += entry.source.reusable.size;
          progress.committedChunks += entry.chunks.length;
        }
        searchDataChanged = true;
      }
    }
    if (!signal.aborted) {
      for (const item of window.prepared.files) {
        progress.currentFile = item.file.relativePath;
        this.#processed(progress, startedAt);
      }
    }
    return searchDataChanged;
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

  #cancel(progress: MutableProgress): Result<never, IndexingError> {
    progress.phase = "cancelled";
    delete progress.currentFile;
    this.#publish(progress);
    return this.#cancelError();
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
    const elapsedMs = Math.max(0, now - startedAt);
    const remaining =
      (elapsedMs / progress.processedFiles) * (progress.totalFiles - progress.processedFiles);
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
