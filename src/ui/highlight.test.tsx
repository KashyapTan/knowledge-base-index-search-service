import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HighlightedText, highlightRanges } from "./highlight.tsx";

describe("reliable literal search highlighting", () => {
  test("finds repeated case-insensitive literals and merges overlaps", () => {
    expect(highlightRanges("Gateway timeout GATEWAY", ["gateway", "way time", ""])).toEqual([
      { start: 0, end: 12 },
      { start: 16, end: 23 },
    ]);
  });

  test("renders safe mark elements without interpreting repository markup", () => {
    const html = renderToStaticMarkup(
      <p>
        <HighlightedText text={'<script>alert("x")</script>'} terms={["alert"]} />
      </p>,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<mark>alert</mark>");
    expect(html).not.toContain("<script>");
    expect(highlightRanges("nothing", ["missing"])).toEqual([]);
  });
});
