import type { RelevanceEvaluationReport } from "../evaluation/index.ts";
import type { IndexingFileError } from "../indexing/index.ts";
import type { SearchTiming } from "../search/index.ts";

export interface DistributionSummary {
  readonly count: number;
  readonly minimum: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly maximum: number;
}

export interface BenchmarkDefinition {
  readonly schemaVersion: 1;
  readonly ignorePatterns: readonly string[];
  readonly queries: readonly string[];
  readonly warmRuns: number;
  readonly annThreshold: number;
}

export interface QueryBenchmark {
  readonly queryLabel: string;
  readonly totalMs: DistributionSummary;
  readonly embeddingMs: DistributionSummary;
  readonly retrievalMs: DistributionSummary;
  readonly vectorMs: DistributionSummary;
  readonly bm25Ms: DistributionSummary;
  readonly metadataMs: DistributionSummary;
  readonly fusionMs: DistributionSummary;
  readonly aggregationMs: DistributionSummary;
  readonly returnedFiles: number;
}

export interface LargeRepositoryBenchmarkReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly corpus: {
    readonly rootIdentity: string;
    readonly revision: string | null;
    readonly dirty: boolean | null;
    readonly supportedFileCount: number;
    readonly totalBytes: number;
    readonly formatDistribution: Readonly<Record<string, number>>;
    readonly readyFiles: number;
    readonly skippedFiles: number;
    readonly failedFiles: number;
    readonly failureReasons: Readonly<Record<string, number>>;
    readonly readOnlyVerification: {
      readonly stateOutsideSource: boolean;
      readonly outputOutsideSource: boolean;
      readonly gitStatusUnchanged: boolean | null;
    };
  };
  readonly environment: {
    readonly os: string;
    readonly architecture: string;
    readonly cpu: string;
    readonly logicalCpus: number;
    readonly totalMemoryBytes: number;
    readonly bunVersion: string;
    readonly dependencies: Readonly<Record<string, string>>;
  };
  readonly settings: {
    readonly modelId: string;
    readonly quantization: string;
    readonly vectorDimension: number;
    readonly chunkSizeTokens: number;
    readonly chunkOverlapTokens: number;
    readonly extractorVersion: number;
    readonly chunkerVersion: number;
    readonly indexSchemaVersion: number;
    readonly annThreshold: number;
    readonly indexStrategy: "exact" | "ivf-flat";
    readonly ignorePatterns: readonly string[];
  };
  readonly startup: {
    readonly loopbackBrowserReadyMs: number;
    readonly modelLoadMs: number;
    readonly tokenizerLoadMs: number;
    readonly initialScanMs: number;
  };
  readonly indexing: {
    readonly initialWallMs: number;
    readonly chunksPerSecond: number;
    readonly extractedChunkCount: number;
    readonly embeddedChunks: number;
    readonly reusedChunks: number;
    readonly changedFiles: number;
    readonly skippedFiles: number;
    readonly failedFiles: number;
    readonly errors: readonly IndexingFileError[];
    readonly tokenDistribution: DistributionSummary;
    readonly noChangeReconciliationMs: number;
    readonly noChangeFiles: number;
  };
  readonly memory: {
    readonly peakRssBytes: number;
    readonly steadyRssBytes: number;
  };
  readonly storage: {
    readonly indexBytes: number;
    readonly modelCacheBytes: number;
  };
  readonly queries: readonly QueryBenchmark[];
  readonly viewer: {
    readonly smallFileBytes: number;
    readonly smallOpenMs: number;
    readonly smallGrepMs: number;
    readonly largeFileBytes: number;
    readonly largeOpenMs: number;
    readonly largeGrepMs: number;
  };
  readonly incrementalFixture: {
    readonly sourceWasExternalCopy: true;
    readonly updateMs: number;
    readonly deleteMs: number;
    readonly renameMs: number;
  };
  readonly relevance: RelevanceEvaluationReport | null;
}

export interface ModelBenchmarkSummary {
  readonly modelId: string;
  readonly vectorDimension: number;
  readonly recallAt5: number | null;
  readonly recallAt10: number | null;
  readonly meanReciprocalRank: number | null;
  readonly importantMisses: readonly string[];
  readonly indexingChunksPerSecond: number;
  readonly medianWarmQueryMs: number;
  readonly modelLoadMs: number;
  readonly peakRssBytes: number;
  readonly indexBytes: number;
}

export interface ModelComparisonReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly corpusRevision: string | null;
  readonly identicalSettings: boolean;
  readonly small: ModelBenchmarkSummary;
  readonly base: ModelBenchmarkSummary;
  readonly decision: {
    readonly selectedModel: string;
    readonly rationale: readonly string[];
    readonly recallAt5AbsoluteGain: number | null;
    readonly importantQueriesFixed: readonly string[];
  };
}

export type TimingKey = keyof SearchTiming;
