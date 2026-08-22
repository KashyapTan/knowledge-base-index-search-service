import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  ChunkingOptions,
  ExtractedDocument,
  ExtractedUnit,
  SearchChunk,
  SourceRange,
} from "./contracts.ts";

interface Fragment extends SourceRange {
  readonly displayText: string;
  readonly searchText: string;
  readonly headingTrail: readonly string[];
  readonly symbols: readonly string[];
}

/** Bounded per-document fallback for tokenizers without verified offset mapping. */
function cachedTokenCount(
  count: (value: string) => number,
  capacity = 4_096,
): (value: string) => number {
  const cache = new Map<string, number>();
  return (value) => {
    const cached = cache.get(value);
    if (cached !== undefined) return cached;
    const measured = count(value);
    cache.set(value, measured);
    if (cache.size > capacity) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return measured;
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function contextLines(document: ExtractedDocument, fragment: Fragment): string[] {
  const lines = [
    `Path: ${document.relativePath}`,
    `File: ${basename(document.relativePath)}`,
    `Format: ${document.metadata.language}`,
  ];
  if (fragment.headingTrail.length > 0) lines.push(`Heading: ${fragment.headingTrail.join(" > ")}`);
  if (fragment.symbols.length > 0) lines.push(`Symbol: ${fragment.symbols.join(", ")}`);
  return lines;
}

function enrich(document: ExtractedDocument, fragment: Fragment): string {
  return `${contextLines(document, fragment).join("\n")}\n\n${fragment.searchText}`;
}

function unitFragment(unit: ExtractedUnit): Fragment {
  return {
    ...unit.range,
    displayText: unit.displayText,
    searchText: unit.searchText,
    headingTrail: unit.headingTrail,
    symbols: unit.symbol ? [unit.symbol] : [],
  };
}

function sameSection(left: Fragment, right: Fragment): boolean {
  return left.headingTrail.join("\0") === right.headingTrail.join("\0");
}

function largestFittingEnd(
  text: string,
  start: number,
  fits: (candidate: string) => boolean,
): number {
  let low = start + 1;
  let high = text.length;
  let best = start;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(text.slice(start, middle))) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best === start) return Math.min(text.length, start + 1);
  if (best === text.length) return best;
  const preferred = text.slice(start, best).search(/\s+\S*$/u);
  return preferred > Math.floor((best - start) * 0.6) ? start + preferred : best;
}

function overlapStart(
  text: string,
  lowerBound: number,
  end: number,
  tokenBudget: number,
  count: (value: string) => number,
): number {
  if (tokenBudget <= 0 || end - lowerBound <= 1) return end;
  let low = lowerBound + 1;
  let high = end;
  let best = end;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (count(text.slice(middle, end)) <= tokenBudget) {
      best = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  const whitespace = text.indexOf(" ", best);
  return whitespace >= best && whitespace < end ? whitespace + 1 : best;
}

function splitUnit(
  document: ExtractedDocument,
  unit: ExtractedUnit,
  options: ChunkingOptions,
  count: (value: string) => number,
): Fragment[] {
  const whole = unitFragment(unit);
  if (count(enrich(document, whole)) <= options.index.chunkSizeTokens) return [whole];

  const fragments: Fragment[] = [];
  let searchStart = 0;
  while (searchStart < unit.searchText.length) {
    while (/\s/u.test(unit.searchText[searchStart] ?? "")) searchStart += 1;
    if (searchStart >= unit.searchText.length) break;
    const end = largestFittingEnd(unit.searchText, searchStart, (candidate) => {
      const probe = { ...whole, searchText: candidate, displayText: candidate };
      return count(enrich(document, probe)) <= options.index.chunkSizeTokens;
    });
    const searchText = unit.searchText.slice(searchStart, end).trim();
    const ratioStart = searchStart / Math.max(1, unit.searchText.length);
    const ratioEnd = end / Math.max(1, unit.searchText.length);
    const displayStart = Math.floor(unit.displayText.length * ratioStart);
    const displayEnd = Math.ceil(unit.displayText.length * ratioEnd);
    const sourceWidth = unit.range.endOffset - unit.range.startOffset;
    const startOffset = unit.range.startOffset + Math.floor(sourceWidth * ratioStart);
    const endOffset = unit.range.startOffset + Math.ceil(sourceWidth * ratioEnd);
    const lineWidth = unit.range.endLine - unit.range.startLine;
    fragments.push({
      startLine: unit.range.startLine + Math.floor(lineWidth * ratioStart),
      endLine: unit.range.startLine + Math.ceil(lineWidth * ratioEnd),
      startOffset,
      endOffset,
      displayText: unit.displayText.slice(displayStart, displayEnd).trim() || searchText,
      searchText,
      headingTrail: unit.headingTrail,
      symbols: unit.symbol ? [unit.symbol] : [],
    });
    if (end >= unit.searchText.length) break;
    const nextStart = overlapStart(
      unit.searchText,
      searchStart,
      end,
      options.index.chunkOverlapTokens,
      count,
    );
    searchStart = nextStart > searchStart ? nextStart : end;
  }
  return fragments;
}

function mergeFragments(fragments: readonly Fragment[]): Fragment {
  const first = fragments[0];
  const last = fragments.at(-1);
  if (!first || !last) throw new Error("Cannot merge an empty fragment list.");
  return {
    startLine: Math.min(...fragments.map((item) => item.startLine)),
    endLine: Math.max(...fragments.map((item) => item.endLine)),
    startOffset: Math.min(...fragments.map((item) => item.startOffset)),
    endOffset: Math.max(...fragments.map((item) => item.endOffset)),
    displayText: fragments.map((item) => item.displayText).join("\n\n"),
    searchText: fragments.map((item) => item.searchText).join("\n\n"),
    headingTrail: last.headingTrail,
    symbols: [...new Set(fragments.flatMap((item) => item.symbols))],
  };
}

function createChunk(
  document: ExtractedDocument,
  fragment: Fragment,
  ordinal: number,
  options: ChunkingOptions,
  count: (value: string) => number,
): SearchChunk {
  const searchText = enrich(document, fragment);
  const tokenCount = count(searchText);
  if (tokenCount > options.maxTokens) {
    throw new Error(
      `Chunk ${ordinal} uses ${tokenCount} tokens, above the ${options.maxTokens} limit.`,
    );
  }
  const contentHash = sha256(fragment.displayText);
  const location = `${fragment.startLine}:${fragment.endLine}:${fragment.headingTrail.join("/")}:${fragment.symbols.join(",")}`;
  return {
    chunkId: sha256(
      `chunk-v${options.index.chunkerVersion}\0${document.fileId}\0${location}\0${contentHash}`,
    ),
    fileId: document.fileId,
    relativePath: document.relativePath,
    ordinal,
    displayText: fragment.displayText,
    searchText,
    headingTrail: fragment.headingTrail,
    symbols: fragment.symbols,
    contentHash,
    tokenCount,
    extractorVersion: options.index.extractorVersion,
    chunkerVersion: options.index.chunkerVersion,
    startLine: fragment.startLine,
    endLine: fragment.endLine,
    startOffset: fragment.startOffset,
    endOffset: fragment.endOffset,
  };
}

export function chunkDocument(
  document: ExtractedDocument,
  options: ChunkingOptions,
): readonly SearchChunk[] {
  if (options.maxTokens < 1 || options.index.chunkSizeTokens < 1) {
    throw new Error("Token limits must be positive.");
  }
  if (options.index.chunkSizeTokens > options.maxTokens) {
    throw new Error("The target chunk size cannot exceed the model token limit.");
  }
  const count = cachedTokenCount((value) => options.tokenizer.count(value));
  const fragments = document.units
    .filter((unit) => unit.searchText.trim().length > 0)
    .flatMap((unit) => splitUnit(document, unit, options, count));
  const chunks: SearchChunk[] = [];
  let start = 0;
  while (start < fragments.length) {
    const selected: Fragment[] = [];
    let end = start;
    while (end < fragments.length) {
      const candidate = fragments[end];
      if (!candidate) break;
      if (selected.length > 0 && !sameSection(selected[0] as Fragment, candidate)) break;
      const merged = mergeFragments([...selected, candidate]);
      if (selected.length > 0 && count(enrich(document, merged)) > options.index.chunkSizeTokens) {
        break;
      }
      selected.push(candidate);
      end += 1;
    }
    if (selected.length === 0) throw new Error("The tokenizer could not fit any chunk content.");
    chunks.push(createChunk(document, mergeFragments(selected), chunks.length, options, count));
    if (end >= fragments.length) break;

    let overlapStart = end;
    let overlapTokens = 0;
    for (let index = end - 1; index > start; index -= 1) {
      const fragment = fragments[index];
      if (!fragment || !sameSection(fragment, fragments[end] as Fragment)) break;
      const fragmentTokens = count(fragment.searchText);
      if (overlapTokens + fragmentTokens > options.index.chunkOverlapTokens) break;
      overlapTokens += fragmentTokens;
      overlapStart = index;
    }
    start = overlapStart === start ? end : overlapStart;
  }
  return chunks;
}
