import type { SearchResponse } from "../search/index.ts";
import type {
  QueryEvaluation,
  RelevanceEvaluationReport,
  RelevanceJudgment,
  RelevanceJudgmentSet,
  RelevanceMetrics,
  SearchForEvaluation,
} from "./contracts.ts";

function recallAt(ranked: readonly string[], expected: ReadonlySet<string>, count: number): number {
  const hits = new Set(ranked.slice(0, count).filter((path) => expected.has(path)));
  return hits.size / expected.size;
}

function sectionHit(judgment: RelevanceJudgment, response: SearchResponse): boolean | null {
  if (!judgment.relevantSections) return null;
  return response.results.some((result) => {
    const sections = judgment.relevantSections?.[result.relativePath];
    if (!sections) return false;
    return result.excerpts.some((excerpt) => {
      const context = [...excerpt.headingTrail, ...excerpt.symbols].join(" > ").toLowerCase();
      return sections.some((section) => context.includes(section.toLowerCase()));
    });
  });
}

export function evaluateQuery(
  judgment: RelevanceJudgment,
  response: SearchResponse,
): QueryEvaluation {
  const rankedFiles = response.results.map((result) => result.relativePath);
  const expected = new Set(judgment.expectedFiles);
  const firstIndex = rankedFiles.findIndex((path) => expected.has(path));
  const firstRelevantRank = firstIndex < 0 ? null : firstIndex + 1;
  const topTen = rankedFiles.slice(0, 10);
  return {
    id: judgment.id,
    query: judgment.query,
    category: judgment.category,
    expectedFiles: judgment.expectedFiles,
    rankedFiles,
    firstRelevantRank,
    recallAt5: recallAt(rankedFiles, expected, 5),
    recallAt10: recallAt(rankedFiles, expected, 10),
    reciprocalRank: firstRelevantRank === null ? 0 : 1 / firstRelevantRank,
    distinctFileRatioAt10:
      topTen.length === 0 ? 1 : new Set(topTen).size / Math.max(1, topTen.length),
    relevantSectionHit: sectionHit(judgment, response),
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeEvaluations(queries: readonly QueryEvaluation[]): RelevanceMetrics {
  const sectionValues = queries.flatMap((query) =>
    query.relevantSectionHit === null ? [] : [query.relevantSectionHit ? 1 : 0],
  );
  return {
    queryCount: queries.length,
    recallAt5: mean(queries.map((query) => query.recallAt5)),
    recallAt10: mean(queries.map((query) => query.recallAt10)),
    meanReciprocalRank: mean(queries.map((query) => query.reciprocalRank)),
    distinctFileRatioAt10: mean(queries.map((query) => query.distinctFileRatioAt10)),
    relevantSectionHitRate: sectionValues.length === 0 ? null : mean(sectionValues),
  };
}

export async function evaluateJudgments(
  judgments: RelevanceJudgmentSet,
  search: SearchForEvaluation,
  options: {
    readonly generatedAt?: string;
    readonly settings?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<RelevanceEvaluationReport> {
  const queries: QueryEvaluation[] = [];
  for (const judgment of judgments.judgments) {
    queries.push(evaluateQuery(judgment, await search(judgment.query, 10)));
  }
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    judgmentSet: {
      version: judgments.version,
      name: judgments.name,
      corpus: judgments.corpus,
    },
    metrics: summarizeEvaluations(queries),
    queries,
    settings: options.settings ?? {},
  };
}
