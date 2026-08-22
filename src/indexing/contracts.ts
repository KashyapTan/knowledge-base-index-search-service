import type { DataType } from "@huggingface/transformers";
import type { EmbeddingDevice } from "../config/index.ts";
import type { DiscoveredFile, FileChange } from "../discovery/index.ts";
import type { ExtractedFile, ExtractionPipeline, SearchChunk } from "../extraction/index.ts";
import type { AppError, Result } from "../shared/result.ts";

export interface EmbeddingIdentity {
  readonly device: EmbeddingDevice;
  readonly modelId: string;
  readonly quantization: DataType;
  readonly vectorDimension: number;
  readonly maximumTokens: number;
  readonly normalization: "l2";
}

export interface EmbedOptions {
  readonly signal?: AbortSignal;
  /** Exact tokenizer counts let accelerator backends build homogeneous fixed-shape batches. */
  readonly tokenCounts?: readonly number[];
  readonly onBatch?: (completed: number, total: number) => void;
}

export type EmbeddingErrorCode =
  | "MODEL_ASSETS_MISSING"
  | "MODEL_ASSETS_INVALID"
  | "MODEL_LOAD_FAILED"
  | "INFERENCE_FAILED"
  | "VECTOR_DIMENSION_INVALID"
  | "VECTOR_NORMALIZATION_INVALID"
  | "EMBEDDING_QUEUE_FULL"
  | "EMBEDDING_CANCELLED"
  | "EMBEDDING_PROVIDER_CLOSED";

export interface EmbeddingError extends AppError<EmbeddingErrorCode> {}

export type ModelSetupPhase =
  | "verifying"
  | "recovering"
  | "loading-local"
  | "downloading"
  | "ready";

export interface ModelWarmUpOptions {
  readonly allowDownload?: boolean;
  readonly downloadRetries?: number;
  readonly recoverCorruptAssets?: boolean;
  readonly onProgress?: (phase: ModelSetupPhase, message: string) => void;
}

export interface EmbeddingProvider {
  readonly identity: EmbeddingIdentity;
  readonly batchSize: number;
  encodeDocument(text: string): string;
  encodeQuery(text: string): string;
  warmUp(options?: ModelWarmUpOptions): Promise<Result<void, EmbeddingError>>;
  embedDocuments(
    texts: readonly string[],
    options?: EmbedOptions,
  ): Promise<Result<readonly (readonly number[])[], EmbeddingError>>;
  embedQuery(
    text: string,
    options?: Pick<EmbedOptions, "signal">,
  ): Promise<Result<readonly number[], EmbeddingError>>;
  shutdown(): Promise<void>;
}

export type FileExtractionStatus = "extracted" | "failed";
export type FileIndexStatus = "indexed" | "failed";

export interface IndexedFileRecord {
  readonly fileId: string;
  readonly relativePath: string;
  readonly filename: string;
  readonly format: string;
  readonly mimeFamily: string;
  readonly fingerprintHash: string;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly modifiedAtNs: string;
  readonly changedAtNs: string;
  readonly timestampPrecisionMs: number;
  readonly extractionStatus: FileExtractionStatus;
  readonly indexStatus: FileIndexStatus;
  readonly contentHash: string;
  readonly lastError: string;
  readonly chunkCount: number;
  readonly extractorVersion: number;
  readonly chunkerVersion: number;
  readonly indexSchemaVersion: number;
  readonly indexedAtMs: number;
}

export interface IndexedChunkRecord {
  readonly chunkId: string;
  readonly fileId: string;
  readonly relativePath: string;
  readonly filename: string;
  readonly format: string;
  readonly ordinal: number;
  readonly displayText: string;
  readonly searchText: string;
  readonly vector: readonly number[];
  readonly startLine: number;
  readonly endLine: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly headingTrail: readonly string[];
  readonly symbols: readonly string[];
  readonly headingText: string;
  readonly symbolText: string;
  readonly contentHash: string;
  readonly fileContentHash: string;
  readonly tokenCount: number;
  readonly extractorVersion: number;
  readonly chunkerVersion: number;
  readonly indexSchemaVersion: number;
}

export type IndexStoreErrorCode =
  | "INDEX_OPEN_FAILED"
  | "INDEX_REBUILD_REQUIRED"
  | "INDEX_SCHEMA_INVALID"
  | "INDEX_WRITE_FAILED"
  | "INDEX_READ_FAILED"
  | "INDEX_COMPATIBILITY_WRITE_FAILED";

export interface IndexStoreError extends AppError<IndexStoreErrorCode> {}

export interface IndexStore {
  getFile(fileId: string): Promise<Result<IndexedFileRecord | undefined, IndexStoreError>>;
  getFiles(
    fileIds: readonly string[],
  ): Promise<Result<readonly IndexedFileRecord[], IndexStoreError>>;
  getChunks(fileId: string): Promise<Result<readonly IndexedChunkRecord[], IndexStoreError>>;
  getChunksForFiles(
    fileIds: readonly string[],
  ): Promise<Result<readonly IndexedChunkRecord[], IndexStoreError>>;
  replaceFile(
    file: IndexedFileRecord,
    chunks: readonly IndexedChunkRecord[],
  ): Promise<Result<void, IndexStoreError>>;
  replaceFiles(
    entries: readonly {
      readonly file: IndexedFileRecord;
      readonly chunks: readonly IndexedChunkRecord[];
    }[],
  ): Promise<Result<void, IndexStoreError>>;
  markFileFailed(
    file: DiscoveredFile,
    error: { readonly code: string; readonly message: string },
  ): Promise<Result<void, IndexStoreError>>;
  deleteFile(fileId: string): Promise<Result<void, IndexStoreError>>;
  refreshSearchIndexes(): Promise<Result<void, IndexStoreError>>;
  close(): void;
}

export type IndexingPhase =
  | "preparing"
  | "extracting"
  | "embedding"
  | "committing"
  | "deleting"
  | "finalizing"
  | "complete"
  | "cancelled";

export interface IndexingFileError {
  readonly fileId: string;
  readonly relativePath: string;
  readonly code: string;
  readonly message: string;
}

export interface IndexingProgress {
  readonly phase: IndexingPhase;
  /** Root-relative path of the file currently being processed, when applicable. */
  readonly currentFile?: string;
  readonly totalFiles: number;
  readonly processedFiles: number;
  readonly unchangedFiles: number;
  readonly skippedFiles: number;
  readonly failedFiles: number;
  readonly deletedFiles: number;
  readonly totalChunks: number;
  readonly embeddedChunks: number;
  readonly reusedChunks: number;
  readonly committedChunks: number;
  readonly batchesCompleted: number;
  readonly errors: readonly IndexingFileError[];
  readonly estimatedCompletionMs?: number;
}

export interface IndexingRunResult {
  readonly progress: IndexingProgress;
  readonly timing: IndexingTiming;
}

export interface IndexingTiming {
  readonly totalMs: number;
  readonly warmUpMs: number;
  readonly preparationMs: number;
  readonly embeddingMs: number;
  readonly commitMs: number;
  readonly finalizationMs: number;
}

export type IndexingErrorCode = "INDEXING_CANCELLED" | "INDEXING_FATAL";
export interface IndexingError extends AppError<IndexingErrorCode> {}

export interface IndexingService {
  indexFiles(
    files: readonly DiscoveredFile[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<IndexingRunResult, IndexingError>>;
  applyChanges(
    changes: readonly FileChange[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<IndexingRunResult, IndexingError>>;
  subscribeProgress(listener: (progress: IndexingProgress) => void): () => void;
}

export interface IndexingDependencies {
  readonly extraction: ExtractionPipeline;
  readonly embeddings: EmbeddingProvider;
  readonly store: IndexStore;
}

export interface PreparedFile {
  readonly discovered: DiscoveredFile;
  readonly extracted: ExtractedFile;
  readonly chunks: readonly SearchChunk[];
}
