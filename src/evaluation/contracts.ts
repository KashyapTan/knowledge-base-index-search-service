import type { SearchResponse } from "../search/index.ts";

export interface RelevanceJudgment {
  readonly id: string;
  readonly query: string;
  readonly expectedFiles: readonly string[];
  readonly relevantSections?: Readonly<Record<string, readonly string[]>>;
  readonly category:
    | "filename-path"
    | "symbol-config"
    | "error-message"
    | "concept"
    | "synonym"
    | "mixed";
  readonly rationale: string;
}

export interface RelevanceJudgmentSet {
  readonly version: 1;
  readonly name: string;
  readonly corpus: string;
  readonly judgments: readonly RelevanceJudgment[];
}

export interface QueryEvaluation {
  readonly id: string;
  readonly query: string;
  readonly category: RelevanceJudgment["category"];
  readonly expectedFiles: readonly string[];
  readonly rankedFiles: readonly string[];
  readonly firstRelevantRank: number | null;
  readonly recallAt5: number;
  readonly recallAt10: number;
  readonly reciprocalRank: number;
  readonly distinctFileRatioAt10: number;
  readonly relevantSectionHit: boolean | null;
}

export interface RelevanceMetrics {
  readonly queryCount: number;
  readonly recallAt5: number;
  readonly recallAt10: number;
  readonly meanReciprocalRank: number;
  readonly distinctFileRatioAt10: number;
  readonly relevantSectionHitRate: number | null;
}

export interface RelevanceEvaluationReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly judgmentSet: Pick<RelevanceJudgmentSet, "version" | "name" | "corpus">;
  readonly metrics: RelevanceMetrics;
  readonly queries: readonly QueryEvaluation[];
  readonly settings: Readonly<Record<string, unknown>>;
}

export type SearchForEvaluation = (query: string, fileCount: number) => Promise<SearchResponse>;
