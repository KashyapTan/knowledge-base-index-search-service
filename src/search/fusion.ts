import type {
  CandidateMatch,
  FusedSearchCandidate,
  SearchCandidate,
  SearchConfig,
  SearchMatchSource,
} from "./contracts.ts";

export interface RankedItem<T> {
  readonly item: T;
  readonly rank: number;
}

export function rankWithTies<T>(
  items: readonly T[],
  score: (item: T) => number,
  identity: (item: T) => string,
): readonly RankedItem<T>[] {
  const deduplicated = new Map<string, T>();
  for (const item of items) {
    const key = identity(item);
    const current = deduplicated.get(key);
    if (!current || score(item) > score(current)) deduplicated.set(key, item);
  }
  const sorted = [...deduplicated.values()].sort(
    (left, right) => score(right) - score(left) || identity(left).localeCompare(identity(right)),
  );
  let priorScore: number | undefined;
  let rank = 0;
  return sorted.map((item, index) => {
    const itemScore = score(item);
    if (priorScore === undefined || itemScore !== priorScore) rank = index + 1;
    priorScore = itemScore;
    return { item, rank };
  });
}

export function reciprocalRank(rank: number, constant: number, weight = 1): number {
  return weight / (constant + rank);
}

export function fuseCandidatePools(
  pools: Readonly<Record<SearchMatchSource, readonly SearchCandidate[]>>,
  config: Pick<SearchConfig, "rrfConstant" | "sourceWeights">,
): readonly FusedSearchCandidate[] {
  const fused = new Map<
    string,
    { candidate: SearchCandidate; score: number; matches: CandidateMatch[] }
  >();
  for (const source of ["vector", "bm25", "metadata"] as const) {
    const ranked = rankWithTies(
      pools[source],
      (candidate) => candidate.rawScore,
      (candidate) => candidate.chunkId,
    );
    for (const { item, rank } of ranked) {
      const current = fused.get(item.chunkId) ?? { candidate: item, score: 0, matches: [] };
      const match: CandidateMatch = {
        source,
        rank,
        rawScore: item.rawScore,
        ...(item.metadataMatch ? { metadataMatch: item.metadataMatch } : {}),
      };
      current.score += reciprocalRank(rank, config.rrfConstant, config.sourceWeights[source]);
      current.matches.push(match);
      fused.set(item.chunkId, current);
    }
  }
  return [...fused.values()]
    .map(({ candidate, score, matches }) => ({
      chunkId: candidate.chunkId,
      fileId: candidate.fileId,
      relativePath: candidate.relativePath,
      filename: candidate.filename,
      format: candidate.format,
      displayText: candidate.displayText,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      startOffset: candidate.startOffset,
      endOffset: candidate.endOffset,
      headingTrail: candidate.headingTrail,
      symbols: candidate.symbols,
      score,
      matches: matches.sort((left, right) => left.source.localeCompare(right.source)),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.relativePath.localeCompare(right.relativePath) ||
        left.chunkId.localeCompare(right.chunkId),
    );
}
