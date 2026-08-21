import type { ReactNode } from "react";

interface HighlightRange {
  readonly start: number;
  readonly end: number;
}

export function highlightRanges(text: string, terms: readonly string[]): readonly HighlightRange[] {
  const lowerText = text.toLocaleLowerCase();
  const candidates: HighlightRange[] = [];
  for (const term of new Set(terms.filter((value) => value.length > 0))) {
    const lowerTerm = term.toLocaleLowerCase();
    let from = 0;
    while (from < lowerText.length) {
      const start = lowerText.indexOf(lowerTerm, from);
      if (start < 0) break;
      candidates.push({ start, end: start + term.length });
      from = start + Math.max(1, term.length);
    }
  }
  candidates.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: HighlightRange[] = [];
  for (const candidate of candidates) {
    const previous = merged.at(-1);
    if (previous && candidate.start <= previous.end) {
      if (candidate.end > previous.end) {
        merged[merged.length - 1] = { start: previous.start, end: candidate.end };
      }
    } else {
      merged.push(candidate);
    }
  }
  return merged;
}

export function HighlightedText({
  text,
  terms,
}: {
  readonly text: string;
  readonly terms: readonly string[];
}): ReactNode {
  const ranges = highlightRanges(text, terms);
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const range of ranges) {
    if (range.start > offset) parts.push(text.slice(offset, range.start));
    parts.push(
      <mark key={`${range.start}-${range.end}`}>{text.slice(range.start, range.end)}</mark>,
    );
    offset = range.end;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return parts;
}
