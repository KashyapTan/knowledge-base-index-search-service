import type { ExtractedUnit, ExtractionWarning, Extractor } from "../contracts.ts";
import { buildDocument, makeUnit } from "./shared.ts";

const OMITTED_ELEMENTS =
  /<(script|style|template|nav|aside)(?:\s[^>]*)?>[\s\S]*?(?:<\/\1\s*>|$)/giu;
const HEAD_ELEMENT = /<head(?:\s[^>]*)?>[\s\S]*?(?:<\/head\s*>|$)/giu;
const BLOCK_ELEMENTS = /<(h[1-6]|p|li|tr|blockquote|pre|code)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/giu;

function decodeEntities(text: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, value: string) => {
    if (value.startsWith("#")) {
      const codePoint = value.startsWith("#x")
        ? Number.parseInt(value.slice(2), 16)
        : Number.parseInt(value.slice(1), 10);
      if (
        !Number.isFinite(codePoint) ||
        codePoint < 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return entity;
      }
      return String.fromCodePoint(codePoint);
    }
    return named[value.toLowerCase()] ?? entity;
  });
}

function visibleText(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<(br|hr)\s*\/?\s*>/giu, "\n")
      .replace(/<[^>]*>/gu, " ")
      .replace(/[ \t]+/gu, " ")
      .replace(/\s*\n\s*/gu, "\n"),
  ).trim();
}

export const htmlExtractor: Extractor = {
  name: "html-visible-content",
  formats: ["html"],
  extract(context) {
    const text = context.source.text;
    const omitted: Array<{ start: number; end: number }> = [];
    for (const match of text.matchAll(OMITTED_ELEMENTS)) {
      omitted.push({ start: match.index, end: match.index + match[0].length });
    }
    const hidden = [...omitted];
    for (const match of text.matchAll(HEAD_ELEMENT)) {
      hidden.push({ start: match.index, end: match.index + match[0].length });
    }
    const isOmitted = (start: number, end: number) =>
      hidden.some((range) => start < range.end && end > range.start);
    const warnings: ExtractionWarning[] =
      omitted.length === 0
        ? []
        : [{ code: "CONTENT_OMITTED", message: "Non-content HTML elements were omitted." }];

    const titleMatch = text.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/iu);
    const title = titleMatch ? visibleText(titleMatch[1] ?? "") : undefined;
    const metaMatch = text.match(
      /<meta\s+(?=[^>]*name\s*=\s*["']description["'])(?=[^>]*content\s*=\s*["']([^"']*)["'])[^>]*>/iu,
    );
    const description = metaMatch?.[1] ? decodeEntities(metaMatch[1]).trim() : undefined;
    const units: ExtractedUnit[] = [];
    const claimed = [...hidden];
    const headingTrail: string[] = [];
    const headings: string[] = [];

    if (titleMatch?.index !== undefined && title) {
      const unit = makeUnit(context, {
        kind: "heading",
        start: titleMatch.index,
        end: titleMatch.index + titleMatch[0].length,
        displayText: title,
        searchText: title,
        headingTrail: [title],
      });
      if (unit) units.push(unit);
    }

    for (const match of text.matchAll(BLOCK_ELEMENTS)) {
      const start = match.index;
      const end = start + match[0].length;
      if (isOmitted(start, end)) continue;
      claimed.push({ start, end });
      const tag = match[1]?.toLowerCase() ?? "p";
      const content = visibleText(match[2] ?? "");
      if (!content) continue;
      if (/^h[1-6]$/u.test(tag)) {
        const level = Number(tag.slice(1));
        headingTrail.length = level - 1;
        headingTrail[level - 1] = content;
        headings.push(content);
      }
      const unit = makeUnit(context, {
        kind: tag.startsWith("h")
          ? "heading"
          : tag === "li"
            ? "list"
            : tag === "tr"
              ? "table"
              : tag === "blockquote"
                ? "quote"
                : tag === "pre" || tag === "code"
                  ? "code"
                  : "paragraph",
        start,
        end,
        displayText: content,
        searchText: content,
        headingTrail: [...headingTrail],
      });
      if (unit) units.push(unit);
    }

    const headingTrailAt = (offset: number): readonly string[] =>
      units.filter((unit) => unit.kind === "heading" && unit.range.startOffset < offset).at(-1)
        ?.headingTrail ?? [];

    let cursor = 0;
    for (const range of claimed.sort((left, right) => left.start - right.start)) {
      if (range.start > cursor) {
        const content = visibleText(text.slice(cursor, range.start));
        const unit = makeUnit(context, {
          kind: "text",
          start: cursor,
          end: range.start,
          displayText: content,
          searchText: content,
          headingTrail: headingTrailAt(cursor),
        });
        if (unit) units.push(unit);
      }
      cursor = Math.max(cursor, range.end);
    }
    if (cursor < text.length) {
      const content = visibleText(text.slice(cursor));
      const unit = makeUnit(context, {
        kind: "text",
        start: cursor,
        end: text.length,
        displayText: content,
        searchText: content,
        headingTrail: headingTrailAt(cursor),
      });
      if (unit) units.push(unit);
    }

    if (units.length === 0) {
      const cleaned = visibleText(text.replace(OMITTED_ELEMENTS, ""));
      const unit = makeUnit(context, {
        kind: "text",
        start: 0,
        end: text.length,
        displayText: cleaned,
        searchText: cleaned,
      });
      if (unit) units.push(unit);
    }

    units.sort((left, right) => left.range.startOffset - right.range.startOffset);

    return buildDocument(
      context,
      units,
      {
        language: "html",
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        headings,
        symbols: [],
      },
      warnings,
    );
  },
};
