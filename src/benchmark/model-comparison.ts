import type {
  LargeRepositoryBenchmarkReport,
  ModelBenchmarkSummary,
  ModelComparisonReport,
} from "./contracts.ts";

function summary(report: LargeRepositoryBenchmarkReport): ModelBenchmarkSummary {
  const importantMisses =
    report.relevance?.queries
      .filter(
        (query) =>
          query.firstRelevantRank === null &&
          ["error-message", "symbol-config", "mixed"].includes(query.category),
      )
      .map((query) => query.id) ?? [];
  const queryMedians = report.queries.map((query) => query.totalMs.p50);
  return {
    modelId: report.settings.modelId,
    vectorDimension: report.settings.vectorDimension,
    recallAt5: report.relevance?.metrics.recallAt5 ?? null,
    recallAt10: report.relevance?.metrics.recallAt10 ?? null,
    meanReciprocalRank: report.relevance?.metrics.meanReciprocalRank ?? null,
    importantMisses,
    indexingChunksPerSecond: report.indexing.chunksPerSecond,
    medianWarmQueryMs:
      queryMedians.length === 0
        ? 0
        : (queryMedians.toSorted((left, right) => left - right)[
            Math.floor(queryMedians.length / 2)
          ] ?? 0),
    modelLoadMs: report.startup.modelLoadMs,
    peakRssBytes: report.memory.peakRssBytes,
    indexBytes: report.storage.indexBytes,
  };
}

function sameNonModelSettings(
  small: LargeRepositoryBenchmarkReport,
  base: LargeRepositoryBenchmarkReport,
): boolean {
  const selected = (report: LargeRepositoryBenchmarkReport) => ({
    corpusRevision: report.corpus.revision,
    supportedFileCount: report.corpus.supportedFileCount,
    totalBytes: report.corpus.totalBytes,
    chunkSizeTokens: report.settings.chunkSizeTokens,
    chunkOverlapTokens: report.settings.chunkOverlapTokens,
    extractorVersion: report.settings.extractorVersion,
    chunkerVersion: report.settings.chunkerVersion,
    indexSchemaVersion: report.settings.indexSchemaVersion,
    annThreshold: report.settings.annThreshold,
    ignorePatterns: report.settings.ignorePatterns,
    relevanceSet: report.relevance?.judgmentSet ?? null,
  });
  return JSON.stringify(selected(small)) === JSON.stringify(selected(base));
}

export function compareModelBenchmarks(
  smallReport: LargeRepositoryBenchmarkReport,
  baseReport: LargeRepositoryBenchmarkReport,
  generatedAt = new Date().toISOString(),
): ModelComparisonReport {
  const small = summary(smallReport);
  const base = summary(baseReport);
  const identicalSettings = sameNonModelSettings(smallReport, baseReport);
  const importantQueriesFixed = small.importantMisses.filter(
    (id) => !base.importantMisses.includes(id),
  );
  const recallAt5AbsoluteGain =
    small.recallAt5 === null || base.recallAt5 === null ? null : base.recallAt5 - small.recallAt5;
  const baseHasMeaningfulBenefit =
    identicalSettings &&
    ((recallAt5AbsoluteGain !== null && recallAt5AbsoluteGain >= 0.05) ||
      importantQueriesFixed.length > 0);
  const rationale = !identicalSettings
    ? ["The runs did not use identical corpus and non-model settings; keep BGE small by default."]
    : baseHasMeaningfulBenefit
      ? [
          ...(recallAt5AbsoluteGain !== null && recallAt5AbsoluteGain >= 0.05
            ? [`BGE base improved Recall@5 by ${(recallAt5AbsoluteGain * 100).toFixed(1)} points.`]
            : []),
          ...(importantQueriesFixed.length > 0
            ? [`BGE base fixed important judged queries: ${importantQueriesFixed.join(", ")}.`]
            : []),
        ]
      : [
          "BGE base did not clear the corpus-specific 5-point Recall@5 threshold or fix an important consistent miss.",
          "BGE small remains the lower-cost default for indexing, latency, memory, and storage.",
        ];
  return {
    schemaVersion: 1,
    generatedAt,
    corpusRevision: smallReport.corpus.revision,
    identicalSettings,
    small,
    base,
    decision: {
      selectedModel: baseHasMeaningfulBenefit ? base.modelId : small.modelId,
      rationale,
      recallAt5AbsoluteGain,
      importantQueriesFixed,
    },
  };
}
