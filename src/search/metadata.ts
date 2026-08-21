import type {
  MetadataMatch,
  MetadataMatchField,
  MetadataMatchKind,
  SearchConfig,
} from "./contracts.ts";
import { queryTerms, quotedPhrases } from "./query.ts";

export interface SearchableMetadata {
  readonly filename: string;
  readonly relativePath: string;
  readonly headingTrail: readonly string[];
  readonly symbols: readonly string[];
}

const FIELD_WEIGHT: Readonly<Record<MetadataMatchField, number>> = {
  filename: 1,
  path: 0.95,
  symbol: 0.9,
  heading: 0.7,
};

const KIND_WEIGHT: Readonly<Record<MetadataMatchKind, number>> = {
  exact: 1,
  prefix: 0.8,
  substring: 0.65,
  fuzzy: 0.35,
};

export function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function normalizedParts(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_@.-]+/u)
    .filter(Boolean);
}

function compareValue(
  value: string,
  term: string,
  fuzzyMaxDistance: number,
): MetadataMatchKind | undefined {
  const haystack = value.toLowerCase();
  const needle = term.toLowerCase();
  if (haystack === needle) return "exact";
  if (haystack.startsWith(needle)) return "prefix";
  if (haystack.includes(needle)) return "substring";
  const allowedDistance = Math.min(fuzzyMaxDistance, needle.length <= 4 ? 1 : 2);
  if (
    allowedDistance > 0 &&
    normalizedParts(value).some(
      (part) =>
        Math.abs(part.length - needle.length) <= allowedDistance &&
        levenshteinDistance(part, needle) <= allowedDistance,
    )
  ) {
    return "fuzzy";
  }
  return undefined;
}

function metadataTerms(query: string): readonly string[] {
  const stripped = query.replaceAll(/"([^"\r\n]+)"/gu, "$1").trim();
  const values = [stripped, ...quotedPhrases(query), ...queryTerms(query)];
  return values.filter(
    (value, index) =>
      value.length >= 2 &&
      values.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index,
  );
}

export function bestMetadataMatch(
  metadata: SearchableMetadata,
  query: string,
  config: Pick<SearchConfig, "metadataFuzzyMaxDistance">,
): MetadataMatch | undefined {
  const filenameStem = metadata.filename.replace(/\.[^.]+$/u, "");
  const fields: readonly (readonly [MetadataMatchField, string])[] = [
    ["filename", metadata.filename],
    ["filename", filenameStem],
    ["path", metadata.relativePath],
    ...metadata.headingTrail.map((heading) => ["heading", heading] as const),
    ...metadata.symbols.map((symbol) => ["symbol", symbol] as const),
  ];
  let best: MetadataMatch | undefined;
  for (const term of metadataTerms(query)) {
    for (const [field, value] of fields) {
      const kind = compareValue(value, term, config.metadataFuzzyMaxDistance);
      if (!kind) continue;
      const strength = FIELD_WEIGHT[field] * KIND_WEIGHT[kind];
      if (
        !best ||
        strength > best.strength ||
        (strength === best.strength && term.length > best.term.length)
      ) {
        best = { field, kind, strength, term };
      }
    }
  }
  return best;
}
