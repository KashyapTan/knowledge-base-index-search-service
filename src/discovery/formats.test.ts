import { describe, expect, test } from "bun:test";
import { formatForExtension, inspectTextBytes, normalizedExtension } from "./formats.ts";
import { createFileId, normalizeRelativePath } from "./identity.ts";
import { createIgnoreMatcher } from "./ignore.ts";

describe("format detection", () => {
  test.each([
    [".md", "markdown"],
    [".mdx", "markdown"],
    [".markdown", "markdown"],
    [".html", "html"],
    [".htm", "html"],
    [".py", "python"],
    [".js", "javascript"],
    [".jsx", "javascript"],
    [".mjs", "javascript"],
    [".cjs", "javascript"],
    [".ts", "typescript"],
    [".tsx", "typescript"],
    [".mts", "typescript"],
    [".cts", "typescript"],
    [".json", "json"],
    [".jsonc", "json"],
    [".yaml", "yaml"],
    [".yml", "yaml"],
    [".toml", "toml"],
    [".css", "stylesheet"],
    [".scss", "stylesheet"],
    [".sass", "stylesheet"],
    [".less", "stylesheet"],
    [".sh", "shell"],
    [".bash", "shell"],
    [".zsh", "shell"],
    [".sql", "sql"],
    [".xml", "xml"],
    [".csv", "csv"],
    [".txt", "text"],
    [".log", "text"],
  ] as const)("maps %s to %s", (extension, format) => {
    expect(formatForExtension(extension)?.format).toBe(format);
  });

  test("normalizes extensions and leaves unfamiliar ones unclassified", () => {
    expect(normalizedExtension("Report.MD")).toBe(".md");
    expect(normalizedExtension("Makefile")).toBe("");
    expect(formatForExtension(".pdf")).toBeUndefined();
  });

  test("positively identifies ordinary, empty, malformed, and binary fallback files", () => {
    const bytes = new TextEncoder().encode("ordinary text\n");
    expect(inspectTextBytes(bytes, true)).toEqual({
      descriptor: { format: "text", mimeFamily: "text/plain" },
      status: "ready",
    });
    expect(inspectTextBytes(new Uint8Array(), true).status).toBe("ready");
    expect(inspectTextBytes(new Uint8Array([0, 1]), true).status).toBe("unsupported");
    expect(inspectTextBytes(new Uint8Array([1, 2, 3, 4, 65]), true).status).toBe("unsupported");
    expect(inspectTextBytes(bytes, false).status).toBe("malformed");
    expect(inspectTextBytes(bytes, false, formatForExtension(".md")).descriptor.format).toBe(
      "markdown",
    );
  });
});

describe("stable paths, IDs, and ignores", () => {
  test("normalizes root-relative paths and rejects escapes", () => {
    expect(normalizeRelativePath("/repo", "/repo/docs/cafe\u0301.md")).toBe("docs/caf\u00e9.md");
    expect(normalizeRelativePath("/repo", "/repo")).toBeUndefined();
    expect(normalizeRelativePath("/repo", "/other/file.md")).toBeUndefined();
  });

  test("creates deterministic root-scoped IDs", () => {
    const first = createFileId("root-a", "docs/readme.md");
    expect(first).toBe(createFileId("root-a", "docs/readme.md"));
    expect(first).not.toBe(createFileId("root-b", "docs/readme.md"));
    expect(first).not.toBe(createFileId("root-a", "docs/other.md"));
  });

  test("supports explicit root-relative globs without hiding ordinary dotfiles", () => {
    const matcher = createIgnoreMatcher([
      "# comment",
      "",
      "scratch/",
      "*.tmp",
      "generated/**/cache.json",
    ]);
    expect(matcher.ignores("scratch", true)).toBe(true);
    expect(matcher.ignores("nested/file.tmp", false)).toBe(true);
    expect(matcher.ignores("generated/a/cache.json", false)).toBe(true);
    expect(matcher.ignores(".hidden.md", false)).toBe(false);
    expect(matcher.ignores("source/.git/config", false)).toBe(true);
    expect(matcher.ignores("scratch.txt", false)).toBe(false);
  });
});
