import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  compareModelBenchmarks,
  parseBenchmarkDefinition,
  renderBenchmarkMarkdown,
  renderModelComparisonMarkdown,
  runLargeRepositoryBenchmark,
  validateBenchmarkPaths,
} from "../src/benchmark/index.ts";

function required(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const selected = index < 0 ? undefined : argv[index + 1];
  if (!selected || selected.startsWith("--")) throw new Error(`${name} is required.`);
  return selected;
}

function optional(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const selected = index < 0 ? undefined : argv[index + 1];
  if (index >= 0 && (!selected || selected.startsWith("--"))) {
    throw new Error(`${name} requires a value.`);
  }
  return selected;
}

const argv = Bun.argv.slice(2);
const root = resolve(required(argv, "--root"));
const outputDir = resolve(required(argv, "--output-dir"));
const definitionPath = resolve(
  optional(argv, "--definition") ??
    resolve(import.meta.dir, "../benchmarks/large-repository-definition.json"),
);
const judgments = optional(argv, "--judgments");
const cacheDir = resolve(optional(argv, "--cache-dir") ?? join(outputDir, "model-cache"));
const allowDownload = argv.includes("--allow-download");
const known = new Set([
  "--root",
  "--output-dir",
  "--definition",
  "--judgments",
  "--cache-dir",
  "--allow-download",
]);
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index] ?? "";
  if (!known.has(argument)) throw new Error(`Unknown model benchmark argument: ${argument}`);
  if (argument !== "--allow-download") index += 1;
}
const comparisonPath = join(outputDir, "model-comparison.json");
await validateBenchmarkPaths({
  root,
  projectDir: resolve(import.meta.dir, ".."),
  stateDir: join(outputDir, "state"),
  cacheDir,
  outputPath: comparisonPath,
});
await mkdir(outputDir, { recursive: true });
const definition = parseBenchmarkDefinition(JSON.parse(await readFile(definitionPath, "utf8")));
const generatedAt = new Date().toISOString();
const shared = {
  root,
  cacheDir,
  definition,
  quantization: "q8" as const,
  allowDownload,
  generatedAt,
  ...(judgments ? { judgmentsPath: resolve(judgments) } : {}),
};
const smallPath = join(outputDir, "bge-small.json");
const small = await runLargeRepositoryBenchmark({
  ...shared,
  outputPath: smallPath,
  stateDir: join(outputDir, "state", "bge-small"),
  modelId: "Xenova/bge-small-en-v1.5",
  vectorDimension: 384,
});
await Promise.all([
  writeFile(smallPath, `${JSON.stringify(small, null, 2)}\n`, { mode: 0o600 }),
  writeFile(join(outputDir, "bge-small.md"), renderBenchmarkMarkdown(small), { mode: 0o600 }),
]);

const basePath = join(outputDir, "bge-base.json");
const base = await runLargeRepositoryBenchmark({
  ...shared,
  outputPath: basePath,
  stateDir: join(outputDir, "state", "bge-base"),
  modelId: "Xenova/bge-base-en-v1.5",
  vectorDimension: 768,
});
await Promise.all([
  writeFile(basePath, `${JSON.stringify(base, null, 2)}\n`, { mode: 0o600 }),
  writeFile(join(outputDir, "bge-base.md"), renderBenchmarkMarkdown(base), { mode: 0o600 }),
]);

const comparison = compareModelBenchmarks(small, base, generatedAt);
await Promise.all([
  writeFile(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, { mode: 0o600 }),
  writeFile(join(outputDir, "model-comparison.md"), renderModelComparisonMarkdown(comparison), {
    mode: 0o600,
  }),
]);
console.info(`Model comparison: ${comparisonPath}`);
