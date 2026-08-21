import { describe, expect, test } from "bun:test";
import { readUrlState, searchUrl, selectedFileUrl, withoutSelectedFile } from "./url-state.ts";

describe("shareable search URL state", () => {
  test("reads valid state and rejects unsafe or out-of-range values", () => {
    const fileId = "a".repeat(64);
    expect(
      readUrlState(new URL(`http://localhost/?q=timeout_ms%28%29&n=20&file=${fileId}&line=42`)),
    ).toEqual({
      query: "timeout_ms()",
      fileCount: 20,
      selectedFileId: fileId,
      selectedLine: 42,
    });
    expect(readUrlState(new URL("http://localhost/?n=0&file=../secret&line=-2"))).toEqual({
      query: "",
      fileCount: 10,
    });
    expect(readUrlState(new URL("http://localhost/?n=2.5"))).toMatchObject({ fileCount: 10 });
  });

  test("writes exact query/count state and manages viewer state independently", () => {
    const current = new URL(`http://localhost/search?file=${"a".repeat(64)}&line=2#top`);
    const searched = searchUrl(current, `Error: "Gateway/Timeout"`, 30);
    expect(searched.searchParams.get("q")).toBe(`Error: "Gateway/Timeout"`);
    expect(searched.searchParams.get("n")).toBe("30");
    expect(searched.searchParams.get("file")).toBe("a".repeat(64));
    expect(searched.searchParams.get("line")).toBe("2");
    expect(searched.hash).toBe("#top");

    const selected = selectedFileUrl(searched, "b".repeat(64), 9);
    expect(selected.searchParams.get("file")).toBe("b".repeat(64));
    expect(selected.searchParams.get("line")).toBe("9");
    expect(withoutSelectedFile(selected).searchParams.has("file")).toBe(false);

    const defaults = searchUrl(selected, "", 10);
    expect(defaults.searchParams.has("q")).toBe(false);
    expect(defaults.searchParams.has("n")).toBe(false);
  });
});
