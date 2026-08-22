import hljs from "highlight.js/lib/common";
import {
  Children,
  cloneElement,
  isValidElement,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
} from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { type GrepOptions, runGrep } from "./grep.ts";
import { classifyLink, SAFE_EXTERNAL_LINK_PROPS } from "./link-policy.ts";

/* c8 ignore start -- The Mermaid browser-only lazy boundary is exercised in the Playwright CSP/XSS test. */
const LazyMermaidDiagram = lazy(async () => {
  const module = await import("./diagram-renderer.tsx");
  return { default: module.MermaidDiagram };
});
/* c8 ignore stop */

const DIAGRAM_FENCES = new Set([
  "d2",
  "dot",
  "graphviz",
  "mermaid",
  "plantuml",
  "puml",
  "vega",
  "vega-lite",
]);

const markdownSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-[\w-]+$/u]],
  },
};

function nodeLine(node: ExtraProps["node"]): number | undefined {
  return node?.position?.start.line;
}

function highlightedString(value: string, grep: GrepOptions): ReactNode {
  if (!grep.query || grep.regex) return value;
  const result = runGrep(value, { ...grep, maximumMatches: 2_000 });
  if (result.matches.length === 0) return value;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of result.matches) {
    if (match.start < cursor) continue;
    if (match.start > cursor) parts.push(value.slice(cursor, match.start));
    parts.push(
      <mark key={`${match.start}:${match.end}`}>{value.slice(match.start, match.end)}</mark>,
    );
    cursor = match.end;
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts;
}

function HighlightedChildren({
  children,
  grep,
}: {
  readonly children: ReactNode;
  readonly grep: GrepOptions;
}) {
  // Avoid walking and cloning the Markdown tree when highlighting is inactive. Besides being much
  // cheaper for documentation-sized files, this keeps ordinary preview rendering independent of
  // the shape and nesting depth of the parsed Markdown.
  if (!grep.query || grep.regex) return children;
  return Children.map(children, (child) => {
    if (typeof child === "string") return highlightedString(child, grep);
    if (
      !isValidElement<{ readonly children?: ReactNode }>(child) ||
      child.props.children === undefined
    ) {
      return child;
    }
    // A custom ReactMarkdown component (notably a nested list item) may receive a subtree that this
    // component already wrapped. Re-wrapping that marker recursively creates HighlightedChildren
    // inside itself until Firefox exhausts the stack and stops processing Close/Escape events.
    if (child.type === HighlightedChildren) return child;
    return cloneElement(
      child,
      undefined,
      <HighlightedChildren grep={grep}>{child.props.children}</HighlightedChildren>,
    );
  });
}

function textFromChildren(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : ""))
    .join("");
}

function anchorId(children: ReactNode): string {
  return textFromChildren(children)
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/[\s-]+/gu, "-");
}

function fencedLanguage(className: string | undefined): string | undefined {
  return /(?:^|\s)language-([\w-]+)/u.exec(className ?? "")?.[1]?.toLocaleLowerCase();
}

function BlockCode({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const source = String(children).replace(/\n$/u, "");
  const language = fencedLanguage(className);
  /* c8 ignore start -- Mermaid rendering requires real SVG layout and is covered in Chromium. */
  if (language === "mermaid") {
    return (
      <Suspense fallback={<p role="status">Loading the local diagram renderer…</p>}>
        <LazyMermaidDiagram source={source} />
      </Suspense>
    );
  }
  /* c8 ignore stop */
  const highlighted =
    language && hljs.getLanguage(language) ? hljs.highlight(source, { language }).value : undefined;
  return (
    <div
      className="markdown-code-block"
      data-diagram-source={language && DIAGRAM_FENCES.has(language) ? language : undefined}
    >
      {language && DIAGRAM_FENCES.has(language) ? (
        <p className="diagram-source-label">
          {language} diagram source · local renderer unavailable
        </p>
      ) : null}
      <pre>
        <code
          className={className}
          {...(highlighted
            ? { dangerouslySetInnerHTML: { __html: highlighted } }
            : { children: source })}
        />
      </pre>
    </div>
  );
}

function markdownComponents(grep: GrepOptions): Components {
  const heading =
    (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
    ({ node, children, ...props }: React.ComponentPropsWithoutRef<typeof Tag> & ExtraProps) => (
      <Tag {...props} id={anchorId(children)} data-source-line={nodeLine(node)}>
        <HighlightedChildren grep={grep}>{children}</HighlightedChildren>
      </Tag>
    );
  return {
    h1: heading("h1"),
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
    h5: heading("h5"),
    h6: heading("h6"),
    p: ({ node, children, ...props }) => (
      <p {...props} data-source-line={nodeLine(node)}>
        <HighlightedChildren grep={grep}>{children}</HighlightedChildren>
      </p>
    ),
    li: ({ node, children, ...props }) => (
      <li {...props} data-source-line={nodeLine(node)}>
        <HighlightedChildren grep={grep}>{children}</HighlightedChildren>
      </li>
    ),
    td: ({ node: _node, children, ...props }) => (
      <td {...props}>
        <HighlightedChildren grep={grep}>{children}</HighlightedChildren>
      </td>
    ),
    th: ({ node: _node, children, ...props }) => (
      <th {...props}>
        <HighlightedChildren grep={grep}>{children}</HighlightedChildren>
      </th>
    ),
    a: ({ node: _node, href, children, ...props }) => {
      const link = classifyLink(href);
      if (link.kind === "blocked")
        return (
          <span className="blocked-link" title="Blocked unsafe or local link">
            {children}
          </span>
        );
      if (link.kind === "fragment")
        return (
          <a {...props} href={link.href}>
            {children}
          </a>
        );
      return (
        <a {...props} href={link.href} {...SAFE_EXTERNAL_LINK_PROPS}>
          {children}
        </a>
      );
    },
    img: ({ alt }) => (
      <span className="blocked-image" role="note">
        [Image blocked{alt ? `: ${alt}` : ""}]
      </span>
    ),
    input: () => null,
    code: ({ children, className }) => <code className={className}>{children}</code>,
    pre: ({ children }) => {
      const child = Children.toArray(children)[0];
      /* c8 ignore next 2 -- ReactMarkdown pre nodes always contain the code element; this is defensive. */
      if (!isValidElement<{ readonly className?: string; readonly children?: ReactNode }>(child)) {
        return <pre>{children}</pre>;
      }
      return (
        <BlockCode {...(child.props.className ? { className: child.props.className } : {})}>
          {child.props.children}
        </BlockCode>
      );
    },
  };
}

export function MarkdownPreview({
  content,
  grep,
  targetLine,
}: {
  readonly content: string;
  readonly grep: GrepOptions;
  readonly targetLine?: number;
}) {
  const components = markdownComponents(grep);
  const preview = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!targetLine || !preview.current) return;
    const candidates = [...preview.current.querySelectorAll<HTMLElement>("[data-source-line]")];
    const target = candidates.reduce<HTMLElement | undefined>((best, candidate) => {
      const line = Number(candidate.dataset.sourceLine);
      return line <= targetLine && (!best || line > Number(best.dataset.sourceLine))
        ? candidate
        : best;
    }, undefined);
    target?.scrollIntoView({ block: "center" });
    target?.classList.add("preview-target");
    const timer = window.setTimeout(() => target?.classList.remove("preview-target"), 2_500);
    return () => window.clearTimeout(timer);
  }, [targetLine]);
  return (
    <article ref={preview} className="markdown-preview" data-target-line={targetLine}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSchema]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}
