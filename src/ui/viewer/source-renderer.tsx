import hljs from "highlight.js/lib/common";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GrepMatch } from "./grep.ts";

const LINE_HEIGHT = 24;
const OVERSCAN = 30;

interface SourceLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function sourceLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index <= content.length; index += 1) {
    if (index === content.length || content.charCodeAt(index) === 10) {
      const end = index > start && content.charCodeAt(index - 1) === 13 ? index - 1 : index;
      lines.push({ text: content.slice(start, end), start, end });
      start = index + 1;
    }
  }
  return lines;
}

function LineContent({
  line,
  matches,
  activeMatch,
  language,
}: {
  readonly line: SourceLine;
  readonly matches: readonly GrepMatch[];
  readonly activeMatch: number;
  readonly language?: string;
}) {
  const lineMatches = matches
    .map((match, index) => ({ match, index }))
    .filter(({ match }) => match.start <= line.end && match.end >= line.start);
  if (lineMatches.length === 0) {
    if (language && hljs.getLanguage(language)) {
      const highlighted = hljs.highlight(line.text || " ", { language }).value;
      // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js escapes repository text and emits only local span markup.
      return <span dangerouslySetInnerHTML={{ __html: highlighted }} />;
    }
    return <>{line.text || " "}</>;
  }
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const { match, index } of lineMatches) {
    const start = Math.max(cursor, match.start - line.start);
    const end = Math.max(start, Math.min(line.text.length, match.end - line.start));
    if (start > cursor) parts.push(line.text.slice(cursor, start));
    parts.push(
      <mark
        key={`${match.start}:${match.end}:${index}`}
        className={index === activeMatch ? "active-match" : undefined}
        data-match-index={index}
      >
        {end === start ? "\u200b" : line.text.slice(start, end)}
      </mark>,
    );
    cursor = Math.max(cursor, end);
  }
  if (cursor < line.text.length) parts.push(line.text.slice(cursor));
  return <>{parts}</>;
}

export function SourceRenderer({
  content,
  language,
  matches,
  activeMatch,
  targetLine,
}: {
  readonly content: string;
  readonly language?: string;
  readonly matches: readonly GrepMatch[];
  readonly activeMatch: number;
  readonly targetLine?: number;
}) {
  const lines = useMemo(() => sourceLines(content), [content]);
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const activeLine = activeMatch >= 0 ? matches[activeMatch]?.line : undefined;
  const requestedLine = activeLine ?? targetLine;
  const scrollLine = requestedLine ? Math.min(requestedLine, lines.length) : undefined;

  useEffect(() => {
    if (!scrollLine || !scroller.current) return;
    scroller.current.scrollTop = Math.max(0, (scrollLine - 1) * LINE_HEIGHT - LINE_HEIGHT * 4);
    setViewport((current) => ({ ...current, top: scroller.current?.scrollTop ?? current.top }));
  }, [scrollLine]);

  const first = Math.max(0, Math.floor(viewport.top / LINE_HEIGHT) - OVERSCAN);
  const count = Math.ceil(viewport.height / LINE_HEIGHT) + OVERSCAN * 2;
  const last = Math.min(lines.length, first + count);
  return (
    <section
      ref={scroller}
      className="source-scroller"
      data-testid="source-scroller"
      aria-label="File source"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a focusable scroll region supports keyboard scrolling through long source files.
      tabIndex={0}
      onScroll={(event) =>
        setViewport({
          top: event.currentTarget.scrollTop,
          height: event.currentTarget.clientHeight,
        })
      }
    >
      <div className="source-spacer" style={{ height: lines.length * LINE_HEIGHT }}>
        <ol className="source-lines" start={first + 1} style={{ top: first * LINE_HEIGHT }}>
          {lines.slice(first, last).map((line, index) => {
            const number = first + index + 1;
            return (
              <li
                key={`${number}:${line.start}`}
                data-line={number}
                className={`source-line${number === targetLine ? " target-line" : ""}`}
              >
                <code>
                  <LineContent
                    line={line}
                    matches={matches}
                    activeMatch={activeMatch}
                    {...(language ? { language } : {})}
                  />
                </code>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
