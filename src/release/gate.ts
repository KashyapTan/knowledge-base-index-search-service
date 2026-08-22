import type { LargeRepositoryBenchmarkReport, ModelComparisonReport } from "../benchmark/index.ts";
import type { ControlledEvaluationRun } from "../evaluation/controlled.ts";

export interface ReleaseThresholds {
  readonly coverage: { readonly lines: number; readonly functions: number };
  readonly controlledRelevance: {
    readonly recallAt5: number;
    readonly recallAt10: number;
    readonly meanReciprocalRank: number;
  };
  readonly benchmark: {
    readonly maximumFailureRatio: number;
    readonly maximumWarmQueryP95Ms: number;
    readonly maximumViewerOpenMs: number;
    readonly maximumViewerGrepMs: number;
  };
}

export function validateControlledReleaseEvidence(
  run: ControlledEvaluationRun,
  thresholds: ReleaseThresholds,
): readonly string[] {
  const failures: string[] = [];
  if (run.report.metrics.recallAt5 < thresholds.controlledRelevance.recallAt5) {
    failures.push("controlled Recall@5 is below threshold");
  }
  if (run.report.metrics.recallAt10 < thresholds.controlledRelevance.recallAt10) {
    failures.push("controlled Recall@10 is below threshold");
  }
  if (run.report.metrics.meanReciprocalRank < thresholds.controlledRelevance.meanReciprocalRank) {
    failures.push("controlled MRR is below threshold");
  }
  if (run.evidence.failedFiles > 0) failures.push("controlled indexing has file failures");
  if (run.evidence.unchangedFilesOnSecondPass !== run.evidence.discoveredFiles) {
    failures.push("controlled no-change indexing is not a complete no-op");
  }
  return failures;
}

export function validateLargeBenchmarkEvidence(
  report: LargeRepositoryBenchmarkReport,
  thresholds: ReleaseThresholds,
): readonly string[] {
  const failures: string[] = [];
  const failureRatio =
    report.corpus.supportedFileCount === 0
      ? 1
      : report.indexing.failedFiles / report.corpus.supportedFileCount;
  if (failureRatio > thresholds.benchmark.maximumFailureRatio) {
    failures.push("large-corpus indexing failure ratio is above threshold");
  }
  if (report.indexing.noChangeFiles !== report.corpus.supportedFileCount) {
    failures.push("large-corpus no-change reconciliation is incomplete");
  }
  if (
    report.corpus.readOnlyVerification.stateOutsideSource !== true ||
    report.corpus.readOnlyVerification.outputOutsideSource !== true ||
    report.corpus.readOnlyVerification.gitStatusUnchanged === false
  ) {
    failures.push("large-corpus read-only verification failed");
  }
  if (
    report.queries.some((query) => query.totalMs.p95 > thresholds.benchmark.maximumWarmQueryP95Ms)
  ) {
    failures.push("a warm query p95 exceeds the severe-regression threshold");
  }
  if (
    Math.max(report.viewer.smallOpenMs, report.viewer.largeOpenMs) >
    thresholds.benchmark.maximumViewerOpenMs
  ) {
    failures.push("viewer open latency exceeds the severe-regression threshold");
  }
  if (
    Math.max(report.viewer.smallGrepMs, report.viewer.largeGrepMs) >
    thresholds.benchmark.maximumViewerGrepMs
  ) {
    failures.push("viewer grep latency exceeds the severe-regression threshold");
  }
  return failures;
}

export function validateModelComparisonEvidence(report: ModelComparisonReport): readonly string[] {
  const failures: string[] = [];
  if (!report.identicalSettings) failures.push("model comparison settings are not identical");
  if (!report.decision.rationale.length) failures.push("model decision has no rationale");
  if (![report.small.modelId, report.base.modelId].includes(report.decision.selectedModel)) {
    failures.push("model decision selected an unbenchmarked model");
  }
  return failures;
}
