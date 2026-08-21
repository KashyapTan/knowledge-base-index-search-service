import type { EmbeddingProvider } from "../indexing/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import { aggregateByFile } from "./aggregation.ts";
import { createSearchConfig, type SearchConfigOverrides } from "./config.ts";
import type {
  CandidateRetriever,
  SearchError,
  SearchOptions,
  SearchRequest,
  SearchResponse,
  SearchService,
  SearchTiming,
} from "./contracts.ts";
import { fuseCandidatePools } from "./fusion.ts";
import { normalizeSearchRequest } from "./query.ts";

function cancelled(): Result<never, SearchError> {
  return err({ code: "SEARCH_CANCELLED", message: "Search was cancelled." });
}

export class HybridSearchService implements SearchService {
  readonly #embeddings: EmbeddingProvider;
  readonly #retriever: CandidateRetriever;
  readonly #config: ReturnType<typeof createSearchConfig>;

  constructor(
    dependencies: {
      readonly embeddings: EmbeddingProvider;
      readonly retriever: CandidateRetriever;
    },
    config: SearchConfigOverrides = {},
  ) {
    this.#embeddings = dependencies.embeddings;
    this.#retriever = dependencies.retriever;
    this.#config = createSearchConfig(config);
  }

  async search(
    request: SearchRequest,
    options: SearchOptions = {},
  ): Promise<Result<SearchResponse, SearchError>> {
    const totalStartedAt = performance.now();
    const normalized = normalizeSearchRequest(request, this.#config);
    if (!normalized.ok) return normalized;
    if (options.signal?.aborted) return cancelled();

    const embeddingStartedAt = performance.now();
    const embedded = await this.#embeddings.embedQuery(normalized.value.query, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const embeddingMs = performance.now() - embeddingStartedAt;
    if (!embedded.ok) {
      if (embedded.error.code === "EMBEDDING_CANCELLED" || options.signal?.aborted) {
        return cancelled();
      }
      return err({
        code: "SEARCH_EMBEDDING_FAILED",
        message: embedded.error.message,
      });
    }
    if (options.signal?.aborted) return cancelled();

    const retrieved = await this.#retriever.retrieve(
      normalized.value.query,
      embedded.value,
      normalized.value.formats,
      this.#config,
      options,
    );
    if (!retrieved.ok) return retrieved;
    if (options.signal?.aborted) return cancelled();

    const fusionStartedAt = performance.now();
    const fused = fuseCandidatePools(
      {
        vector: retrieved.value.vector,
        bm25: retrieved.value.bm25,
        metadata: retrieved.value.metadata,
      },
      this.#config,
    );
    const fusionMs = performance.now() - fusionStartedAt;
    const aggregationStartedAt = performance.now();
    const results = aggregateByFile(
      fused,
      normalized.value.query,
      normalized.value.fileCount,
      this.#config,
    );
    const aggregationMs = performance.now() - aggregationStartedAt;
    const timing: SearchTiming = {
      totalMs: performance.now() - totalStartedAt,
      embeddingMs,
      retrievalMs: retrieved.value.timing.totalMs,
      vectorMs: retrieved.value.timing.vectorMs,
      bm25Ms: retrieved.value.timing.bm25Ms,
      metadataMs: retrieved.value.timing.metadataMs,
      fusionMs,
      aggregationMs,
    };
    return ok({
      query: normalized.value.query,
      requestedFileCount: normalized.value.fileCount,
      formats: normalized.value.formats,
      timing,
      results,
    });
  }
}

export function createSearchService(
  dependencies: {
    readonly embeddings: EmbeddingProvider;
    readonly retriever: CandidateRetriever;
  },
  config?: SearchConfigOverrides,
): HybridSearchService {
  return new HybridSearchService(dependencies, config);
}
