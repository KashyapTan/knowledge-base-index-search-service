import { describe, expect, test } from "bun:test";
import type { SearchResponse } from "../search/index.ts";
import { evaluateJudgments, evaluateQuery, parseJudgmentSet } from "./index.ts";

function response(paths: readonly string[], heading = ""): SearchResponse {
  return {
    query: "fixture",
    requestedFileCount: 10,
    formats: [],
    timing: {
      totalMs: 1,
      embeddingMs: 0.1,
      retrievalMs: 0.5,
      vectorMs: 0.2,
      bm25Ms: 0.2,
      metadataMs: 0.1,
      fusionMs: 0.2,
      aggregationMs: 0.2,
    },
    results: paths.map((path, index) => ({
      fileId: String(index),
      relativePath: path,
      filename: path.split("/").at(-1) ?? path,
      format: "markdown",
      score: 1 / (index + 1),
      matchSources: ["bm25"],
      excerpts: [
        {
          chunkId: String(index),
          text: "fixture",
          startLine: 1,
          endLine: 1,
          startOffset: 0,
          endOffset: 7,
          headingTrail: heading ? [heading] : [],
          symbols: [],
          score: 1,
          matchSources: ["bm25"],
          highlightTerms: [],
        },
      ],
    })),
  };
}

describe("reviewable relevance judgments", () => {
  test("validates unique judgments, expected files, categories, and relevant sections", () => {
    const parsed = parseJudgmentSet({
      version: 1,
      name: "fixture",
      corpus: "fixture/repository",
      judgments: [
        {
          id: "retry",
          query: "retry a charge",
          expectedFiles: ["docs/retries.md", "docs/retries.md"],
          relevantSections: { "docs/retries.md": ["Backoff"] },
          category: "concept",
          rationale: "Human-readable reason",
        },
      ],
    });
    expect(parsed.judgments[0]?.expectedFiles).toEqual(["docs/retries.md"]);

    for (const invalid of [
      null,
      { version: 2, name: "x", corpus: "x", judgments: [] },
      {
        version: 1,
        name: "x",
        corpus: "x",
        judgments: [
          {
            id: "x",
            query: "x",
            expectedFiles: ["x"],
            relevantSections: { other: ["section"] },
            category: "concept",
            rationale: "x",
          },
        ],
      },
    ]) {
      expect(() => parseJudgmentSet(invalid)).toThrow();
    }
  });

  test("computes Recall@5/10, MRR, distinct files, and section hits", async () => {
    const judgment = {
      id: "retry",
      query: "retry",
      expectedFiles: ["docs/retries.md", "src/retry.py"],
      relevantSections: { "docs/retries.md": ["Backoff"] },
      category: "mixed" as const,
      rationale: "Both files are relevant.",
    };
    const evaluated = evaluateQuery(
      judgment,
      response(["noise.md", "docs/retries.md", "other.md", "src/retry.py"], "Backoff"),
    );
    expect(evaluated.firstRelevantRank).toBe(2);
    expect(evaluated.recallAt5).toBe(1);
    expect(evaluated.reciprocalRank).toBe(0.5);
    expect(evaluated.distinctFileRatioAt10).toBe(1);
    expect(evaluated.relevantSectionHit).toBe(true);

    const set = { version: 1 as const, name: "fixture", corpus: "fixture", judgments: [judgment] };
    const report = await evaluateJudgments(set, async () => response([]), {
      generatedAt: "2026-08-21T00:00:00.000Z",
    });
    expect(report.metrics).toEqual({
      queryCount: 1,
      recallAt5: 0,
      recallAt10: 0,
      meanReciprocalRank: 0,
      distinctFileRatioAt10: 1,
      relevantSectionHitRate: 0,
    });
  });
});
