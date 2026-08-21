import { DEFAULT_SEARCH_CONFIG, type SearchConfig } from "./contracts.ts";

export interface SearchConfigOverrides extends Partial<Omit<SearchConfig, "sourceWeights">> {
  readonly sourceWeights?: Partial<SearchConfig["sourceWeights"]>;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

export function createSearchConfig(overrides: SearchConfigOverrides = {}): SearchConfig {
  const config: SearchConfig = {
    ...DEFAULT_SEARCH_CONFIG,
    ...overrides,
    sourceWeights: {
      ...DEFAULT_SEARCH_CONFIG.sourceWeights,
      ...overrides.sourceWeights,
    },
  };
  for (const [name, value] of [
    ["defaultFileCount", config.defaultFileCount],
    ["maxFileCount", config.maxFileCount],
    ["maxQueryLength", config.maxQueryLength],
    ["maxFormatFilters", config.maxFormatFilters],
    ["vectorCandidates", config.vectorCandidates],
    ["bm25Candidates", config.bm25Candidates],
    ["metadataCandidates", config.metadataCandidates],
    ["metadataChunksPerFile", config.metadataChunksPerFile],
    ["rrfConstant", config.rrfConstant],
    ["maxExcerptsPerFile", config.maxExcerptsPerFile],
  ] as const) {
    positiveInteger(value, name);
  }
  if (config.defaultFileCount > config.maxFileCount) {
    throw new RangeError("defaultFileCount must not exceed maxFileCount.");
  }
  if (config.metadataFuzzyMaxDistance < 0 || !Number.isInteger(config.metadataFuzzyMaxDistance)) {
    throw new RangeError("metadataFuzzyMaxDistance must be a non-negative integer.");
  }
  if (config.maxSupplementalFileScoreRatio < 0 || config.maxSupplementalFileScoreRatio > 1) {
    throw new RangeError("maxSupplementalFileScoreRatio must be between zero and one.");
  }
  if (config.supplementalScoreDecay < 0 || config.supplementalScoreDecay > 1) {
    throw new RangeError("supplementalScoreDecay must be between zero and one.");
  }
  if (
    !Number.isFinite(config.maxVectorDistance) ||
    config.maxVectorDistance < 0 ||
    config.maxVectorDistance > 2
  ) {
    throw new RangeError("maxVectorDistance must be between zero and two.");
  }
  if (
    Object.values(config.sourceWeights).some((weight) => !Number.isFinite(weight) || weight < 0)
  ) {
    throw new RangeError("Every search source weight must be a finite non-negative number.");
  }
  return Object.freeze({ ...config, sourceWeights: Object.freeze(config.sourceWeights) });
}
