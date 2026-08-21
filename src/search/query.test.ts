import { describe, expect, test } from "bun:test";
import { createSearchConfig } from "./config.ts";
import { normalizeSearchRequest, queryTerms, quotedPhrases } from "./query.ts";

describe("search query handling", () => {
  const config = createSearchConfig({
    defaultFileCount: 5,
    maxQueryLength: 40,
    maxFileCount: 5,
    maxFormatFilters: 2,
  });

  test.each([
    ["  HTTPError: E_CONN_RESET  ", "HTTPError: E_CONN_RESET"],
    ['  "Card declined: 05"  ', '"Card declined: 05"'],
    ["src/payments/gateway.ts", "src/payments/gateway.ts"],
    ["camelCase.Key_Name", "camelCase.Key_Name"],
  ])("trims only surrounding whitespace in %s", (input, expected) => {
    const result = normalizeSearchRequest({ query: input }, config);
    expect(result.ok && result.value.query).toBe(expected);
  });

  test.each(["", "   ", "\n\t"])("rejects empty input %#", (query) => {
    const result = normalizeSearchRequest({ query }, config);
    expect(!result.ok && result.error.code).toBe("SEARCH_QUERY_INVALID");
  });

  test("rejects oversized queries and invalid requested counts", () => {
    expect(normalizeSearchRequest({ query: "x".repeat(41) }, config).ok).toBe(false);
    for (const fileCount of [0, 1.5, 6]) {
      const result = normalizeSearchRequest({ query: "valid", fileCount }, config);
      expect(!result.ok && result.error.code).toBe("SEARCH_REQUEST_INVALID");
    }
  });

  test("normalizes, deduplicates, and validates format filters", () => {
    const valid = normalizeSearchRequest(
      { query: "valid", fileCount: 3, formats: ["Markdown", " markdown ", "ts"] },
      config,
    );
    expect(valid).toEqual({
      ok: true,
      value: { query: "valid", fileCount: 3, formats: ["markdown", "ts"] },
    });
    expect(normalizeSearchRequest({ query: "valid", formats: ["bad format"] }, config).ok).toBe(
      false,
    );
    expect(normalizeSearchRequest({ query: "valid", formats: ["md", "ts", "py"] }, config).ok).toBe(
      false,
    );
  });

  test("extracts safe literal highlight terms and quoted phrases", () => {
    const query = 'find "gateway timeout" in config/retry.yaml timeout_ms';
    expect(quotedPhrases(query)).toEqual(["gateway timeout"]);
    expect(queryTerms(query)).toEqual([
      "gateway timeout",
      "find",
      "gateway",
      "timeout",
      "in",
      "config/retry.yaml",
      "timeout_ms",
    ]);
  });
});
