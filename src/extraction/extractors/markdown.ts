import type { ExtractedUnit, ExtractionWarning, Extractor } from "../contracts.ts";
import { buildDocument, cleanMarkdownMarkers, lineSpan, makeUnit } from "./shared.ts";

function classifyLine(line: string): "heading" | "fence" | "list" | "table" | "quote" | "text" {
  if (/^\s{0,3}#{1,6}\s+/u.test(line)) return "heading";
  if (/^\s*(```|~~~)/u.test(line)) return "fence";
  if (/^\s*(?:[-+*]|\d+[.)])\s+/u.test(line)) return "list";
  if (/^\s*\|.*\|\s*$/u.test(line)) return "table";
  if (/^\s*>/u.test(line)) return "quote";
  return "text";
}

export const markdownExtractor: Extractor = {
  name: "markdown-mdx",
  formats: ["markdown"],
  extract(context) {
    const lines = context.source.lines;
    const units: ExtractedUnit[] = [];
    const headingTrail: string[] = [];
    const headings: string[] = [];
    const warnings: ExtractionWarning[] = [];
    let index = 0;

    if (lines[0]?.text.trim() === "---") {
      let close = 1;
      while (close < lines.length && lines[close]?.text.trim() !== "---") close += 1;
      if (close < lines.length) {
        const meaningful = lines
          .slice(1, close)
          .map((line) => line.text.match(/^\s*([^:#]+):\s*(.+)$/u))
          .filter((match): match is RegExpMatchArray => match !== null)
          .map((match) => `${match[1]?.trim()}: ${match[2]?.trim()}`)
          .join("\n");
        if (meaningful) {
          const span = lineSpan(context, 0, close);
          const unit = makeUnit(context, {
            kind: "record",
            ...span,
            displayText: meaningful,
            searchText: meaningful,
          });
          if (unit) units.push(unit);
        }
        index = close + 1;
      } else {
        warnings.push({
          code: "MALFORMED_SYNTAX",
          message: "Unclosed Markdown frontmatter was treated as ordinary text.",
          line: 1,
        });
      }
    }

    while (index < lines.length) {
      const line = lines[index];
      if (!line || line.text.trim() === "") {
        index += 1;
        continue;
      }
      const kind = classifyLine(line.text);
      if (kind === "heading") {
        const match = line.text.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
        const level = match?.[1]?.length ?? 1;
        const title = cleanMarkdownMarkers(match?.[2] ?? line.text);
        headingTrail.length = level - 1;
        headingTrail[level - 1] = title;
        headings.push(title);
        const unit = makeUnit(context, {
          kind: "heading",
          start: line.start,
          end: line.end,
          searchText: title,
          headingTrail: [...headingTrail],
        });
        if (unit) units.push(unit);
        index += 1;
        continue;
      }

      let end = index;
      if (kind === "fence") {
        const marker = line.text.trimStart().slice(0, 3);
        let closed = false;
        while (end + 1 < lines.length) {
          end += 1;
          if (lines[end]?.text.trimStart().startsWith(marker)) {
            closed = true;
            break;
          }
        }
        if (!closed) {
          warnings.push({
            code: "MALFORMED_SYNTAX",
            message: "Unclosed Markdown code fence was extracted through end of file.",
            line: line.number,
          });
        }
      } else {
        while (end + 1 < lines.length) {
          const next = lines[end + 1];
          if (!next || next.text.trim() === "" || classifyLine(next.text) !== kind) break;
          end += 1;
        }
      }
      const span = lineSpan(context, index, end);
      const raw = context.source.text.slice(span.start, span.end);
      const searchText =
        kind === "fence"
          ? raw.replace(/^\s*(```|~~~)[^\n]*\n?/u, "").replace(/\n?\s*(```|~~~)\s*$/u, "")
          : cleanMarkdownMarkers(raw);
      const unit = makeUnit(context, {
        kind: kind === "fence" ? "code" : kind === "text" ? "paragraph" : kind,
        ...span,
        searchText,
        headingTrail: [...headingTrail],
      });
      if (unit) units.push(unit);
      index = end + 1;
    }

    return buildDocument(
      context,
      units,
      {
        language: context.file.extension === ".mdx" ? "mdx" : "markdown",
        ...(headings[0] === undefined ? {} : { title: headings[0] }),
        headings,
        symbols: [],
      },
      warnings,
    );
  },
};
