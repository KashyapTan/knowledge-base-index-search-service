export { aggregateByFile } from "./aggregation.ts";
export { createSearchConfig, type SearchConfigOverrides } from "./config.ts";
export type {
  CandidateMatch,
  CandidateRetriever,
  FusedSearchCandidate,
  MetadataMatch,
  MetadataMatchField,
  MetadataMatchKind,
  NormalizedSearchRequest,
  RetrievalTiming,
  RetrievedCandidatePools,
  SearchCandidate,
  SearchConfig,
  SearchError,
  SearchErrorCode,
  SearchExcerpt,
  SearchFileResult,
  SearchMatchSource,
  SearchOptions,
  SearchRequest,
  SearchResponse,
  SearchService,
  SearchTiming,
} from "./contracts.ts";
export { DEFAULT_SEARCH_CONFIG } from "./contracts.ts";
export { fuseCandidatePools, rankWithTies, reciprocalRank } from "./fusion.ts";
export {
  LanceCandidateRetriever,
  openLanceCandidateRetriever,
} from "./lance-retriever.ts";
export { bestMetadataMatch, levenshteinDistance } from "./metadata.ts";
export { normalizeSearchRequest, queryTerms, quotedPhrases } from "./query.ts";
export { createSearchService, HybridSearchService } from "./service.ts";
