import { describe, expect, test } from "bun:test";
import { MAX_PREVIEW_CHARACTERS, previewAllowed, rendererForFormat } from "./contracts.ts";
import { changedFileNotice } from "./file-viewer.tsx";
import { classifyLink } from "./link-policy.ts";

describe("viewer metadata and policies", () => {
  test("selects renderers and language metadata from trusted formats", () => {
    expect(rendererForFormat("markdown")).toEqual({
      kind: "markdown",
      label: "Markdown preview",
      supportsPreview: true,
    });
    expect(rendererForFormat("html")).toMatchObject({
      kind: "html",
      language: "xml",
      supportsPreview: true,
    });
    expect(rendererForFormat("typescript")).toMatchObject({ kind: "code", language: "typescript" });
    expect(rendererForFormat("shell")).toMatchObject({ kind: "code", language: "shell" });
    expect(rendererForFormat("csv")).toMatchObject({ kind: "text", label: "CSV text" });
    expect(rendererForFormat("unknown")).toMatchObject({ kind: "text", label: "Plain text" });
    expect(previewAllowed("markdown", MAX_PREVIEW_CHARACTERS)).toBe(true);
    expect(previewAllowed("markdown", MAX_PREVIEW_CHARACTERS + 1)).toBe(false);
    expect(previewAllowed("typescript", 10)).toBe(false);
  });

  test("permits only fragments and absolute HTTP(S) links", () => {
    expect(classifyLink("#section")).toEqual({ kind: "fragment", href: "#section" });
    expect(classifyLink("https://example.com/a")).toMatchObject({
      kind: "external",
      href: "https://example.com/a",
    });
    expect(classifyLink("http://example.com")).toMatchObject({ kind: "external" });
    for (const value of [
      undefined,
      "",
      "guide.md",
      "javascript:alert(1)",
      "file:///tmp/secret",
      "data:text/html,bad",
      "mailto:a@example.com",
    ]) {
      expect(classifyLink(value)).toEqual({ kind: "blocked" });
    }
  });

  test("tracks only the selected file's latest change state", () => {
    const id = "a".repeat(64);
    expect(changedFileNotice(id, [{ fileId: id, kind: "changed" }])).toBe("changed");
    expect(
      changedFileNotice(id, [
        { fileId: id, kind: "changed" },
        { fileId: id, kind: "deleted" },
      ]),
    ).toBe("deleted");
    expect(changedFileNotice(id, [{ fileId: "b".repeat(64), kind: "deleted" }])).toBeUndefined();
  });
});
