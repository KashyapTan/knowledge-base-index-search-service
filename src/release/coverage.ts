export interface CoverageFileSummary {
  readonly path: string;
  readonly functions: { readonly found: number; readonly hit: number; readonly percent: number };
  readonly lines: { readonly found: number; readonly hit: number; readonly percent: number };
}

export interface CoverageSummary {
  readonly files: readonly CoverageFileSummary[];
  readonly functions: { readonly found: number; readonly hit: number; readonly percent: number };
  readonly lines: { readonly found: number; readonly hit: number; readonly percent: number };
}

function percent(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100;
}

function count(record: Readonly<Record<string, string>>, key: string): number {
  const value = Number(record[key] ?? 0);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid LCOV ${key} value.`);
  return value;
}

export function parseLcov(
  text: string,
  include: (path: string) => boolean = () => true,
): CoverageSummary {
  const files: CoverageFileSummary[] = [];
  for (const block of text.split("end_of_record")) {
    const values: Record<string, string> = {};
    for (const line of block.split(/\r?\n/u)) {
      const separator = line.indexOf(":");
      if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
    }
    const path = values.SF;
    if (!path || !include(path)) continue;
    const functionsFound = count(values, "FNF");
    const functionsHit = count(values, "FNH");
    const linesFound = count(values, "LF");
    const linesHit = count(values, "LH");
    if (functionsHit > functionsFound || linesHit > linesFound) {
      throw new Error(`LCOV hit counts exceed totals for ${path}.`);
    }
    files.push({
      path,
      functions: {
        found: functionsFound,
        hit: functionsHit,
        percent: percent(functionsHit, functionsFound),
      },
      lines: { found: linesFound, hit: linesHit, percent: percent(linesHit, linesFound) },
    });
  }
  if (files.length === 0) throw new Error("The LCOV report contains no included source files.");
  const aggregate = (field: "functions" | "lines") => {
    const found = files.reduce((sum, file) => sum + file[field].found, 0);
    const hit = files.reduce((sum, file) => sum + file[field].hit, 0);
    return { found, hit, percent: percent(hit, found) };
  };
  return { files, functions: aggregate("functions"), lines: aggregate("lines") };
}

export function isGovernedApplicationSource(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized.startsWith("src/") &&
    !normalized.endsWith(".test.ts") &&
    !normalized.endsWith(".test.tsx") &&
    !normalized.endsWith("/test-helpers.ts") &&
    !normalized.includes("/fixtures/")
  );
}

export function assertCoverageThresholds(
  summary: CoverageSummary,
  thresholds: { readonly lines: number; readonly functions: number },
): void {
  const failures: string[] = [];
  if (summary.lines.percent < thresholds.lines) {
    failures.push(`line coverage ${summary.lines.percent.toFixed(2)}% < ${thresholds.lines}%`);
  }
  if (summary.functions.percent < thresholds.functions) {
    failures.push(
      `function coverage ${summary.functions.percent.toFixed(2)}% < ${thresholds.functions}%`,
    );
  }
  if (failures.length > 0) throw new Error(`Coverage release gate failed: ${failures.join("; ")}.`);
}
