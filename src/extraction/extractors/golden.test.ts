import { describe, expect, test } from "bun:test";
import type { FileFormat } from "../../discovery/index.ts";
import { extractText, fixture } from "../test-helpers.ts";

describe("reviewed extractor fixtures", () => {
  test("Markdown and MDX preserve semantic blocks and nested heading context", async () => {
    const source = await fixture("sample.md");
    const document = extractText("sample.md", "markdown", source);
    expect(document.metadata.language).toBe("markdown");
    expect(document.metadata.title).toBe("Gateway Guide");
    expect(document.normalizedText).toContain("title: Gateway Operations");
    expect(document.normalizedText.startsWith("---")).toBeFalse();
    expect(document.units.map((unit) => unit.kind)).toEqual([
      "record",
      "heading",
      "paragraph",
      "heading",
      "list",
      "quote",
      "table",
      "code",
    ]);
    const retryList = document.units.find((unit) => unit.kind === "list");
    expect(retryList?.headingTrail).toEqual(["Gateway Guide", "Retry Policy"]);
    expect(retryList?.range).toEqual({
      startLine: 12,
      endLine: 13,
      startOffset: 145,
      endOffset: 203,
    });
    expect(document.normalizedText).toContain("const retryable = status === 503;");

    const mdx = extractText("sample.mdx", "markdown", await fixture("sample.mdx"));
    expect(mdx.metadata.language).toBe("mdx");
    expect(mdx.metadata.title).toBe("Gateway Component");
    expect(mdx.normalizedText).toContain("<Gateway mode={gatewayMode} />");
  });

  test("HTML retains metadata and visible sections while excluding active/noisy content", async () => {
    const document = extractText("sample.html", "html", await fixture("sample.html"));
    expect(document.metadata).toMatchObject({
      title: "Gateway Reference",
      description: "Local card gateway notes",
    });
    expect(document.normalizedText).toContain("Card & Gateway");
    expect(document.normalizedText).toContain("authorize({ amount: 42 })");
    expect(document.normalizedText).toContain("200 approved");
    for (const omitted of ["script-noise", "style-noise", "navigation-noise", "template-noise"]) {
      expect(document.normalizedText).not.toContain(omitted);
    }
    expect(document.warnings).toContainEqual(expect.objectContaining({ code: "CONTENT_OMITTED" }));
    const heading = document.units.find((unit) => unit.searchText === "Examples");
    expect(heading?.range.startLine).toBe(13);
  });

  test("Python prefers module, class, method, and function boundaries", async () => {
    const document = extractText("sample.py", "python", await fixture("sample.py"));
    expect(document.metadata.symbols).toEqual(["GatewayClient", "authorize", "settle"]);
    expect(document.units[0]?.kind).toBe("comment");
    expect(document.units.find((unit) => unit.symbol === "GatewayClient")?.range.startLine).toBe(5);
    expect(document.units.find((unit) => unit.symbol === "authorize")?.searchText).toContain(
      "Keep this comment searchable",
    );
    expect(document.units.find((unit) => unit.symbol === "settle")?.range.startLine).toBe(12);
  });

  test("TypeScript/JSX retains interfaces, components, functions, and classes", async () => {
    const source = await fixture("sample.tsx");
    for (const [filename, format] of [
      ["sample.tsx", "typescript"],
      ["sample.jsx", "javascript"],
    ] as const satisfies readonly (readonly [string, FileFormat])[]) {
      const document = extractText(filename, format, source);
      expect(document.metadata.symbols).toEqual([
        "GatewayProps",
        "GatewayButton",
        "retryPayment",
        "PaymentQueue",
      ]);
      expect(document.units.find((unit) => unit.symbol === "GatewayButton")?.searchText).toContain(
        '<button type="button">Pay {amount}</button>',
      );
    }
  });

  test("JavaScript structure checks ignore balanced delimiters inside comments and strings", () => {
    const document = extractText(
      "comments.ts",
      "typescript",
      '// a closing brace } in a comment\n/* and an opening { in a block */\nexport function safe() {\n  const quoted = "}";\n  return quoted; // ]\n}',
    );
    expect(document.metadata.symbols).toContain("safe");
    expect(document.warnings).not.toContainEqual(
      expect.objectContaining({ code: "MALFORMED_SYNTAX" }),
    );
  });

  test("structured formats retain readable key paths and values", async () => {
    const json = extractText("sample.json", "json", await fixture("sample.json"));
    expect(json.normalizedText).toContain("gateway.retries: 3");
    expect(json.normalizedText).toContain("gateway.regions[1]: eu-west");
    const yaml = extractText("sample.yaml", "yaml", await fixture("sample.yaml"));
    expect(yaml.normalizedText).toContain("gateway.retry.attempts: 3");
    expect(yaml.normalizedText).toContain("regions[]: us-east");
    const toml = extractText("sample.toml", "toml", await fixture("sample.toml"));
    expect(toml.normalizedText).toContain("gateway.retry.attempts: 3");
    const xml = extractText("sample.xml", "xml", await fixture("sample.xml"));
    expect(xml.normalizedText).toContain("attempts: 3");
    expect(xml.normalizedText).toContain("mode: safe");
  });

  test("shell, SQL, and styles use their logical declaration boundaries", async () => {
    const cases = [
      ["sample.sh", "shell", ["retry_payment", "authorize"]],
      ["sample.sql", "sql", ["payments", "approved_payments"]],
      ["sample.css", "stylesheet", [".gateway-button", "prefers-reduced-motion"]],
    ] as const;
    for (const [filename, format, symbols] of cases) {
      const document = extractText(filename, format, await fixture(filename));
      for (const symbol of symbols) {
        expect(document.metadata.symbols.some((item) => item.includes(symbol))).toBeTrue();
      }
      expect(document.units.every((unit) => unit.range.startLine <= unit.range.endLine)).toBeTrue();
    }
  });

  test("plain text preserves paragraphs and CSV retains header context", async () => {
    const text = extractText("sample.txt", "text", await fixture("sample.txt"));
    expect(text.units).toHaveLength(3);
    expect(text.units[1]?.displayText).toContain("no repository content leaves");
    const csv = extractText("sample.csv", "csv", await fixture("sample.csv"));
    expect(csv.units[0]?.kind).toBe("record");
    expect(csv.normalizedText).toContain("id,status,amount");
  });
});

describe("malformed and fallback fixtures", () => {
  test("malformed Python and TypeScript fall back without discarding content", () => {
    const python = extractText(
      "bad.py",
      "python",
      'def broken():\n    """never closes\n    return 1',
    );
    expect(python.normalizedText).toContain("return 1");
    expect(python.warnings).toContainEqual(expect.objectContaining({ code: "MALFORMED_SYNTAX" }));

    const typescript = extractText(
      "bad.ts",
      "typescript",
      "export function broken() {\n return 1;",
    );
    expect(typescript.normalizedText).toContain("broken");
    expect(typescript.warnings).toContainEqual(
      expect.objectContaining({ code: "MALFORMED_SYNTAX" }),
    );
  });

  test("malformed JSON and XML safely fall back to source lines", () => {
    const json = extractText("bad.json", "json", '{ "gateway": true,, }');
    expect(json.normalizedText).toContain("gateway");
    expect(json.warnings[0]?.code).toBe("MALFORMED_SYNTAX");
    const xml = extractText("bad.xml", "xml", "<gateway><broken></gateway>");
    expect(xml.normalizedText).toContain("broken");
    expect(xml.warnings[0]?.code).toBe("PARSER_FALLBACK");
  });

  test("JSONC retains comment-like string values and tolerates comments and trailing commas", () => {
    const document = extractText(
      "config.jsonc",
      "json",
      '{\n  "url": "https://localhost/a//b", // local endpoint\n  "note": "quoted \\" // text", /* block comment */\n  "enabled": true,\n}',
    );
    expect(document.normalizedText).toContain("url: https://localhost/a//b");
    expect(document.normalizedText).toContain('note: quoted " // text');
    expect(document.normalizedText).toContain("enabled: true");
    expect(document.warnings).toEqual([]);
  });

  test("unclosed Markdown structures remain searchable with actionable warnings", () => {
    const fence = extractText("broken.md", "markdown", "# Heading\n\n```ts\nconst value = 1;");
    expect(fence.normalizedText).toContain("const value = 1;");
    expect(fence.warnings).toContainEqual(expect.objectContaining({ code: "MALFORMED_SYNTAX" }));
    const frontmatter = extractText("frontmatter.md", "markdown", "---\ntitle: Still searchable");
    expect(frontmatter.normalizedText).toContain("Still searchable");
    expect(frontmatter.warnings).toContainEqual(
      expect.objectContaining({ code: "MALFORMED_SYNTAX", line: 1 }),
    );
  });

  test("empty files produce a valid empty document", () => {
    for (const format of ["markdown", "html", "python", "typescript", "json", "text"] as const) {
      const document = extractText(`empty.${format}`, format, "");
      expect(document.units).toEqual([]);
      expect(document.normalizedText).toBe("");
    }
  });

  test("HTML without recognized blocks uses visible-text fallback", () => {
    const document = extractText("fragment.html", "html", "<main>loose <b>visible</b> text</main>");
    expect(document.normalizedText).toBe("loose visible text");
  });

  test("HTML retains loose visible body text alongside recognized blocks", () => {
    const document = extractText(
      "loose.html",
      "html",
      "<html><body><h1>Heading</h1><div>Loose visible text</div><p>Paragraph</p></body></html>",
    );
    expect(document.normalizedText).toContain("Heading");
    expect(document.normalizedText).toContain("Loose visible text");
    expect(document.normalizedText).toContain("Paragraph");
  });

  test("unclosed active HTML content is omitted through end of file", () => {
    const document = extractText("broken.html", "html", "<h1>Visible</h1><script>secret()");
    expect(document.normalizedText).toContain("Visible");
    expect(document.normalizedText).not.toContain("secret");
  });

  test("malformed numeric HTML entities cannot expose omitted active content via fallback", () => {
    const document = extractText(
      "entity.html",
      "html",
      "<p>Invalid &#999999999; entity</p><script>secret()</script>",
    );
    expect(document.normalizedText).toContain("&#999999999;");
    expect(document.normalizedText).not.toContain("secret");
    expect(document.warnings.some((warning) => warning.code === "PARSER_FALLBACK")).toBeFalse();
  });
});
