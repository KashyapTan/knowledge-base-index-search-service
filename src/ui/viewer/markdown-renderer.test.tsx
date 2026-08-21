import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
const { cleanup, render, within } = await import("@testing-library/react");
const { MarkdownPreview } = await import("./markdown-renderer.tsx");

afterEach(cleanup);
afterAll(async () => GlobalRegistrator.unregister());

describe("sanitized GFM renderer", () => {
  test("renders structural GFM, source anchors, local highlighting, diagrams, and safe links", () => {
    const content = `# H1 safe
## H2
### H3
#### H4
##### H5
###### H6

Paragraph with **nested safe text**, \`inline\`, [external](https://example.com/a), [fragment](#h2), [unsafe](javascript:alert(1)), and ![remote](https://bad.invalid/pixel).

- safe list

| Name | Value |
| --- | --- |
| safe | yes |

\`\`\`javascript
const safe = "<script>";
\`\`\`

\`\`\`plantuml
Alice -> Bob
\`\`\`

\`\`\`
plain safe code
\`\`\`

<script>window.pwned = true</script>
<form><input autofocus></form>
`;
    const { container } = render(
      <MarkdownPreview
        content={content}
        grep={{ query: "safe", regex: false, caseSensitive: false }}
        targetLine={8}
      />,
    );
    const view = within(container);
    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(container.querySelector(`h${level}`)).toBeTruthy();
    }
    expect(container.querySelector("h1")?.id).toBe("h1-safe");
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelector("li")?.dataset.sourceLine).toBeTruthy();
    expect(container.querySelectorAll("mark").length).toBeGreaterThan(3);
    expect(container.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(view.getByText(/plantuml diagram source/)).toBeTruthy();
    expect(view.getByText("plain safe code")).toBeTruthy();

    const external = view.getByRole("link", { name: "external" });
    expect(external.getAttribute("target")).toBe("_blank");
    expect(external.getAttribute("rel")).toBe("noopener noreferrer");
    expect(view.getByRole("link", { name: "fragment" }).getAttribute("href")).toBe("#h2");
    expect(view.getByTitle("Blocked unsafe or local link").closest("a")).toBeNull();
    expect(view.getByRole("note").textContent).toContain("Image blocked: remote");
    expect(container.querySelector("script, form, input, img")).toBeNull();
    expect(container.querySelector(".preview-target")).toBeTruthy();
  });

  test("does not approximate rendered highlighting for regex mode or absent terms", () => {
    const { container, rerender } = render(
      <MarkdownPreview
        content="Paragraph with **nested** content."
        grep={{ query: "nested", regex: true, caseSensitive: false }}
      />,
    );
    expect(container.querySelector("mark")).toBeNull();
    rerender(
      <MarkdownPreview
        content="Paragraph with **nested** content."
        grep={{ query: "missing", regex: false, caseSensitive: false }}
      />,
    );
    expect(container.querySelector("mark")).toBeNull();
  });
});
