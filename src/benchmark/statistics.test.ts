import { describe, expect, test } from "bun:test";
import type { LargeRepositoryBenchmarkReport } from "./contracts.ts";
import { compareModelBenchmarks } from "./model-comparison.ts";
import { summarizeDistribution } from "./statistics.ts";

function report(
  modelId: string,
  dimension: number,
  recallAt5: number,
  misses: readonly string[] = [],
): LargeRepositoryBenchmarkReport {
  const distribution = summarizeDistribution([10, 20, 30]);
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-21T00:00:00.000Z",
    corpus: {
      rootIdentity: "opaque",
      revision: "abc",
      dirty: false,
      supportedFileCount: 10,
      totalBytes: 100,
      formatDistribution: { markdown: 10 },
      readyFiles: 10,
      skippedFiles: 0,
      failedFiles: 0,
      failureReasons: {},
      readOnlyVerification: {
        stateOutsideSource: true,
        outputOutsideSource: true,
        gitStatusUnchanged: true,
      },
    },
    environment: {
      os: "test",
      architecture: "test",
      cpu: "test",
      logicalCpus: 1,
      totalMemoryBytes: 100,
      bunVersion: "1.4.0",
      dependencies: {},
    },
    settings: {
      modelId,
      quantization: "q8",
      vectorDimension: dimension,
      chunkSizeTokens: 400,
      chunkOverlapTokens: 50,
      extractorVersion: 1,
      chunkerVersion: 1,
      indexSchemaVersion: 1,
      annThreshold: 50_000,
      indexStrategy: "exact",
      ignorePatterns: ["node_modules/"],
    },
    startup: {
      loopbackBrowserReadyMs: 1,
      modelLoadMs: 2,
      tokenizerLoadMs: 1,
      initialScanMs: 2,
    },
    indexing: {
      initialWallMs: 10,
      chunksPerSecond: 10,
      extractedChunkCount: 10,
      embeddedChunks: 10,
      reusedChunks: 0,
      changedFiles: 10,
      skippedFiles: 0,
      failedFiles: 0,
      errors: [],
      tokenDistribution: distribution,
      noChangeReconciliationMs: 1,
      noChangeFiles: 10,
    },
    memory: { peakRssBytes: 10, steadyRssBytes: 5 },
    storage: { indexBytes: 10, modelCacheBytes: 10 },
    queries: [
      {
        queryLabel: "q-1",
        totalMs: distribution,
        embeddingMs: distribution,
        retrievalMs: distribution,
        vectorMs: distribution,
        bm25Ms: distribution,
        metadataMs: distribution,
        fusionMs: distribution,
        aggregationMs: distribution,
        returnedFiles: 5,
      },
    ],
    viewer: {
      smallFileBytes: 1,
      smallOpenMs: 1,
      smallGrepMs: 1,
      largeFileBytes: 2,
      largeOpenMs: 1,
      largeGrepMs: 1,
    },
    incrementalFixture: {
      sourceWasExternalCopy: true,
      updateMs: 1,
      deleteMs: 1,
      renameMs: 1,
    },
    relevance: {
      schemaVersion: 1,
      generatedAt: "2026-08-21T00:00:00.000Z",
      judgmentSet: { version: 1, name: "x", corpus: "x" },
      settings: {},
      metrics: {
        queryCount: 1,
        recallAt5,
        recallAt10: recallAt5,
        meanReciprocalRank: recallAt5,
        distinctFileRatioAt10: 1,
        relevantSectionHitRate: null,
      },
      queries: misses.map((id) => ({
        id,
        query: id,
        category: "mixed",
        expectedFiles: ["expected"],
        rankedFiles: [],
        firstRelevantRank: null,
        recallAt5: 0,
        recallAt10: 0,
        reciprocalRank: 0,
        distinctFileRatioAt10: 1,
        relevantSectionHit: null,
      })),
    },
  };
}

describe("benchmark statistics and model decision", () => {
  test("uses nearest-rank percentiles and handles empty distributions", () => {
    expect(summarizeDistribution([])).toEqual({
      count: 0,
      minimum: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      maximum: 0,
    });
    expect(summarizeDistribution([100, 1, 2, Number.NaN])).toMatchObject({
      count: 3,
      minimum: 1,
      p50: 2,
      p95: 100,
      maximum: 100,
    });
  });

  test("keeps small without a meaningful gain and selects base for evidence-backed benefit", () => {
    const small = report("Xenova/bge-small-en-v1.5", 384, 0.8, ["important"]);
    const weak = compareModelBenchmarks(
      small,
      report("Xenova/bge-base-en-v1.5", 768, 0.84, ["important"]),
    );
    expect(weak.identicalSettings).toBe(true);
    expect(weak.decision.selectedModel).toBe("Xenova/bge-small-en-v1.5");

    const strong = compareModelBenchmarks(small, report("Xenova/bge-base-en-v1.5", 768, 0.85));
    expect(strong.decision.selectedModel).toBe("Xenova/bge-base-en-v1.5");
    expect(strong.decision.importantQueriesFixed).toEqual(["important"]);

    const base = report("Xenova/bge-base-en-v1.5", 768, 1);
    const mismatched = {
      ...base,
      corpus: { ...base.corpus, supportedFileCount: 11 },
    };
    const invalid = compareModelBenchmarks(small, mismatched);
    expect(invalid.identicalSettings).toBe(false);
    expect(invalid.decision.selectedModel).toBe("Xenova/bge-small-en-v1.5");
  });
});
