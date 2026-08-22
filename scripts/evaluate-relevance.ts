import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runControlledEvaluation } from "../src/evaluation/index.ts";

function outputPath(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--output");
  const value = index < 0 ? undefined : argv[index + 1];
  if (index >= 0 && !value) throw new Error("--output requires a JSON file path.");
  const unknown = argv.filter(
    (_argument, position) => position !== index && position !== index + 1,
  );
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  return value ? resolve(value) : undefined;
}

const destination = outputPath(Bun.argv.slice(2));
const run = await runControlledEvaluation();
const serialized = `${JSON.stringify(run, null, 2)}\n`;
if (destination) {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, serialized, { mode: 0o600 });
  console.info(`Controlled relevance report: ${destination}`);
} else {
  process.stdout.write(serialized);
}
const { metrics } = run.report;
console.info(
  `Recall@5 ${(metrics.recallAt5 * 100).toFixed(1)}% | Recall@10 ${(metrics.recallAt10 * 100).toFixed(1)}% | MRR ${metrics.meanReciprocalRank.toFixed(3)}`,
);
if (metrics.recallAt5 < 0.9 || metrics.recallAt10 < 0.95 || metrics.meanReciprocalRank < 0.8) {
  throw new Error("Controlled relevance metrics are below the release thresholds.");
}
