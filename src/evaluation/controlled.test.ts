import { describe, expect, test } from "bun:test";
import { runControlledEvaluation } from "./controlled.ts";
import { FixtureSemanticEmbeddingProvider } from "./fixture-embedding-provider.ts";

describe("controlled end-to-end relevance evaluation", () => {
  test("scans, extracts, embeds, persists, searches, and no-ops on the second pass", async () => {
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (() => {
      networkCalls += 1;
      throw new Error("Controlled evaluation attempted network access.");
    }) as unknown as typeof fetch;
    let run: Awaited<ReturnType<typeof runControlledEvaluation>>;
    try {
      run = await runControlledEvaluation({ generatedAt: "2026-08-21T00:00:00.000Z" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(networkCalls).toBe(0);
    expect(run.evidence.discoveredFiles).toBe(6);
    expect(run.evidence.indexedChunks).toBeGreaterThanOrEqual(6);
    expect(run.evidence.unchangedFilesOnSecondPass).toBe(6);
    expect(run.evidence.failedFiles).toBe(0);
    expect(run.report.metrics.queryCount).toBe(8);
    expect(run.report.metrics.recallAt5).toBeGreaterThanOrEqual(0.9);
    expect(run.report.metrics.recallAt10).toBe(1);
    expect(run.report.metrics.meanReciprocalRank).toBeGreaterThanOrEqual(0.8);
    expect(run.report.metrics.distinctFileRatioAt10).toBe(1);
  });

  test("keeps the controlled semantic provider offline, normalized, and cancellable", async () => {
    const provider = new FixtureSemanticEmbeddingProvider();
    expect((await provider.embedQuery("retry")).ok).toBe(false);
    expect((await provider.warmUp()).ok).toBe(true);
    const retry = await provider.embedQuery("try the temporary charge again");
    const policy = await provider.embedDocuments(["retry transient payment failures"]);
    expect(retry.ok && policy.ok).toBe(true);
    if (retry.ok && policy.ok) {
      expect(retry.value).toHaveLength(provider.identity.vectorDimension);
      expect(Math.hypot(...retry.value)).toBeCloseTo(1, 5);
      expect(
        retry.value.reduce((sum, value, index) => sum + value * (policy.value[0]?.[index] ?? 0), 0),
      ).toBeGreaterThan(0.8);
    }
    const controller = new AbortController();
    controller.abort();
    const cancelled = await provider.embedDocuments(["retry"], { signal: controller.signal });
    expect(cancelled.ok ? "ok" : cancelled.error.code).toBe("EMBEDDING_CANCELLED");
    await provider.shutdown();
    expect((await provider.warmUp()).ok).toBe(false);
  });
});
