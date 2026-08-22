import type { EmbeddingVector } from "../indexing/index.ts";
import type { AppError, Result } from "../shared/result.ts";

export type SearchMatchSource = "vector" | "bm25" | "metadata";
export type MetadataMatchKind = "exact" | "prefix" | "substring" | "fuzzy";
export type MetadataMatchField = "filename" | "path" | "heading" | "symbol";

export interface SearchConfig {
  readonly defaultFileCount: number;
  readonly maxFileCount: number;
  readonly maxQueryLength: number;
  readonly maxFormatFilters: number;
  readonly vectorCandidates: number;
  readonly bm25Candidates: number;
  readonly metadataCandidates: number;
  readonly metadataChunksPerFile: number;
  readonly rrfConstant: number;
  readonly sourceWeights: Readonly<Record<SearchMatchSource, number>>;
  readonly maxExcerptsPerFile: number;
  readonly maxSupplementalFileScoreRatio: number;
  readonly supplementalScoreDecay: number;
  readonly metadataFuzzyMaxDistance: number;
  readonly maxVectorDistance: number;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = Object.freeze({
  defaultFileCount: 10,
  maxFileCount: 50,
  maxQueryLength: 4_096,
  maxFormatFilters: 20,
  vectorCandidates: 100,
  bm25Candidates: 100,
  metadataCandidates: 100,
  metadataChunksPerFile: 3,
  rrfConstant: 60,
  sourceWeights: Object.freeze({ vector: 1, bm25: 1, metadata: 2 }),
  maxExcerptsPerFile: 3,
  maxSupplementalFileScoreRatio: 0.15,
  supplementalScoreDecay: 0.25,
  metadataFuzzyMaxDistance: 2,
  maxVectorDistance: 0.9,
});

export interface SearchRequest {
  readonly query: string;
  readonly fileCount?: number;
  readonly formats?: readonly string[];
}

export interface NormalizedSearchRequest {
  readonly query: string;
  readonly fileCount: number;
  readonly formats: readonly string[];
}

export interface SearchTiming {
  readonly totalMs: number;
  readonly embeddingMs: number;
  readonly retrievalMs: number;
  readonly vectorMs: number;
  readonly bm25Ms: number;
  readonly metadataMs: number;
  readonly fusionMs: number;
  readonly aggregationMs: number;
}

export interface SearchExcerpt {
  readonly chunkId: string;
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly headingTrail: readonly string[];
  readonly symbols: readonly string[];
  readonly score: number;
  readonly matchSources: readonly SearchMatchSource[];
  readonly highlightTerms: readonly string[];
}

export interface SearchFileResult {
  readonly fileId: string;
  readonly relativePath: string;
  readonly filename: string;
  readonly format: string;
  /** An ordering score, not a calibrated relevance percentage. */
  readonly score: number;
  readonly matchSources: readonly SearchMatchSource[];
  readonly excerpts: readonly SearchExcerpt[];
}

export interface SearchResponse {
  readonly query: string;
  readonly requestedFileCount: number;
  readonly formats: readonly string[];
  readonly timing: SearchTiming;
  readonly results: readonly SearchFileResult[];
}

export type SearchErrorCode =
  | "SEARCH_QUERY_INVALID"
  | "SEARCH_REQUEST_INVALID"
  | "SEARCH_CANCELLED"
  | "SEARCH_EMBEDDING_FAILED"
  | "SEARCH_INDEX_UNAVAILABLE"
  | "SEARCH_RETRIEVAL_FAILED";

export interface SearchError extends AppError<SearchErrorCode> {}

export interface SearchOptions {
  readonly signal?: AbortSignal;
}

export interface SearchService {
  search(
    request: SearchRequest,
    options?: SearchOptions,
  ): Promise<Result<SearchResponse, SearchError>>;
}

export interface MetadataMatch {
  readonly kind: MetadataMatchKind;
  readonly field: MetadataMatchField;
  /** A bounded value in [0, 1], used only to order the metadata list. */
  readonly strength: number;
  readonly term: string;
}

export interface SearchCandidate {
  readonly chunkId: string;
  readonly fileId: string;
  readonly relativePath: string;
  readonly filename: string;
  readonly format: string;
  readonly displayText: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly headingTrail: readonly string[];
  readonly symbols: readonly string[];
  readonly source: SearchMatchSource;
  /** Source-local score. Cross-source fusion never compares this value. */
  readonly rawScore: number;
  readonly metadataMatch?: MetadataMatch;
}

export interface RetrievalTiming {
  readonly totalMs: number;
  readonly vectorMs: number;
  readonly bm25Ms: number;
  readonly metadataMs: number;
}

export interface RetrievedCandidatePools {
  readonly vector: readonly SearchCandidate[];
  readonly bm25: readonly SearchCandidate[];
  readonly metadata: readonly SearchCandidate[];
  readonly timing: RetrievalTiming;
}

export interface CandidateRetriever {
  retrieve(
    query: string,
    vector: EmbeddingVector,
    formats: readonly string[],
    config: SearchConfig,
    options?: SearchOptions,
  ): Promise<Result<RetrievedCandidatePools, SearchError>>;
  close(): void;
}

export interface CandidateMatch {
  readonly source: SearchMatchSource;
  readonly rank: number;
  readonly rawScore: number;
  readonly metadataMatch?: MetadataMatch;
}

export interface FusedSearchCandidate
  extends Omit<SearchCandidate, "source" | "rawScore" | "metadataMatch"> {
  readonly score: number;
  readonly matches: readonly CandidateMatch[];
}
