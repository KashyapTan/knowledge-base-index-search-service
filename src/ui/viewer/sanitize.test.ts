import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });

const { htmlPreviewDocument, safeExternalPreviewLinks, sanitizeDiagramSvg, sanitizeHtmlFragment } =
  await import("./sanitize.ts");

afterAll(async () => GlobalRegistrator.unregister());

describe("viewer sanitization", () => {
  test("removes executable HTML, forms, frames, handlers, styles, and resource loads", () => {
    const safe = sanitizeHtmlFragment(`
      <script>parent.stolen = true</script><style>@import url(https://bad)</style>
      <form action="https://bad"><input autofocus></form>
      <iframe srcdoc="<script>alert(1)</script>"></iframe>
      <img src="https://bad/pixel" srcset="https://bad/2x 2x" onerror="alert(1)">
      <div style="background:url(https://bad)" onclick="alert(1)">safe text</div>
      <a href="javascript:alert(1)">bad</a><a href="file:///tmp/a">file</a>
      <a href="https://example.com/path">good</a><a href="#part">part</a>
    `);
    for (const blocked of [
      "script",
      "style",
      "form",
      "input",
      "iframe",
      "src=",
      "srcset",
      "onerror",
      "onclick",
      "javascript:",
      "file:",
    ]) {
      expect(safe.toLocaleLowerCase()).not.toContain(blocked);
    }
    expect(safe).toContain("safe text");
    expect(safe).toContain('href="https://example.com/path"');
    expect(safe).toContain('target="_blank"');
    expect(safe).toContain('rel="noopener noreferrer"');
    expect(safe).toContain('href="#part"');
  });

  test("wraps previews in a restrictive CSP with an inert sandbox-compatible document", () => {
    const document = htmlPreviewDocument("<h1>Guide</h1><video src='https://bad'></video>");
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("script-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("img-src 'none'");
    expect(document).not.toContain("https://bad");
  });

  test("extracts only deduplicated safe external links for parent-controlled opening", () => {
    expect(
      safeExternalPreviewLinks(
        `<a href="https://example.com/a">  Safe   guide </a><a href="https://example.com/a">duplicate</a><a href="javascript:alert(1)">bad</a><a href="#local">fragment</a>`,
      ),
    ).toEqual([{ href: "https://example.com/a", label: "Safe guide" }]);
  });

  test("rejects malformed SVG and strips active or externally linked diagram content", () => {
    expect(sanitizeDiagramSvg("not svg")).toBe("");
    const safe = sanitizeDiagramSvg(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(1)</script><foreignObject><div>bad</div></foreignObject>
      <style>.safe { fill: #4f46e5; } .bad { fill: url(https://bad.invalid/fill); }</style>
      <a href="javascript:alert(1)"><text>bad</text></a>
      <path marker-end="url(#arrow)" style="fill:url(https://bad.invalid/fill)" />
    </svg>`);
    expect(safe).not.toContain("script");
    expect(safe).not.toContain("foreignObject");
    expect(safe).not.toContain("onload");
    expect(safe).not.toContain("javascript:");
    expect(safe).not.toContain("https://bad.invalid");

    const styled = sanitizeDiagramSvg(`<svg xmlns="http://www.w3.org/2000/svg">
      <style>.node { fill: #4f46e5; } .edge { marker-end: url(#arrow); }</style>
      <rect class="node" width="10" height="10" />
    </svg>`);
    expect(styled).toContain("fill: #4f46e5");
    expect(styled).toContain("url(#arrow)");

    const cylinder = sanitizeDiagramSvg(`<svg xmlns="http://www.w3.org/2000/svg">
      <g class="node" id="database">
        <path class="basic label-container" d="M0,15.8 a107.2,15.8 0,0,0 214.4,0 l0,66" />
        <g class="label" transform="translate(-99.7, -8.8)">
          <text><tspan class="text-outer-tspan">SQLite</tspan><tspan class="text-outer-tspan">Messages</tspan></text>
        </g>
      </g>
    </svg>`);
    expect(cylinder).toContain('transform="translate(0, -8.8)"');
    expect(cylinder).toContain('text-anchor="middle"');
  });
});
