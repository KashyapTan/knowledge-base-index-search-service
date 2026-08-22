import type { IndexConfig } from "../config/index.ts";
import type { DiscoveredFile, FileFormat } from "../discovery/index.ts";
import type { AppError, Result } from "../shared/result.ts";

export type ExtractedUnitKind =
  | "heading"
  | "paragraph"
  | "list"
  | "table"
  | "quote"
  | "code"
  | "declaration"
  | "comment"
  | "record"
  | "text";

export interface SourceRange {
  /** One-based, inclusive source line. */
  readonly startLine: number;
  /** One-based, inclusive source line. */
  readonly endLine: number;
  /** Zero-based UTF-16 offset in the decoded original file, inclusive. */
  readonly startOffset: number;
  /** Zero-based UTF-16 offset in the decoded original file, exclusive. */
  readonly endOffset: number;
}

export interface ExtractionWarning {
  readonly code:
    | "INVALID_UNICODE_REPLACED"
    | "LINE_ENDINGS_NORMALIZED"
    | "MALFORMED_SYNTAX"
    | "PARSER_FALLBACK"
    | "CONTENT_OMITTED";
  readonly message: string;
  readonly line?: number;
}

export interface DocumentMetadata {
  readonly format: FileFormat;
  readonly language: string;
  readonly title?: string;
  readonly description?: string;
  readonly headings: readonly string[];
  readonly symbols: readonly string[];
}

export interface ExtractedUnit {
  readonly kind: ExtractedUnitKind;
  /** Content shown in search excerpts. It never contains enrichment prefixes. */
  readonly displayText: string;
  /** Clean content used to build the enriched search representation. */
  readonly searchText: string;
  readonly range: SourceRange;
  readonly headingTrail: readonly string[];
  readonly symbol?: string;
}

export interface ExtractedDocument {
  readonly fileId: string;
  readonly relativePath: string;
  readonly normalizedText: string;
  readonly metadata: DocumentMetadata;
  readonly units: readonly ExtractedUnit[];
  readonly warnings: readonly ExtractionWarning[];
  readonly extractorVersion: number;
}

export interface ExtractorContext {
  readonly file: DiscoveredFile;
  readonly source: NormalizedSource;
  readonly extractorVersion: number;
}

export interface Extractor {
  readonly name: string;
  readonly formats: readonly FileFormat[];
  extract(context: ExtractorContext): ExtractedDocument;
}

export interface NormalizedLine {
  readonly number: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly endIncludingBreak: number;
}

export interface NormalizedSource {
  readonly text: string;
  readonly originalLength: number;
  readonly lines: readonly NormalizedLine[];
  readonly warnings: readonly ExtractionWarning[];
  toOriginalOffset(normalizedOffset: number): number;
  range(start: number, end: number): SourceRange;
}

export interface TokenCounter {
  /** Includes any special tokens added by the selected embedding tokenizer. */
  count(text: string): number;
}

export interface ChunkingOptions {
  readonly index: Pick<
    IndexConfig,
    "chunkOverlapTokens" | "chunkSizeTokens" | "chunkerVersion" | "extractorVersion"
  >;
  readonly maxTokens: number;
  readonly tokenizer: TokenCounter;
}

export interface SearchChunk extends SourceRange {
  readonly chunkId: string;
  readonly fileId: string;
  readonly relativePath: string;
  readonly ordinal: number;
  readonly displayText: string;
  readonly searchText: string;
  readonly headingTrail: readonly string[];
  readonly symbols: readonly string[];
  readonly contentHash: string;
  readonly tokenCount: number;
  readonly extractorVersion: number;
  readonly chunkerVersion: number;
}

export type ExtractionErrorCode =
  | "FILE_NOT_READY"
  | "FILE_PATH_UNSAFE"
  | "FILE_READ_FAILED"
  | "EXTRACTOR_UNAVAILABLE"
  | "EXTRACTION_FAILED"
  | "CHUNKING_FAILED";

export interface ExtractionError extends AppError<ExtractionErrorCode> {
  readonly fileId: string;
}

export interface ExtractedFile {
  readonly document: ExtractedDocument;
  readonly chunks: readonly SearchChunk[];
}

export interface ExtractionPipeline {
  process(file: DiscoveredFile): Promise<Result<ExtractedFile, ExtractionError>>;
  shutdown?(): Promise<void>;
}
