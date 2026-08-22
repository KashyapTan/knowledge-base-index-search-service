import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertCoverageThresholds,
  isGovernedApplicationSource,
  parseLcov,
} from "../src/release/coverage.ts";

const path = resolve(Bun.argv[2] ?? "coverage/lcov.info");
const summary = parseLcov(await readFile(path, "utf8"), isGovernedApplicationSource);
assertCoverageThresholds(summary, { lines: 93, functions: 93 });
console.info(
  `Coverage gate passed for ${summary.files.length} application files: ${summary.lines.percent.toFixed(2)}% lines, ${summary.functions.percent.toFixed(2)}% functions.`,
);
