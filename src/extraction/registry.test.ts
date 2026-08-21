import { describe, expect, test } from "bun:test";
import type { Extractor } from "./contracts.ts";
import { plainTextExtractor } from "./extractors/plain.ts";
import { createDefaultExtractorRegistry, ExtractorRegistry } from "./registry.ts";
import { extractionContext } from "./test-helpers.ts";

describe("extractor registry", () => {
  test("registers every discovery format family", () => {
    const registry = createDefaultExtractorRegistry();
    for (const format of [
      "markdown",
      "html",
      "python",
      "javascript",
      "typescript",
      "json",
      "yaml",
      "toml",
      "xml",
      "shell",
      "sql",
      "stylesheet",
      "csv",
      "text",
      "unknown",
    ] as const) {
      expect(registry.get(format)).toBeDefined();
    }
  });

  test("rejects duplicate registrations", () => {
    expect(() => new ExtractorRegistry([plainTextExtractor, plainTextExtractor])).toThrow(
      "already registered",
    );
  });

  test("isolates extractor failure with actionable plain-text fallback", () => {
    const throwing: Extractor = {
      name: "broken-parser",
      formats: ["markdown"],
      extract() {
        throw new Error("fixture parser failure");
      },
    };
    const registry = new ExtractorRegistry([throwing], plainTextExtractor);
    const document = registry.extract(
      extractionContext("broken.md", "markdown", "still searchable"),
    );
    expect(document.normalizedText).toContain("still searchable");
    expect(document.warnings).toContainEqual(
      expect.objectContaining({
        code: "PARSER_FALLBACK",
        message: expect.stringContaining("broken-parser"),
      }),
    );
  });

  test("reports a missing extractor", () => {
    const registry = new ExtractorRegistry([plainTextExtractor]);
    expect(() => registry.extract(extractionContext("file.py", "python", "pass"))).toThrow(
      "No extractor",
    );
  });
});
