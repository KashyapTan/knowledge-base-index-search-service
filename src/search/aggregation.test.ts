import { describe, expect, test } from "bun:test";
import { aggregateByFile } from "./aggregation.ts";
import { createSearchConfig } from "./config.ts";
import { fusedCandidate } from "./test-helpers.ts";

describe("file aggregation", () => {
  test("returns top-X distinct files instead of top chunks", () => {
    const results = aggregateByFile(
      [
        fusedCandidate("a1", "a", 1),
        fusedCandidate("a2", "a", 0.9),
        fusedCandidate("b1", "b", 0.8),
        fusedCandidate("c1", "c", 0.7),
      ],
      "text",
      2,
      createSearchConfig(),
    );
    expect(results.map((result) => result.fileId)).toEqual(["a", "b"]);
    expect(new Set(results.map((result) => result.fileId)).size).toBe(2);
  });

  test("caps the advantage from many mediocre chunks", () => {
    const largeFile = Array.from({ length: 20 }, (_, index) =>
      fusedCandidate(`large-${index}`, "large", 0.6),
    );
    const results = aggregateByFile(
      [...largeFile, fusedCandidate("strong", "small", 0.7)],
      "text",
      2,
      createSearchConfig(),
    );
    expect(results[0]?.fileId).toBe("small");
    expect(results[1]?.score).toBeLessThanOrEqual(0.6 * 1.15);
  });

  test("selects distinct sections before filling repeated contexts", () => {
    const results = aggregateByFile(
      [
        fusedCandidate("intro-1", "guide", 1, { headingTrail: ["Intro"] }),
        fusedCandidate("intro-2", "guide", 0.9, { headingTrail: ["Intro"] }),
        fusedCandidate("usage", "guide", 0.8, { headingTrail: ["Usage"] }),
        fusedCandidate("api", "guide", 0.7, { headingTrail: ["API"] }),
      ],
      "text",
      1,
      createSearchConfig({ maxExcerptsPerFile: 3 }),
    );
    expect(results[0]?.excerpts.map((excerpt) => excerpt.chunkId)).toEqual([
      "intro-1",
      "usage",
      "api",
    ]);
  });

  test("preserves navigation metadata, source labels, and safe literal highlights", () => {
    const input = fusedCandidate("lines", "guide", 1, {
      displayText: "TIMEOUT_MS controls the gateway timeout.",
      startLine: 20,
      endLine: 24,
      startOffset: 100,
      endOffset: 144,
      headingTrail: ["Configuration"],
      symbols: ["TIMEOUT_MS"],
      matches: [
        { source: "bm25", rank: 1, rawScore: 12 },
        { source: "metadata", rank: 1, rawScore: 1 },
      ],
    });
    const [result] = aggregateByFile(
      [input],
      '"gateway timeout" TIMEOUT_MS absent',
      1,
      createSearchConfig(),
    );
    expect(result?.matchSources).toEqual(["bm25", "metadata"]);
    expect(result?.excerpts[0]).toMatchObject({
      startLine: 20,
      endLine: 24,
      startOffset: 100,
      endOffset: 144,
      headingTrail: ["Configuration"],
      symbols: ["TIMEOUT_MS"],
      highlightTerms: ["gateway timeout", "gateway", "timeout", "TIMEOUT_MS"],
    });
  });

  test("handles no candidates and zero supplemental score without division behavior", () => {
    expect(aggregateByFile([], "none", 10, createSearchConfig())).toEqual([]);
    const result = aggregateByFile(
      [fusedCandidate("only", "one", 0)],
      "none",
      1,
      createSearchConfig(),
    );
    expect(result[0]?.score).toBe(0);
  });
});
