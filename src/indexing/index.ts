export type {
  EmbeddingBatchMetric,
  EmbeddingError,
  EmbeddingErrorCode,
  EmbeddingIdentity,
  EmbeddingProvider,
  EmbeddingVector,
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
  IndexingTiming,
  IndexStore,
  IndexStoreError,
  IndexStoreErrorCode,
  ModelSetupPhase,
  ModelWarmUpOptions,
  ReusableChunkRecord,
} from "./contracts.ts";
export {
  type EmbeddingVectorBatch,
  type EmbeddingWorkerConfig,
  PROVISIONAL_EMBEDDING_MODEL,
  validateEmbeddingVectorBatch,
  vectorViews,
} from "./embedding-protocol.ts";
export {
  ACCELERATOR_TOKEN_BUCKETS,
  acceleratorTokenBucket,
  acceleratorTokenBuckets,
  createTransformersEmbeddingProvider,
  type EmbeddingWorkerBoundary,
  TransformersEmbeddingProvider,
} from "./embedding-provider.ts";
export { EmbeddingWorkerError } from "./embedding-worker-client.ts";
export {
  FakeEmbeddingProvider,
  type FakeEmbeddingProviderOptions,
  fakeEmbeddingProfile,
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
export {
  inspectModelAssets,
  type ModelAssetInspection,
  quarantineModelCache,
  verifyOrWriteModelAssetManifest,
} from "./model-assets.ts";
export {
  type EmbeddingTensorData,
  type PoolEmbeddingOptions,
  poolEmbeddingTensors,
} from "./pooling.ts";
export { createIndexingService, RepositoryIndexingService } from "./service.ts";
