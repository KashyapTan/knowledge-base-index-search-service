import { describe, expect, test } from "bun:test";
import { createSearchConfig } from "./config.ts";
import { DEFAULT_SEARCH_CONFIG } from "./contracts.ts";

describe("search configuration", () => {
  test("merges observable tuning parameters without mutating defaults", () => {
    const configured = createSearchConfig({
      vectorCandidates: 7,
      rrfConstant: 5,
      sourceWeights: { metadata: 4 },
    });
    expect(configured.vectorCandidates).toBe(7);
    expect(configured.rrfConstant).toBe(5);
    expect(configured.sourceWeights).toEqual({ vector: 1, bm25: 1, metadata: 4 });
    expect(DEFAULT_SEARCH_CONFIG.sourceWeights.metadata).toBe(2);
  });

  test.each([
    [{ vectorCandidates: 0 }, "vectorCandidates"],
    [{ defaultFileCount: 5, maxFileCount: 4 }, "defaultFileCount"],
    [{ metadataFuzzyMaxDistance: -1 }, "metadataFuzzyMaxDistance"],
    [{ maxSupplementalFileScoreRatio: 2 }, "maxSupplementalFileScoreRatio"],
    [{ supplementalScoreDecay: -0.1 }, "supplementalScoreDecay"],
    [{ maxVectorDistance: 3 }, "maxVectorDistance"],
    [{ sourceWeights: { bm25: -1 } }, "source weight"],
  ] as const)("rejects invalid configuration containing %s", (overrides, message) => {
    expect(() => createSearchConfig(overrides)).toThrow(message);
  });
});
