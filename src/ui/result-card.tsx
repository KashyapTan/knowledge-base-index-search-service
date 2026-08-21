import { useId, useState } from "react";
import type { SearchExcerpt, SearchFileResult } from "../search/index.ts";
import { HighlightedText } from "./highlight.tsx";

function excerptContext(excerpt: SearchExcerpt): string {
  const sections = [...excerpt.headingTrail, ...excerpt.symbols];
  return sections.length > 0 ? sections.join(" › ") : "Matched content";
}

function lineLabel(excerpt: SearchExcerpt): string {
  return excerpt.startLine === excerpt.endLine
    ? `Line ${excerpt.startLine}`
    : `Lines ${excerpt.startLine}–${excerpt.endLine}`;
}

function Excerpt({ excerpt }: { readonly excerpt: SearchExcerpt }) {
  return (
    <section className="excerpt" aria-label={`${excerptContext(excerpt)}, ${lineLabel(excerpt)}`}>
      <div className="excerpt-meta">
        <span>{excerptContext(excerpt)}</span>
        <span>{lineLabel(excerpt)}</span>
      </div>
      <p className="excerpt-text">
        <HighlightedText text={excerpt.text} terms={excerpt.highlightTerms} />
      </p>
    </section>
  );
}

export function ResultCard({
  result,
  index,
  onOpen,
}: {
  readonly result: SearchFileResult;
  readonly index: number;
  readonly onOpen: (result: SearchFileResult, excerpt?: SearchExcerpt) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const additionalId = useId();
  const [best, ...additional] = result.excerpts;
  return (
    <article className="result-card" aria-labelledby={`${additionalId}-title`}>
      <header className="result-header">
        <div className="result-name-group">
          <h3 id={`${additionalId}-title`}>{result.filename}</h3>
          <p className="result-path" title={result.relativePath}>
            {result.relativePath}
          </p>
        </div>
        <span className="format-badge">{result.format}</span>
      </header>
      {best ? (
        <Excerpt excerpt={best} />
      ) : (
        <p className="excerpt-empty">No excerpt is available.</p>
      )}
      {additional.length > 0 ? (
        <div className="additional-excerpts">
          <button
            type="button"
            className="quiet-button"
            aria-expanded={expanded}
            aria-controls={additionalId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Hide" : "Show"} {additional.length} more matched{" "}
            {additional.length === 1 ? "section" : "sections"}
          </button>
          <div id={additionalId} hidden={!expanded}>
            {additional.map((excerpt) => (
              <Excerpt key={excerpt.chunkId} excerpt={excerpt} />
            ))}
          </div>
        </div>
      ) : null}
      <footer className="result-footer">
        <span className="match-summary">
          Matched by {result.matchSources.join(" + ") || "local index"}
        </span>
        <button
          type="button"
          className="open-file-button"
          data-result-index={index}
          onClick={() => onOpen(result, best)}
        >
          Open full file
        </button>
      </footer>
    </article>
  );
}
