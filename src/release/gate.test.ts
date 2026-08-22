import { describe, expect, test } from "bun:test";
import type { LargeRepositoryBenchmarkReport, ModelComparisonReport } from "../benchmark/index.ts";
import type { ControlledEvaluationRun } from "../evaluation/controlled.ts";
import {
  type ReleaseThresholds,
  validateControlledReleaseEvidence,
  validateLargeBenchmarkEvidence,
  validateModelComparisonEvidence,
} from "./gate.ts";

const thresholds: ReleaseThresholds = {
  coverage: { lines: 93, functions: 93 },
  controlledRelevance: { recallAt5: 0.9, recallAt10: 0.95, meanReciprocalRank: 0.8 },
  benchmark: {
    maximumFailureRatio: 0.01,
    maximumWarmQueryP95Ms: 5_000,
    maximumViewerOpenMs: 2_000,
    maximumViewerGrepMs: 2_000,
  },
};

describe("Plan 11 release evidence", () => {
  test("reports every controlled and benchmark invariant instead of stopping at the first", () => {
    const controlled = {
      evidence: {
        discoveredFiles: 2,
        indexedChunks: 1,
        unchangedFilesOnSecondPass: 1,
        failedFiles: 1,
      },
      report: {
        metrics: { recallAt5: 0, recallAt10: 0, meanReciprocalRank: 0 },
      },
    } as ControlledEvaluationRun;
    expect(validateControlledReleaseEvidence(controlled, thresholds)).toHaveLength(5);

    const large = {
      corpus: {
        supportedFileCount: 100,
        readOnlyVerification: {
          stateOutsideSource: false,
          outputOutsideSource: true,
          gitStatusUnchanged: false,
        },
      },
      indexing: { failedFiles: 2, noChangeFiles: 99 },
      incrementalFixture: {
        metadataOnlyMass: { embeddedChunks: 1, chunksVersionUnchanged: false },
        largeFileEdits: {
          start: { embeddedChunks: 0, reusedChunks: 0 },
          middle: { embeddedChunks: 1, reusedChunks: 0 },
          end: { embeddedChunks: 1, reusedChunks: 1 },
        },
      },
      queries: [{ totalMs: { p95: 6_000 } }],
      viewer: { smallOpenMs: 0, largeOpenMs: 3_000, smallGrepMs: 0, largeGrepMs: 3_000 },
    } as unknown as LargeRepositoryBenchmarkReport;
    expect(validateLargeBenchmarkEvidence(large, thresholds)).toHaveLength(8);
  });

  test("accepts complete evidence and rejects incomparable or ungrounded model decisions", () => {
    const controlled = {
      evidence: {
        discoveredFiles: 2,
        indexedChunks: 2,
        unchangedFilesOnSecondPass: 2,
        failedFiles: 0,
      },
      report: { metrics: { recallAt5: 1, recallAt10: 1, meanReciprocalRank: 1 } },
    } as ControlledEvaluationRun;
    expect(validateControlledReleaseEvidence(controlled, thresholds)).toEqual([]);

    const large = {
      corpus: {
        supportedFileCount: 2,
        readOnlyVerification: {
          stateOutsideSource: true,
          outputOutsideSource: true,
          gitStatusUnchanged: true,
        },
      },
      indexing: { failedFiles: 0, noChangeFiles: 2 },
      incrementalFixture: {
        metadataOnlyMass: { embeddedChunks: 0, chunksVersionUnchanged: true },
        largeFileEdits: {
          start: { embeddedChunks: 1, reusedChunks: 3 },
          middle: { embeddedChunks: 1, reusedChunks: 3 },
          end: { embeddedChunks: 1, reusedChunks: 3 },
        },
      },
      queries: [{ totalMs: { p95: 1 } }],
      viewer: { smallOpenMs: 1, largeOpenMs: 1, smallGrepMs: 1, largeGrepMs: 1 },
    } as unknown as LargeRepositoryBenchmarkReport;
    expect(validateLargeBenchmarkEvidence(large, thresholds)).toEqual([]);

    const comparison = {
      identicalSettings: false,
      small: { modelId: "small" },
      base: { modelId: "base" },
      decision: { selectedModel: "other", rationale: [] },
    } as unknown as ModelComparisonReport;
    expect(validateModelComparisonEvidence(comparison)).toHaveLength(3);
  });
});
