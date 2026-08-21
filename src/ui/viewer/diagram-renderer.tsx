import { useEffect, useId, useState } from "react";
import { sanitizeDiagramSvg } from "./sanitize.ts";

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
        const rendered = await mermaid.render(id, source);
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
  return (
    <figure className="mermaid-diagram" aria-label="Mermaid diagram">
      {/* Mermaid is configured for strict SVG output, then the SVG is independently sanitized. */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: sanitizeDiagramSvg removes active elements, handlers, foreign content, and external links before insertion. */}
      <div dangerouslySetInnerHTML={{ __html: state.svg }} />
      <figcaption>Mermaid diagram rendered locally</figcaption>
    </figure>
  );
}
