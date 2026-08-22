import { describe, expect, test } from "bun:test";
import { GrepCoordinator, matchIndexNearestLine, runGrep, wrappedMatchIndex } from "./grep.ts";

describe("in-file grep", () => {
  test("finds overlapping literal matches with case control and exact source positions", () => {
    const insensitive = runGrep("Banana\nBANANA", {
      query: "ana",
      regex: false,
      caseSensitive: false,
    });
    expect(insensitive.matches).toEqual([
      { start: 1, end: 4, line: 1, column: 2 },
      { start: 3, end: 6, line: 1, column: 4 },
      { start: 8, end: 11, line: 2, column: 2 },
      { start: 10, end: 13, line: 2, column: 4 },
    ]);
    expect(
      runGrep("Alpha alpha", { query: "Alpha", regex: false, caseSensitive: true }).matches,
    ).toHaveLength(1);
  });

  test("supports Unicode, regular expressions, invalid expressions, and zero-width matches", () => {
    const unicode = runGrep("😀 café\nCAFÉ", {
      query: "café",
      regex: false,
      caseSensitive: false,
    });
    expect(unicode.matches.map(({ line, column }) => ({ line, column }))).toEqual([
      { line: 1, column: 4 },
      { line: 2, column: 1 },
    ]);
    expect(
      runGrep("ab12 cd34", { query: "[a-z]+(?=\\d)", regex: true, caseSensitive: true }).matches,
    ).toHaveLength(2);
    expect(
      runGrep("abc", { query: "(?=.)", regex: true, caseSensitive: true }).matches,
    ).toHaveLength(3);
    expect(runGrep("abc", { query: "[", regex: true, caseSensitive: true })).toEqual({
      matches: [],
      error: "The regular expression is invalid.",
      limited: false,
    });
  });

  test("rejects regex denial-of-service constructs before evaluation", () => {
    for (const query of ["(a+)+$", "(.*){2,}", "^(a+)\\1$", "a".repeat(513)]) {
      const result = runGrep("a".repeat(10_000), {
        query,
        regex: true,
        caseSensitive: true,
      });
      expect(result.matches).toEqual([]);
      expect(result.error).toMatch(/safe|unsafe/u);
    }
  });

  test("bounds huge result sets and navigates with wraparound and source-line selection", () => {
    const bounded = runGrep("aaaa", {
      query: "a",
      regex: false,
      caseSensitive: true,
      maximumMatches: 2,
    });
    expect(bounded).toMatchObject({ limited: true, matches: [{ start: 0 }, { start: 1 }] });
    expect(wrappedMatchIndex(-1, 3, 1)).toBe(0);
    expect(wrappedMatchIndex(0, 3, -1)).toBe(2);
    expect(wrappedMatchIndex(2, 3, 1)).toBe(0);
    expect(wrappedMatchIndex(0, 0, 1)).toBe(-1);
    expect(
      matchIndexNearestLine(
        [
          { start: 0, end: 1, line: 2, column: 1 },
          { start: 5, end: 6, line: 8, column: 1 },
        ],
        5,
      ),
    ).toBe(1);
    expect(matchIndexNearestLine([{ start: 0, end: 1, line: 2, column: 1 }], 20)).toBe(0);
  });

  test("cancels stale searches before they can publish", async () => {
    const pending: Array<(value: ReturnType<typeof runGrep>) => void> = [];
    const coordinator = new GrepCoordinator(
      (_content, _options, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => undefined, { once: true });
          pending.push(resolve);
        }),
    );
    const first = coordinator.search("old", { query: "o", regex: false, caseSensitive: true });
    const second = coordinator.search("new", { query: "n", regex: false, caseSensitive: true });
    pending[0]?.(runGrep("old", { query: "o", regex: false, caseSensitive: true }));
    pending[1]?.(runGrep("new", { query: "n", regex: false, caseSensitive: true }));
    expect(await first).toBeUndefined();
    expect((await second)?.matches[0]?.start).toBe(0);
    coordinator.cancel();
  });
});
