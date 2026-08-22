import { readFile } from "node:fs/promises";
import type { RelevanceJudgment, RelevanceJudgmentSet } from "./contracts.ts";

const categories = new Set<RelevanceJudgment["category"]>([
  "filename-path",
  "symbol-config",
  "error-message",
  "concept",
  "synonym",
  "mixed",
]);

function nonEmptyStrings(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  );
}

function validSections(value: unknown): value is Readonly<Record<string, readonly string[]>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([path, sections]) => path.trim().length > 0 && nonEmptyStrings(sections),
    )
  );
}

export function parseJudgmentSet(value: unknown): RelevanceJudgmentSet {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A relevance judgment set must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.name !== "string" ||
    !record.name.trim() ||
    typeof record.corpus !== "string" ||
    !record.corpus.trim() ||
    !Array.isArray(record.judgments) ||
    record.judgments.length === 0
  ) {
    throw new Error("The relevance judgment set metadata is incomplete or unsupported.");
  }

  const ids = new Set<string>();
  const judgments = record.judgments.map((item, index): RelevanceJudgment => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Judgment ${index + 1} must be an object.`);
    }
    const judgment = item as Record<string, unknown>;
    if (
      typeof judgment.id !== "string" ||
      !judgment.id.trim() ||
      ids.has(judgment.id) ||
      typeof judgment.query !== "string" ||
      !judgment.query.trim() ||
      !nonEmptyStrings(judgment.expectedFiles) ||
      typeof judgment.category !== "string" ||
      !categories.has(judgment.category as RelevanceJudgment["category"]) ||
      typeof judgment.rationale !== "string" ||
      !judgment.rationale.trim() ||
      (judgment.relevantSections !== undefined && !validSections(judgment.relevantSections))
    ) {
      throw new Error(`Judgment ${index + 1} is invalid or duplicates an ID.`);
    }
    const expectedFiles = [...new Set(judgment.expectedFiles)];
    if (
      judgment.relevantSections &&
      Object.keys(judgment.relevantSections).some((path) => !expectedFiles.includes(path))
    ) {
      throw new Error(`Judgment ${judgment.id} has sections for a non-relevant file.`);
    }
    ids.add(judgment.id);
    return {
      id: judgment.id,
      query: judgment.query,
      expectedFiles,
      category: judgment.category as RelevanceJudgment["category"],
      rationale: judgment.rationale,
      ...(judgment.relevantSections
        ? { relevantSections: judgment.relevantSections as Readonly<Record<string, string[]>> }
        : {}),
    };
  });

  return { version: 1, name: record.name, corpus: record.corpus, judgments };
}

export async function loadJudgmentSet(path: string): Promise<RelevanceJudgmentSet> {
  return parseJudgmentSet(JSON.parse(await readFile(path, "utf8")) as unknown);
}
