import { describe, expect, test } from "bun:test";
import { assertCoverageThresholds, isGovernedApplicationSource, parseLcov } from "./coverage.ts";

const lcov = `TN:
SF:src/search/ranking.ts
FNF:4
FNH:3
LF:10
LH:9
end_of_record
TN:
SF:src/search/test-helpers.ts
FNF:2
FNH:0
LF:5
LH:0
end_of_record
`;

describe("suite-wide coverage governance", () => {
  test("aggregates governed source and visibly excludes only test support", () => {
    const summary = parseLcov(lcov, isGovernedApplicationSource);
    expect(summary.files.map((file) => file.path)).toEqual(["src/search/ranking.ts"]);
    expect(summary.lines.percent).toBe(90);
    expect(summary.functions.percent).toBe(75);
    expect(isGovernedApplicationSource("src/ui/styles.css")).toBe(true);
    expect(isGovernedApplicationSource("src/search/ranking.test.ts")).toBe(false);
    expect(isGovernedApplicationSource("src/search/fixtures/worker.ts")).toBe(false);
  });

  test("fails malformed reports and thresholds below either governed target", () => {
    expect(() => parseLcov("SF:src/a.ts\nFNF:nope\nFNH:0\nLF:1\nLH:1\nend_of_record")).toThrow();
    expect(() =>
      parseLcov("SF:test.ts\nFNF:1\nFNH:1\nLF:1\nLH:1\nend_of_record", () => false),
    ).toThrow();
    const summary = parseLcov(lcov, isGovernedApplicationSource);
    expect(() => assertCoverageThresholds(summary, { lines: 93, functions: 93 })).toThrow(
      /line coverage.*function coverage/u,
    );
    expect(() => assertCoverageThresholds(summary, { lines: 90, functions: 75 })).not.toThrow();
  });
});
