import { describe, expect, test } from "bun:test";
import { createSearchConfig } from "./config.ts";
import { bestMetadataMatch, levenshteinDistance } from "./metadata.ts";

describe("metadata matching", () => {
  const config = createSearchConfig();
  const metadata = {
    filename: "GatewayRetry.ts",
    relativePath: "src/payments/GatewayRetry.ts",
    headingTrail: ["Retry policy", "Transient failures"],
    symbols: ["retryPayment", "TIMEOUT_MS"],
  };

  test.each([
    ["GatewayRetry.ts", "filename", "exact"],
    ["Gateway", "filename", "prefix"],
    ["payments/Gateway", "path", "substring"],
    ["retryPayment", "symbol", "exact"],
    ["Transient failures", "heading", "exact"],
    ["retryPaymant", "symbol", "fuzzy"],
  ] as const)("matches %s against %s as %s", (query, field, kind) => {
    expect(bestMetadataMatch(metadata, query, config)).toMatchObject({ field, kind });
  });

  test("gives exact filename matches more strength than headings and ignores unrelated input", () => {
    const filename = bestMetadataMatch(metadata, "GatewayRetry.ts", config);
    const heading = bestMetadataMatch(metadata, "Transient failures", config);
    expect(filename && heading && filename.strength).toBeGreaterThan(heading?.strength ?? 0);
    expect(bestMetadataMatch(metadata, "completely-unrelated", config)).toBeUndefined();
  });

  test.each([
    ["kitten", "sitting", 3],
    ["timeout_ms", "timeout_ms", 0],
    ["", "abc", 3],
    ["abc", "", 3],
  ])("computes Levenshtein distance for %s and %s", (left, right, distance) => {
    expect(levenshteinDistance(left, right)).toBe(distance);
  });
});
