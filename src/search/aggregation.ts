import type {
  FusedSearchCandidate,
  SearchConfig,
  SearchFileResult,
  SearchMatchSource,
} from "./contracts.ts";
import { queryTerms } from "./query.ts";

function diversityKey(candidate: FusedSearchCandidate): string {
  const headings = candidate.headingTrail.join("\u001f").toLowerCase();
  const symbols = candidate.symbols.join("\u001f").toLowerCase();
  return headings || symbols || "unscoped";
}

function selectDiverseExcerpts(
  candidates: readonly FusedSearchCandidate[],
  limit: number,
): readonly FusedSearchCandidate[] {
  const selected: FusedSearchCandidate[] = [];
  const deferred: FusedSearchCandidate[] = [];
  const contexts = new Set<string>();
  for (const candidate of candidates) {
    const context = diversityKey(candidate);
    if (!contexts.has(context)) {
      selected.push(candidate);
      contexts.add(context);
    } else {
      deferred.push(candidate);
    }
    if (selected.length === limit) return selected;
  }
  for (const candidate of deferred) {
    selected.push(candidate);
    if (selected.length === limit) break;
  }
  return selected;
}

function matchingHighlightTerms(text: string, query: string): readonly string[] {
  const lowerText = text.toLowerCase();
  return queryTerms(query).filter((term) => lowerText.includes(term.toLowerCase()));
}

function sourcesFor(candidates: readonly FusedSearchCandidate[]): readonly SearchMatchSource[] {
  const sources = new Set<SearchMatchSource>();
  for (const candidate of candidates) {
    for (const match of candidate.matches) sources.add(match.source);
  }
  return [...sources].sort();
}

export function aggregateByFile(
  candidates: readonly FusedSearchCandidate[],
  query: string,
  fileCount: number,
  config: Pick<
    SearchConfig,
    "maxExcerptsPerFile" | "maxSupplementalFileScoreRatio" | "supplementalScoreDecay"
  >,
): readonly SearchFileResult[] {
  const grouped = new Map<string, FusedSearchCandidate[]>();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.fileId) ?? [];
    group.push(candidate);
    grouped.set(candidate.fileId, group);
  }

  const results: SearchFileResult[] = [];
  for (const group of grouped.values()) {
    const ordered = [...group].sort(
      (left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId),
    );
    const best = ordered[0];
    if (!best) continue;
    let supplemental = 0;
    for (const [index, candidate] of ordered.slice(1).entries()) {
      supplemental += candidate.score * config.supplementalScoreDecay ** (index + 1);
    }
    const score =
      best.score + Math.min(supplemental, best.score * config.maxSupplementalFileScoreRatio);
    const excerpts = selectDiverseExcerpts(ordered, config.maxExcerptsPerFile).map((candidate) => ({
      chunkId: candidate.chunkId,
      text: candidate.displayText,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      startOffset: candidate.startOffset,
      endOffset: candidate.endOffset,
      headingTrail: candidate.headingTrail,
      symbols: candidate.symbols,
      score: candidate.score,
      matchSources: sourcesFor([candidate]),
      highlightTerms: matchingHighlightTerms(candidate.displayText, query),
    }));
    results.push({
      fileId: best.fileId,
      relativePath: best.relativePath,
      filename: best.filename,
      format: best.format,
      score,
      matchSources: sourcesFor(ordered),
      excerpts,
    });
  }
  return results
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.relativePath.localeCompare(right.relativePath) ||
        left.fileId.localeCompare(right.fileId),
    )
    .slice(0, fileCount);
}
