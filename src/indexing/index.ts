export type {
  EmbeddingError,
  EmbeddingErrorCode,
  EmbeddingIdentity,
  EmbeddingProvider,
  EmbedOptions,
  FileExtractionStatus,
  FileIndexStatus,
  IndexedChunkRecord,
  IndexedFileRecord,
  IndexingDependencies,
  IndexingError,
  IndexingErrorCode,
  IndexingFileError,
  IndexingPhase,
  IndexingProgress,
  IndexingRunResult,
  IndexingService,
  IndexStore,
  IndexStoreError,
  IndexStoreErrorCode,
} from "./contracts.ts";
export {
  BGE_MODEL_PROFILES,
  createTransformersEmbeddingProvider,
  type EmbeddingWorkerBoundary,
  TransformersEmbeddingProvider,
} from "./embedding-provider.ts";
export {
  FakeEmbeddingProvider,
  type FakeEmbeddingProviderOptions,
} from "./fake-embedding-provider.ts";
export {
  CHUNKS_TABLE,
  createChunksSchema,
  createFilesSchema,
  FILES_TABLE,
  LanceIndexStore,
  type OpenLanceIndexOptions,
  openLanceIndex,
} from "./lance-store.ts";
export { createIndexingService, RepositoryIndexingService } from "./service.ts";
