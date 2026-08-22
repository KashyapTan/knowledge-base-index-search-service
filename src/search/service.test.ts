import { describe, expect, test } from "bun:test";
import { type EmbeddingVector, FakeEmbeddingProvider } from "../indexing/index.ts";
import { err, ok } from "../shared/result.ts";
import type {
  CandidateRetriever,
  RetrievedCandidatePools,
  SearchConfig,
  SearchError,
  SearchOptions,
} from "./contracts.ts";
import { createSearchService } from "./service.ts";
import { candidate } from "./test-helpers.ts";

const EMPTY_TIMING = { totalMs: 1, vectorMs: 0.3, bm25Ms: 0.4, metadataMs: 0.2 };

class FixtureRetriever implements CandidateRetriever {
  readonly #result: RetrievedCandidatePools;
  calls: Array<{
    query: string;
    vector: EmbeddingVector;
    formats: readonly string[];
    config: SearchConfig;
    options: SearchOptions;
  }> = [];
  closeCalls = 0;

  constructor(result: Partial<RetrievedCandidatePools> = {}) {
    this.#result = {
      vector: [],
      bm25: [],
      metadata: [],
      timing: EMPTY_TIMING,
      ...result,
    };
  }

  async retrieve(
    query: string,
    vector: EmbeddingVector,
    formats: readonly string[],
    config: SearchConfig,
    options: SearchOptions = {},
  ) {
    this.calls.push({ query, vector, formats, config, options });
    return options.signal?.aborted
      ? err<SearchError>({ code: "SEARCH_CANCELLED", message: "cancelled" })
      : ok(this.#result);
  }

  close(): void {
    this.closeCalls += 1;
  }
}

async function readyProvider(options: ConstructorParameters<typeof FakeEmbeddingProvider>[0] = {}) {
  const provider = new FakeEmbeddingProvider(options);
  const warmed = await provider.warmUp();
  if (!warmed.ok) throw new Error(warmed.error.message);
  return provider;
}

describe("hybrid search service", () => {
  test("embeds exactly one preserved query, forwards filters, and returns timing metadata", async () => {
    const embeddings = await readyProvider();
    const retriever = new FixtureRetriever({
      bm25: [candidate("hit", "guide", "bm25", 12, { displayText: "HTTPError details" })],
    });
    const service = createSearchService({ embeddings, retriever }, { defaultFileCount: 4 });
    const response = await service.search({
      query: "  HTTPError: E_CONN_RESET  ",
      formats: ["Markdown"],
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.value.query).toBe("HTTPError: E_CONN_RESET");
    expect(response.value.requestedFileCount).toBe(4);
    expect(response.value.formats).toEqual(["markdown"]);
    expect(response.value.results[0]?.fileId).toBe("guide");
    expect(response.value.timing).toMatchObject({
      retrievalMs: 1,
      vectorMs: 0.3,
      bm25Ms: 0.4,
      metadataMs: 0.2,
    });
    expect(response.value.timing.totalMs).toBeGreaterThanOrEqual(0);
    expect(embeddings.embeddedTexts).toEqual(["HTTPError: E_CONN_RESET"]);
    expect(retriever.calls[0]?.formats).toEqual(["markdown"]);
  });

  test("returns a successful empty result without manufacturing vector rows", async () => {
    const service = createSearchService({
      embeddings: await readyProvider(),
      retriever: new FixtureRetriever(),
    });
    const response = await service.search({ query: "nothing matches" });
    expect(response.ok && response.value.results).toEqual([]);
  });

  test("rejects invalid input before embedding", async () => {
    const embeddings = await readyProvider();
    const service = createSearchService({ embeddings, retriever: new FixtureRetriever() });
    const response = await service.search({ query: "  " });
    expect(!response.ok && response.error.code).toBe("SEARCH_QUERY_INVALID");
    expect(embeddings.embeddedTexts).toEqual([]);
  });

  test("cancels before embedding and after retrieval without publishing stale results", async () => {
    const embeddings = await readyProvider();
    const retriever = new FixtureRetriever({
      vector: [candidate("stale", "old", "vector", 1)],
    });
    const service = createSearchService({ embeddings, retriever });
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    expect(await service.search({ query: "stale" }, { signal: alreadyCancelled.signal })).toEqual({
      ok: false,
      error: { code: "SEARCH_CANCELLED", message: "Search was cancelled." },
    });
    expect(retriever.calls).toHaveLength(0);

    const duringRetrieval = new AbortController();
    const cancellingRetriever: CandidateRetriever = {
      async retrieve() {
        duringRetrieval.abort();
        return ok({
          vector: [candidate("stale", "old", "vector", 1)],
          bm25: [],
          metadata: [],
          timing: EMPTY_TIMING,
        });
      },
      close() {},
    };
    const cancellingService = createSearchService({ embeddings, retriever: cancellingRetriever });
    const result = await cancellingService.search(
      { query: "newer query" },
      { signal: duringRetrieval.signal },
    );
    expect(!result.ok && result.error.code).toBe("SEARCH_CANCELLED");
  });

  test("maps provider cancellation and inference errors into the public contract", async () => {
    const failedProvider = await readyProvider({ failOnText: "fail" });
    const failed = await createSearchService({
      embeddings: failedProvider,
      retriever: new FixtureRetriever(),
    }).search({ query: "please fail" });
    expect(!failed.ok && failed.error.code).toBe("SEARCH_EMBEDDING_FAILED");

    const cancelledProvider = await readyProvider();
    const original = cancelledProvider.embedQuery.bind(cancelledProvider);
    cancelledProvider.embedQuery = async (text, options) => {
      options?.signal?.throwIfAborted();
      const result = await original(text, options);
      return result.ok
        ? err({ code: "EMBEDDING_CANCELLED", message: "provider cancelled" })
        : result;
    };
    const cancelled = await createSearchService({
      embeddings: cancelledProvider,
      retriever: new FixtureRetriever(),
    }).search({ query: "cancel me" });
    expect(!cancelled.ok && cancelled.error.code).toBe("SEARCH_CANCELLED");
  });
});
