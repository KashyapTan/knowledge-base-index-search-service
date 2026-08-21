import type { FusedSearchCandidate, SearchCandidate, SearchMatchSource } from "./contracts.ts";

export function candidate(
  chunkId: string,
  fileId: string,
  source: SearchMatchSource,
  rawScore: number,
  overrides: Partial<SearchCandidate> = {},
): SearchCandidate {
  return {
    chunkId,
    fileId,
    relativePath: `docs/${fileId}.md`,
    filename: `${fileId}.md`,
    format: "markdown",
    displayText: `text for ${chunkId}`,
    startLine: 1,
    endLine: 2,
    startOffset: 0,
    endOffset: 12,
    headingTrail: ["Section"],
    symbols: [],
    source,
    rawScore,
    ...overrides,
  };
}

export function fusedCandidate(
  chunkId: string,
  fileId: string,
  score: number,
  overrides: Partial<FusedSearchCandidate> = {},
): FusedSearchCandidate {
  return {
    chunkId,
    fileId,
    relativePath: `docs/${fileId}.md`,
    filename: `${fileId}.md`,
    format: "markdown",
    displayText: `text for ${chunkId}`,
    startLine: 1,
    endLine: 2,
    startOffset: 0,
    endOffset: 12,
    headingTrail: ["Section"],
    symbols: [],
    score,
    matches: [{ source: "vector", rank: 1, rawScore: score }],
    ...overrides,
  };
}
