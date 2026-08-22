import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EmbeddingError,
  EmbeddingIdentity,
  EmbeddingProvider,
  EmbeddingVector,
  EmbedOptions,
  IndexedChunkRecord,
  IndexedFileRecord,
} from "../indexing/index.ts";
import { fakeEmbeddingProfile, openLanceIndex } from "../indexing/index.ts";
import { indexingConfig } from "../indexing/test-helpers.ts";
import { ok, type Result } from "../shared/result.ts";
import { createSearchConfig } from "./config.ts";
import { openLanceCandidateRetriever } from "./lance-retriever.ts";
import { createSearchService } from "./service.ts";

let fixture = "";

class QueryFixtureEmbeddingProvider implements EmbeddingProvider {
  readonly identity: EmbeddingIdentity = {
    device: "cpu",
    modelId: "kbiss/search-fixture",
    nativeDimension: 4,
    profile: fakeEmbeddingProfile("search-fixture"),
    quantization: "fp32",
    vectorDimension: 4,
    maximumTokens: 512,
    normalization: "l2",
  };
  readonly batchSize = 1;
  readonly queries: string[] = [];

  encodeDocument(text: string): string {
    return text;
  }

  encodeQuery(text: string): string {
    return text;
  }

  async warmUp(): Promise<Result<void, EmbeddingError>> {
    return ok(undefined);
  }

  async embedDocuments(
    texts: readonly string[],
    options: EmbedOptions = {},
  ): Promise<Result<readonly (readonly number[])[], EmbeddingError>> {
    if (options.signal?.aborted) {
      return { ok: false, error: { code: "EMBEDDING_CANCELLED", message: "cancelled" } };
    }
    return ok(texts.map((text) => this.vectorFor(text)));
  }

  async embedQuery(
    text: string,
    options: Pick<EmbedOptions, "signal"> = {},
  ): Promise<Result<readonly number[], EmbeddingError>> {
    if (options.signal?.aborted) {
      return { ok: false, error: { code: "EMBEDDING_CANCELLED", message: "cancelled" } };
    }
    this.queries.push(text);
    return ok(this.vectorFor(text));
  }

  async shutdown(): Promise<void> {}

  private vectorFor(text: string): readonly number[] {
    if (text === "how does the system recover from temporary failures") return [1, 0, 0, 0];
    if (text === "timeout_ms upstream latency") return [1, 0, 0, 0];
    if (text === "timeout_ms") return [0, 0, 0, 1];
    return [-0.5, -0.5, -0.5, -0.5];
  }
}

function fileRecord(
  fileId: string,
  relativePath: string,
  format: string,
  chunkCount = 1,
): IndexedFileRecord {
  return {
    fileId,
    relativePath,
    filename: relativePath.split("/").at(-1) ?? relativePath,
    format,
    mimeFamily: format === "yaml" ? "application/yaml" : "text/markdown",
    fingerprintHash: `hash-${fileId}`,
    size: 100,
    modifiedAtMs: 10,
    modifiedAtNs: "10000000",
    changedAtNs: "10000000",
    timestampPrecisionMs: 1,
    extractionStatus: "extracted",
    indexStatus: "indexed",
    contentHash: `hash-${fileId}`,
    lastError: "",
    chunkCount,
    extractorVersion: 1,
    chunkerVersion: 1,
    indexSchemaVersion: 1,
    indexedAtMs: 20,
  };
}

function chunkRecord(
  file: IndexedFileRecord,
  chunkId: string,
  displayText: string,
  vector: EmbeddingVector,
  metadata: {
    readonly heading: string;
    readonly symbols?: readonly string[];
    readonly startLine: number;
    readonly ordinal?: number;
  },
): IndexedChunkRecord {
  const symbols = metadata.symbols ?? [];
  return {
    chunkId,
    fileId: file.fileId,
    relativePath: file.relativePath,
    filename: file.filename,
    format: file.format,
    ordinal: metadata.ordinal ?? 0,
    displayText,
    searchText: [
      `Path: ${file.relativePath}`,
      `Heading: ${metadata.heading}`,
      symbols.length > 0 ? `Symbols: ${symbols.join(" ")}` : "",
      displayText,
    ].join("\n"),
    embeddingInputHash: `input-${chunkId}`,
    embeddingInputVersion: 1,
    embeddingModelId: "Xenova/bge-small-en-v1.5",
    embeddingRevision: "ea104dacec62c0de699686887e3f920caeb4f3e3",
    embeddingProfileVersion: 2,
    embeddingDimension: vector.length,
    poolingVersion: 1,
    documentEncodingVersion: 1,
    tokenizerVersion: 1,
    normalization: "l2",
    vector,
    startLine: metadata.startLine,
    endLine: metadata.startLine + 2,
    startOffset: metadata.startLine * 10,
    endOffset: metadata.startLine * 10 + displayText.length,
    headingTrail: [metadata.heading],
    symbols,
    headingText: metadata.heading,
    symbolText: symbols.join(" "),
    contentHash: `chunk-hash-${chunkId}`,
    fileContentHash: file.contentHash,
    tokenCount: displayText.split(/\s+/u).length,
    extractorVersion: 1,
    chunkerVersion: 1,
    indexSchemaVersion: 1,
  };
}

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "kbiss-search-"));
  await Promise.all([
    mkdir(join(fixture, "root")),
    mkdir(join(fixture, "state", "metadata"), { recursive: true }),
    mkdir(join(fixture, "cache")),
  ]);
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

async function fixtureService() {
  const config = indexingConfig(
    join(fixture, "root"),
    join(fixture, "state"),
    join(fixture, "cache"),
  );
  const opened = await openLanceIndex(config);
  if (!opened.ok) throw new Error(opened.error.message);
  const retry = fileRecord("retry", "docs/payment-retry.md", "markdown", 2);
  const gateway = fileRecord("gateway", "config/gateway.yaml", "yaml");
  const decline = fileRecord("decline", "errors/declines.md", "markdown");
  const settlement = fileRecord("settlement", "docs/settlement.md", "markdown");
  const unrelated = fileRecord("unrelated", "src/formatting.ts", "typescript");
  const writes = [
    opened.value.replaceFile(retry, [
      chunkRecord(
        retry,
        "retry-strategy",
        "Retries use exponential backoff when upstream requests fail.",
        [1, 0, 0, 0],
        { heading: "Retry strategy", symbols: ["retryPayment"], startLine: 10 },
      ),
      chunkRecord(
        retry,
        "retry-limits",
        "The retry budget limits repeated payment attempts.",
        [0.95, 0.05, 0, 0],
        { heading: "Retry limits", startLine: 30, ordinal: 1 },
      ),
    ]),
    opened.value.replaceFile(gateway, [
      chunkRecord(gateway, "gateway-timeout", "timeout_ms: 30000", [0, 1, 0, 0], {
        heading: "Gateway configuration",
        symbols: ["timeout_ms"],
        startLine: 4,
      }),
    ]),
    opened.value.replaceFile(decline, [
      chunkRecord(
        decline,
        "decline-error",
        "Gateway returned card authorization declined while processing.",
        [0, 0, 1, 0],
        { heading: "Decline errors", startLine: 18 },
      ),
    ]),
    opened.value.replaceFile(settlement, [
      chunkRecord(
        settlement,
        "settlement-flow",
        "Daily clearing and fund settlement reconciliation.",
        [0, 0, 0, 1],
        { heading: "Settlement", startLine: 7 },
      ),
    ]),
    opened.value.replaceFile(unrelated, [
      chunkRecord(
        unrelated,
        "format-code",
        "export function formatCurrency(value: number) {}",
        [0.5, 0.5, 0.5, 0.5],
        { heading: "formatCurrency", symbols: ["formatCurrency"], startLine: 1 },
      ),
    ]),
  ];
  const committed = await Promise.all(writes);
  if (committed.some((result) => !result.ok)) throw new Error("Fixture records did not commit.");
  const indexed = await opened.value.refreshSearchIndexes();
  if (!indexed.ok) throw new Error(indexed.error.message);
  opened.value.close();
  const retriever = await openLanceCandidateRetriever(config);
  if (!retriever.ok) throw new Error(retriever.error.message);
  const embeddings = new QueryFixtureEmbeddingProvider();
  return {
    embeddings,
    retriever: retriever.value,
    service: createSearchService(
      { embeddings, retriever: retriever.value },
      { vectorCandidates: 20, bm25Candidates: 20, metadataCandidates: 20 },
    ),
  };
}

describe("temporary LanceDB hybrid search", () => {
  test("covers semantic-only, BM25-only, exact metadata, phrase, mixed, and no-result queries", async () => {
    const fixtureSearch = await fixtureService();
    try {
      const cases = [
        ["how does the system recover from temporary failures", "retry", "vector"],
        ["exponential backoff", "retry", "bm25"],
        ["gateway.yaml", "gateway", "metadata"],
        ["timeout_ms", "gateway", "metadata"],
        ['"card authorization declined"', "decline", "bm25"],
        ['diagnostic "card authorization declined"', "decline", "bm25"],
        ["timeout_ms upstream latency", "gateway", "metadata"],
      ] as const;
      for (const [query, expectedFile, expectedSource] of cases) {
        const response = await fixtureSearch.service.search({ query, fileCount: 3 });
        if (!response.ok) throw new Error(`${query}: ${response.error.message}`);
        expect(response.value.results[0]?.fileId).toBe(expectedFile);
        expect(response.value.results[0]?.matchSources).toContain(expectedSource);
      }
      const none = await fixtureSearch.service.search({ query: "zzzxxyy-never-present" });
      expect(none.ok && none.value.results).toEqual([]);
      expect(fixtureSearch.embeddings.queries).toHaveLength(cases.length + 1);
    } finally {
      fixtureSearch.retriever.close();
    }
  });

  test("applies format filters and returns distinct files with exact source line metadata", async () => {
    const fixtureSearch = await fixtureService();
    try {
      const filtered = await fixtureSearch.service.search({
        query: "exponential backoff",
        formats: ["yaml"],
      });
      expect(filtered.ok && filtered.value.results).toEqual([]);

      const response = await fixtureSearch.service.search({ query: "retry", fileCount: 2 });
      if (!response.ok) throw new Error(response.error.message);
      expect(response.value.results.length).toBeLessThanOrEqual(2);
      expect(new Set(response.value.results.map((result) => result.fileId)).size).toBe(
        response.value.results.length,
      );
      const retry = response.value.results.find((result) => result.fileId === "retry");
      expect(retry?.excerpts[0]).toMatchObject({
        chunkId: "retry-strategy",
        startLine: 10,
        endLine: 12,
        headingTrail: ["Retry strategy"],
        symbols: ["retryPayment"],
      });
      expect(retry?.excerpts.every((excerpt) => !excerpt.text.startsWith("Path:"))).toBe(true);
    } finally {
      fixtureSearch.retriever.close();
    }
  });

  test("rejects opening absent or incompatible indexes and honors cancellation", async () => {
    const config = indexingConfig(
      join(fixture, "root"),
      join(fixture, "state"),
      join(fixture, "cache"),
    );
    const absent = await openLanceCandidateRetriever(config);
    expect(!absent.ok && absent.error.code).toBe("SEARCH_INDEX_UNAVAILABLE");

    const emptyIndex = await openLanceIndex(config);
    if (!emptyIndex.ok) throw new Error(emptyIndex.error.message);
    emptyIndex.value.close();
    const emptyRetriever = await openLanceCandidateRetriever(config);
    if (!emptyRetriever.ok) throw new Error(emptyRetriever.error.message);
    const emptyResult = await emptyRetriever.value.retrieve(
      "anything",
      [1, 0, 0, 0],
      [],
      createSearchConfig(),
    );
    expect(emptyResult.ok && emptyResult.value.vector).toEqual([]);
    emptyRetriever.value.close();

    const fixtureSearch = await fixtureService();
    try {
      const controller = new AbortController();
      controller.abort();
      const result = await fixtureSearch.service.search(
        { query: "retry" },
        { signal: controller.signal },
      );
      expect(!result.ok && result.error.code).toBe("SEARCH_CANCELLED");

      const directController = new AbortController();
      directController.abort();
      const direct = await fixtureSearch.retriever.retrieve(
        "retry",
        [1, 0, 0, 0],
        [],
        createSearchConfig(),
        { signal: directController.signal },
      );
      expect(!direct.ok && direct.error.code).toBe("SEARCH_CANCELLED");
    } finally {
      fixtureSearch.retriever.close();
    }
  });
});
