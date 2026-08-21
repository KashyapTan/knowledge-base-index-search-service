export { chunkDocument } from "./chunker.ts";
export type {
  ChunkingOptions,
  DocumentMetadata,
  ExtractedDocument,
  ExtractedFile,
  ExtractedUnit,
  ExtractedUnitKind,
  ExtractionError,
  ExtractionErrorCode,
  ExtractionPipeline,
  ExtractionWarning,
  Extractor,
  ExtractorContext,
  NormalizedLine,
  NormalizedSource,
  SearchChunk,
  SourceRange,
  TokenCounter,
} from "./contracts.ts";
export { normalizeSourceText } from "./normalization.ts";
export { createDefaultExtractorRegistry, ExtractorRegistry } from "./registry.ts";
export { createExtractionPipeline, FileExtractionPipeline } from "./service.ts";
export { createTransformersTokenCounter, createUnicodeWordTokenCounter } from "./tokenizer.ts";
