import { describe, expect, test } from "bun:test";
import { createSearchConfig } from "./config.ts";
import { fuseCandidatePools, rankWithTies, reciprocalRank } from "./fusion.ts";
import { candidate } from "./test-helpers.ts";

describe("reciprocal rank fusion", () => {
  test("computes configurable weighted reciprocal rank", () => {
    expect(reciprocalRank(2, 10)).toBeCloseTo(1 / 12);
    expect(reciprocalRank(2, 10, 3)).toBeCloseTo(3 / 12);
  });

  test("assigns competition ranks to ties and deduplicates within a source", () => {
    const ranked = rankWithTies(
      [
        { id: "b", score: 5 },
        { id: "a", score: 5 },
        { id: "a", score: 2 },
        { id: "c", score: 1 },
      ],
      (item) => item.score,
      (item) => item.id,
    );
    expect(ranked.map(({ item, rank }) => [item.id, rank])).toEqual([
      ["a", 1],
      ["b", 1],
      ["c", 3],
    ]);
  });

  test("handles empty lists and merges duplicate chunks from independent sources", () => {
    const config = createSearchConfig({ rrfConstant: 10 });
    expect(fuseCandidatePools({ vector: [], bm25: [], metadata: [] }, config)).toEqual([]);
    const sharedVector = candidate("shared", "one", "vector", 0.01);
    const sharedBm25 = candidate("shared", "one", "bm25", 9_000);
    const fused = fuseCandidatePools(
      {
        vector: [sharedVector],
        bm25: [sharedBm25],
        metadata: [],
      },
      config,
    );
    expect(fused).toHaveLength(1);
    expect(fused[0]?.matches.map((match) => match.source)).toEqual(["bm25", "vector"]);
    expect(fused[0]?.score).toBeCloseTo(2 / 11);
  });

  test("does not compare incompatible raw score scales across sources", () => {
    const config = createSearchConfig({ rrfConstant: 10, sourceWeights: { metadata: 1 } });
    const fused = fuseCandidatePools(
      {
        vector: [candidate("vector-top", "v", "vector", 0.5)],
        bm25: [candidate("bm25-top", "b", "bm25", 1_000_000)],
        metadata: [],
      },
      config,
    );
    expect(fused[0]?.score).toBeCloseTo(fused[1]?.score ?? 0);
  });

  test("lets an exact identifier outrank a weak semantic conflict through explicit weights", () => {
    const exact = candidate("exact", "config", "metadata", 1, {
      metadataMatch: { field: "symbol", kind: "exact", strength: 0.9, term: "timeout_ms" },
    });
    const semantic = candidate("semantic", "docs", "vector", 1);
    const fused = fuseCandidatePools(
      {
        vector: [semantic, { ...exact, source: "vector", rawScore: 0.1 }],
        bm25: [],
        metadata: [exact],
      },
      createSearchConfig(),
    );
    expect(fused[0]?.chunkId).toBe("exact");
    expect(fused[0]?.matches).toHaveLength(2);
  });

  test("changes ordering when benchmark-facing constants and weights change", () => {
    const vectorOnly = candidate("vector", "v", "vector", 1);
    const metadataOnly = candidate("metadata", "m", "metadata", 1);
    const pools = { vector: [vectorOnly], bm25: [], metadata: [metadataOnly] };
    expect(fuseCandidatePools(pools, createSearchConfig())[0]?.chunkId).toBe("metadata");
    expect(
      fuseCandidatePools(
        pools,
        createSearchConfig({ sourceWeights: { vector: 3, metadata: 1 } }),
      )[0]?.chunkId,
    ).toBe("vector");
  });
});
