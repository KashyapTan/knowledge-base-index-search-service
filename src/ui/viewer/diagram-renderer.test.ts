import { describe, expect, test } from "bun:test";
import { normalizeMermaidSource } from "./diagram-renderer.tsx";

describe("Mermaid diagram source normalization", () => {
  test("converts escaped label line breaks to SVG-compatible breaks", () => {
    expect(normalizeMermaidSource('Node["First line\\nSecond line"]')).toBe(
      'Node["First line<br/>Second line"]',
    );
  });

  test("leaves ordinary Mermaid source unchanged", () => {
    expect(normalizeMermaidSource("flowchart LR\n  Search --> Viewer")).toBe(
      "flowchart LR\n  Search --> Viewer",
    );
  });
});
