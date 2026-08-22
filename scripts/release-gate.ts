import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  LargeRepositoryBenchmarkReport,
  ModelComparisonReport,
} from "../src/benchmark/index.ts";
import type { ControlledEvaluationRun } from "../src/evaluation/controlled.ts";
import {
  type ReleaseThresholds,
  validateControlledReleaseEvidence,
  validateLargeBenchmarkEvidence,
  validateModelComparisonEvidence,
} from "../src/release/gate.ts";

async function run(
  command: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<void> {
  console.info(`\n> ${command.join(" ")}`);
  const child = Bun.spawn([...command], {
    cwd: resolve(import.meta.dir, ".."),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...Bun.env, ...env },
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Release command failed with exit code ${code}.`);
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const selected = index < 0 ? undefined : argv[index + 1];
  if (index >= 0 && (!selected || selected.startsWith("--")))
    throw new Error(`${name} requires a value.`);
  return selected;
}

const argv = Bun.argv.slice(2);
const full = argv.includes("--full");
const skipCommands = argv.includes("--skip-commands");
const benchmarkPath = option(argv, "--benchmark-report");
const comparisonPath = option(argv, "--model-comparison");
const thresholds = JSON.parse(
  await readFile(resolve(import.meta.dir, "../benchmarks/release-thresholds.json"), "utf8"),
) as ReleaseThresholds;
const temporary = await mkdtemp(join(tmpdir(), "kbiss-release-gate-"));
try {
  if (!skipCommands) {
    for (const command of [
      ["bun", "run", "lint"],
      ["bun", "run", "typecheck"],
      ["bun", "run", "test:coverage"],
      ["bun", "run", "build"],
      ["bun", "run", "test:e2e"],
      ["bun", "run", "smoke:operations"],
    ]) {
      await run(command);
    }
  }
  const controlledPath = join(temporary, "controlled-relevance.json");
  await run(["bun", "run", "scripts/evaluate-relevance.ts", "--output", controlledPath]);
  const controlled = JSON.parse(await readFile(controlledPath, "utf8")) as ControlledEvaluationRun;
  const failures = [...validateControlledReleaseEvidence(controlled, thresholds)];

  if (full) {
    if (!benchmarkPath || !comparisonPath) {
      throw new Error("--full requires --benchmark-report and --model-comparison.");
    }
    const benchmark = JSON.parse(
      await readFile(resolve(benchmarkPath), "utf8"),
    ) as LargeRepositoryBenchmarkReport;
    const comparison = JSON.parse(
      await readFile(resolve(comparisonPath), "utf8"),
    ) as ModelComparisonReport;
    failures.push(
      ...validateLargeBenchmarkEvidence(benchmark, thresholds),
      ...validateModelComparisonEvidence(comparison),
    );
    const cache = Bun.env.KBISS_MODEL_CACHE_DIR;
    if (!cache)
      throw new Error("--full requires KBISS_MODEL_CACHE_DIR for the offline ONNX smoke.");
    await run(["bun", "test", "src/indexing/bge-local.smoke.test.ts"], {
      KBISS_RUN_MODEL_SMOKE: "1",
      KBISS_MODEL_CACHE_DIR: cache,
    });
  }
  if (failures.length > 0) throw new Error(`Release evidence failed:\n- ${failures.join("\n- ")}`);
  console.info(`\nKBISS ${full ? "full" : "core"} release gate passed.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
