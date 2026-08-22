import { describe, expect, test } from "bun:test";
import { chunkDocument } from "./chunker.ts";
import type { ChunkingOptions, ExtractedDocument, ExtractedUnit } from "./contracts.ts";
import { extractText } from "./test-helpers.ts";
import { createUnicodeWordTokenCounter } from "./tokenizer.ts";

const tokenizer = createUnicodeWordTokenCounter();

function options(overrides: Partial<ChunkingOptions> = {}): ChunkingOptions {
  return {
    tokenizer,
    maxTokens: 64,
    index: {
      chunkSizeTokens: 52,
      chunkOverlapTokens: 6,
      chunkerVersion: 1,
      extractorVersion: 1,
    },
    ...overrides,
  };
}

describe("structure-aware chunking", () => {
  test("produces deterministic IDs, separate display text, and enriched search context", () => {
    const document = extractText(
      "guides/gateway.md",
      "markdown",
      "# Gateway\n\nAuthorize cards locally.\n\nRetry only transient failures.",
    );
    const first = chunkDocument(document, options());
    const second = chunkDocument(document, options());
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]?.searchText).toContain("Path: guides/gateway.md");
    expect(first[0]?.searchText).toContain("Heading: Gateway");
    expect(first[0]?.displayText).not.toContain("Path:");
    expect(first[0]?.contentHash).toHaveLength(64);
    expect(first[0]?.chunkId).toHaveLength(64);
    expect(first[0]?.ordinal).toBe(0);
  });

  test("splits an extremely long semantic unit under the target with token overlap", () => {
    const words = Array.from({ length: 220 }, (_, index) => `token${index}`).join(" ");
    const document = extractText("long.txt", "text", words);
    const chunks = chunkDocument(document, options());
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((chunk) => chunk.tokenCount <= 52)).toBeTrue();
    expect(chunks.every((chunk) => words.includes(chunk.displayText))).toBeTrue();
    expect(chunks.at(-1)?.displayText.endsWith("token219")).toBeTrue();
    for (let index = 1; index < chunks.length; index += 1) {
      const previousWords = chunks[index - 1]?.displayText.split(/\s+/u) ?? [];
      const currentWords = new Set(chunks[index]?.displayText.split(/\s+/u));
      expect(previousWords.slice(-4).some((word) => currentWords.has(word))).toBeTrue();
    }
  });

  test("uses a bounded cached-count fallback without changing chunk boundaries", () => {
    const document = extractText(
      "cached.txt",
      "text",
      Array.from({ length: 220 }, (_, index) => `unicode-${index}-λ`).join(" "),
    );
    const calls = new Map<string, number>();
    const counted = {
      count(text: string) {
        calls.set(text, (calls.get(text) ?? 0) + 1);
        return tokenizer.count(text);
      },
    };
    const cached = chunkDocument(document, options({ tokenizer: counted }));
    const reference = chunkDocument(document, options());
    expect(cached).toEqual(reference);
    expect(Math.max(...calls.values())).toBe(1);
    expect(cached.every((chunk) => chunk.tokenCount <= 52)).toBe(true);
  });

  test("splits a large code declaration without losing symbol context", () => {
    const body = Array.from(
      { length: 120 },
      (_, index) => `  const value${index} = ${index};`,
    ).join("\n");
    const document = extractText(
      "large.ts",
      "typescript",
      `export function buildGateway() {\n${body}\n  return value119;\n}`,
    );
    const chunks = chunkDocument(document, options());
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.every((chunk) => chunk.symbols.includes("buildGateway"))).toBeTrue();
    expect(chunks.every((chunk) => chunk.tokenCount <= 64)).toBeTrue();
  });

  test("combines small units only within a shared section and overlaps whole trailing units", () => {
    const paragraphs = Array.from(
      { length: 10 },
      (_, index) => `Paragraph ${index} alpha beta gamma.`,
    ).join("\n\n");
    const document = extractText(
      "notes.md",
      "markdown",
      `# One\n\n${paragraphs}\n\n# Two\n\nFinal section.`,
    );
    const chunks = chunkDocument(document, options());
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((chunk) => chunk.headingTrail[0] === "Two")).toBeTrue();
    expect(chunks.every((chunk) => chunk.tokenCount <= 64)).toBeTrue();
  });

  test("keeps every chunk range and offset inside the source document", () => {
    for (let length = 1; length <= 80; length += 7) {
      const text = Array.from({ length }, (_, index) => `line ${index} value`).join("\n");
      const document = extractText("property.log", "text", text);
      for (const chunk of chunkDocument(document, options())) {
        expect(chunk.startLine).toBeGreaterThanOrEqual(1);
        expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
        expect(chunk.endLine).toBeLessThanOrEqual(length);
        expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
        expect(chunk.endOffset).toBeGreaterThanOrEqual(chunk.startOffset);
        expect(chunk.endOffset).toBeLessThanOrEqual(text.length);
        expect(chunk.tokenCount).toBe(tokenizer.count(chunk.searchText));
      }
    }
  });

  test("preserves deterministic token and navigation invariants across every format family", () => {
    const cases = [
      ["sample.md", "markdown", "# Héading λ\n\nParagraph with Unicode 🚀."],
      ["sample.html", "html", "<h1>Héading</h1><p>Visible λ text</p>"],
      ["sample.py", "python", "def retry(value):\n    return value + 1\n"],
      ["sample.js", "javascript", "export function retry(v) { return v + 1; }"],
      ["sample.ts", "typescript", "export const retry = (v: number) => v + 1;"],
      ["sample.json", "json", '{"retry":{"count":3}}'],
      ["sample.yaml", "yaml", "retry:\n  count: 3\n"],
      ["sample.toml", "toml", "[retry]\ncount = 3\n"],
      ["sample.css", "stylesheet", ".retry { color: red; }"],
      ["sample.sh", "shell", "retry() { echo retry; }"],
      ["sample.sql", "sql", "CREATE TABLE retry (count INTEGER);"],
      ["sample.xml", "xml", "<retry><count>3</count></retry>"],
      ["sample.csv", "csv", "name,count\nretry,3\n"],
      ["sample.log", "text", "retry count λ 3\nmalformed \ud800 input"],
    ] as const;
    for (const [path, format, text] of cases) {
      const document = extractText(path, format, text);
      const first = chunkDocument(document, options());
      expect(first).toEqual(chunkDocument(document, options()));
      for (const chunk of first) {
        expect(chunk.tokenCount).toBeLessThanOrEqual(64);
        expect(chunk.startLine).toBeGreaterThanOrEqual(1);
        expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
        expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
        expect(chunk.endOffset).toBeGreaterThanOrEqual(chunk.startOffset);
        expect(chunk.endOffset).toBeLessThanOrEqual(text.length);
      }
    }
  });

  test("content or semantic location changes produce a different stable ID", () => {
    const original = extractText("same.md", "markdown", "# A\n\noriginal");
    const edited = extractText("same.md", "markdown", "# A\n\nedited");
    const moved = extractText("same.md", "markdown", "\n# A\n\noriginal");
    expect(chunkDocument(original, options())[0]?.chunkId).not.toBe(
      chunkDocument(edited, options())[0]?.chunkId,
    );
    expect(chunkDocument(original, options())[0]?.chunkId).not.toBe(
      chunkDocument(moved, options())[0]?.chunkId,
    );
  });

  test("validates configuration and rejects content that cannot fit model context", () => {
    const document = extractText("tiny.txt", "text", "content");
    expect(() => chunkDocument(document, options({ maxTokens: 0 }))).toThrow("positive");
    expect(() => chunkDocument(document, options({ maxTokens: 20 }))).toThrow("cannot exceed");
    const costly = { count: (text: string) => text.length + 100 };
    expect(() => chunkDocument(document, options({ tokenizer: costly, maxTokens: 64 }))).toThrow(
      "above the 64 limit",
    );
  });

  test("handles empty documents and preserves extractor/chunker versions", () => {
    const empty = extractText("empty.txt", "text", "");
    expect(chunkDocument(empty, options())).toEqual([]);
    const document = extractText("one.txt", "text", "one record");
    const chunks = chunkDocument(
      document,
      options({
        index: {
          chunkSizeTokens: 52,
          chunkOverlapTokens: 6,
          extractorVersion: 7,
          chunkerVersion: 9,
        },
      }),
    );
    expect(chunks[0]).toMatchObject({ extractorVersion: 7, chunkerVersion: 9 });
  });

  test("rejects impossible empty fragment merges through a direct malformed document invariant", () => {
    const unit: ExtractedUnit = {
      kind: "text",
      displayText: "",
      searchText: "",
      range: { startLine: 1, endLine: 1, startOffset: 0, endOffset: 0 },
      headingTrail: [],
    };
    const document: ExtractedDocument = {
      fileId: "file",
      relativePath: "empty.txt",
      normalizedText: "",
      metadata: { format: "text", language: "text", headings: [], symbols: [] },
      units: [unit],
      warnings: [],
      extractorVersion: 1,
    };
    expect(chunkDocument(document, options())).toEqual([]);
  });
});
