import type {
  DocumentMetadata,
  ExtractedDocument,
  ExtractedUnit,
  ExtractedUnitKind,
  ExtractorContext,
} from "../contracts.ts";

export interface UnitOptions {
  readonly kind: ExtractedUnitKind;
  readonly start: number;
  readonly end: number;
  readonly displayText?: string;
  readonly searchText?: string;
  readonly headingTrail?: readonly string[];
  readonly symbol?: string;
}

export function makeUnit(
  context: ExtractorContext,
  options: UnitOptions,
): ExtractedUnit | undefined {
  const displayText = (
    options.displayText ?? context.source.text.slice(options.start, options.end)
  ).trim();
  const searchText = (options.searchText ?? displayText).trim();
  if (!searchText) return undefined;
  const leading = (
    options.displayText ?? context.source.text.slice(options.start, options.end)
  ).search(/\S/u);
  const adjustedStart =
    options.displayText === undefined && leading >= 0 ? options.start + leading : options.start;
  let adjustedEnd = options.end;
  if (options.displayText === undefined) {
    const sourceText = context.source.text.slice(adjustedStart, options.end);
    adjustedEnd = adjustedStart + sourceText.trimEnd().length;
  }
  return {
    kind: options.kind,
    displayText,
    searchText,
    range: context.source.range(adjustedStart, adjustedEnd),
    headingTrail: options.headingTrail ?? [],
    ...(options.symbol === undefined ? {} : { symbol: options.symbol }),
  };
}

export function lineSpan(
  context: ExtractorContext,
  startLineIndex: number,
  endLineIndex: number,
): { readonly start: number; readonly end: number } {
  const startLine = context.source.lines[startLineIndex];
  const endLine = context.source.lines[endLineIndex];
  return {
    start: startLine?.start ?? 0,
    end: endLine?.end ?? context.source.text.length,
  };
}

export function buildDocument(
  context: ExtractorContext,
  units: readonly ExtractedUnit[],
  metadata: Omit<DocumentMetadata, "format"> & { readonly format?: DocumentMetadata["format"] },
  extraWarnings: ExtractedDocument["warnings"] = [],
): ExtractedDocument {
  const headings =
    metadata.headings.length > 0
      ? metadata.headings
      : [...new Set(units.flatMap((unit) => unit.headingTrail))];
  const symbols =
    metadata.symbols.length > 0
      ? metadata.symbols
      : [...new Set(units.flatMap((unit) => (unit.symbol ? [unit.symbol] : [])))];
  return {
    fileId: context.file.fileId,
    relativePath: context.file.relativePath,
    normalizedText: units.map((unit) => unit.searchText).join("\n\n"),
    metadata: {
      ...metadata,
      format: metadata.format ?? context.file.format,
      headings,
      symbols,
    },
    units,
    warnings: [...context.source.warnings, ...extraWarnings],
    extractorVersion: context.extractorVersion,
  };
}

export function cleanMarkdownMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/u, "")
        .replace(/^\s*>\s?/u, "")
        .replace(/^\s*(?:[-+*]|\d+[.)])\s+/u, "")
        .replace(/\[(.+?)\]\([^)]*\)/gu, "$1")
        .replace(/[*_~`]([\s\S]*?)[*_~`]/gu, "$1"),
    )
    .join("\n")
    .trim();
}

export function fallbackLineUnits(
  context: ExtractorContext,
  options: { readonly kind?: ExtractedUnitKind; readonly linesPerUnit?: number } = {},
): ExtractedUnit[] {
  const units: ExtractedUnit[] = [];
  const linesPerUnit = Math.max(1, options.linesPerUnit ?? 40);
  let index = 0;
  while (index < context.source.lines.length) {
    while (context.source.lines[index]?.text.trim() === "") index += 1;
    if (index >= context.source.lines.length) break;
    let end = index;
    while (
      end + 1 < context.source.lines.length &&
      end - index + 1 < linesPerUnit &&
      context.source.lines[end + 1]?.text.trim() !== ""
    ) {
      end += 1;
    }
    const span = lineSpan(context, index, end);
    const unit = makeUnit(context, { kind: options.kind ?? "text", ...span });
    if (unit) units.push(unit);
    index = end + 1;
  }
  return units;
}
