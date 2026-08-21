import { describe, expect, test } from "bun:test";
import { normalizeSourceText } from "./normalization.ts";

describe("source normalization", () => {
  test("normalizes mixed line endings and maps offsets to the original source", () => {
    const source = normalizeSourceText("alpha\r\nbeta\rgamma\n");
    expect(source.text).toBe("alpha\nbeta\ngamma\n");
    expect(source.lines.map((line) => [line.number, line.text])).toEqual([
      [1, "alpha"],
      [2, "beta"],
      [3, "gamma"],
      [4, ""],
    ]);
    expect(source.toOriginalOffset(6)).toBe(7);
    expect(source.range(6, 10)).toEqual({
      startLine: 2,
      endLine: 2,
      startOffset: 7,
      endOffset: 11,
    });
    expect(source.warnings.map((warning) => warning.code)).toContain("LINE_ENDINGS_NORMALIZED");
  });

  test("replaces only unpaired surrogates and preserves valid pairs", () => {
    const source = normalizeSourceText(`a\ud800b \ud83d\ude80 c\udc00`);
    expect(source.text).toBe("a\ufffdb \ud83d\ude80 c\ufffd");
    expect(source.originalLength).toBe(9);
    expect(source.toOriginalOffset(1)).toBe(1);
    expect(source.toOriginalOffset(999)).toBe(9);
    expect(source.warnings).toEqual([
      expect.objectContaining({ code: "INVALID_UNICODE_REPLACED" }),
    ]);
  });

  test("clamps invalid range inputs and represents an empty file", () => {
    const source = normalizeSourceText("");
    expect(source.lines).toEqual([{ number: 1, text: "", start: 0, end: 0, endIncludingBreak: 0 }]);
    expect(source.range(-20, 50)).toEqual({
      startLine: 1,
      endLine: 1,
      startOffset: 0,
      endOffset: 0,
    });
    expect(source.warnings).toEqual([]);
  });
});
