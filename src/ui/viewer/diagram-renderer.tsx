import { useEffect, useId, useState } from "react";
import { sanitizeDiagramSvg } from "./sanitize.ts";

export function normalizeMermaidSource(source: string): string {
  // Mermaid's SVG text mode does not interpret the common `\n` label convention. A safe br tag is
  // converted by Mermaid into separate SVG tspans, without enabling foreignObject/HTML labels.
  return source.replaceAll("\\n", "<br/>");
}

export function MermaidDiagram({ source }: { readonly source: string }) {
  const reactId = useId();
  const [state, setState] = useState<
    | { readonly phase: "loading" }
    | { readonly phase: "ready"; readonly svg: string }
    | { readonly phase: "error" }
  >({ phase: "loading" });

  useEffect(() => {
    let active = true;
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          theme: "neutral",
        });
        const id = `kbiss-diagram-${reactId.replaceAll(":", "")}`;
        const rendered = await mermaid.render(id, normalizeMermaidSource(source));
        const svg = sanitizeDiagramSvg(rendered.svg);
        if (active) setState(svg ? { phase: "ready", svg } : { phase: "error" });
      })
      .catch(() => {
        if (active) setState({ phase: "error" });
      });
    return () => {
      active = false;
    };
  }, [reactId, source]);

  if (state.phase === "loading") return <p role="status">Rendering diagram locally…</p>;
  if (state.phase === "error") {
    return (
      <div className="diagram-fallback" role="note">
        <p>This Mermaid diagram could not be rendered. Its source is preserved below.</p>
        <pre>
          <code>{source}</code>
        </pre>
      </div>
    );
  }
  const imageSource = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(state.svg)}`;
  return (
    <figure className="mermaid-diagram" aria-label="Mermaid diagram">
      {/* Rendering as an image isolates Mermaid's sanitized SVG stylesheet from the page CSP. */}
      <img src={imageSource} alt="Rendered Mermaid diagram" />
      <figcaption>Mermaid diagram rendered locally</figcaption>
    </figure>
  );
}
