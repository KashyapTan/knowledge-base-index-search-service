import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  parseBenchmarkDefinition,
  renderBenchmarkMarkdown,
  runLargeRepositoryBenchmark,
} from "../src/benchmark/index.ts";
import { BGE_MODEL_PROFILES } from "../src/indexing/index.ts";

interface Cli {
  readonly root: string;
  readonly output: string;
  readonly stateDir: string;
  readonly cacheDir: string;
  readonly definition: string;
  readonly modelId: string;
  readonly vectorDimension: number;
  readonly judgments?: string;
  readonly allowDownload: boolean;
  readonly resume: boolean;
}

function value(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const selected = argv[index + 1];
  if (!selected || selected.startsWith("--")) throw new Error(`${name} requires a value.`);
  return selected;
}

function parseCli(argv: readonly string[]): Cli {
  const root = value(argv, "--root");
  const outputValue = value(argv, "--output");
  if (!root || !outputValue) throw new Error("--root and --output are required.");
  const output = resolve(outputValue);
  const modelId = value(argv, "--model") ?? "Xenova/bge-small-en-v1.5";
  const profile = BGE_MODEL_PROFILES[modelId as keyof typeof BGE_MODEL_PROFILES];
  const vectorDimension = Number(value(argv, "--vector-dimension") ?? profile?.vectorDimension);
  if (!Number.isInteger(vectorDimension) || vectorDimension < 1) {
    throw new Error("--vector-dimension is required for an unknown model.");
  }
  const known = new Set([
    "--root",
    "--output",
    "--state-dir",
    "--cache-dir",
    "--definition",
    "--model",
    "--vector-dimension",
    "--judgments",
    "--allow-download",
    "--resume",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!known.has(argument)) throw new Error(`Unknown benchmark argument: ${argument}`);
    if (!["--allow-download", "--resume"].includes(argument)) index += 1;
  }
  const runName = basename(output).replace(/\.[^.]+$/u, "");
  return {
    root: resolve(root),
    output,
    stateDir: resolve(value(argv, "--state-dir") ?? join(dirname(output), "state", runName)),
    cacheDir: resolve(value(argv, "--cache-dir") ?? join(dirname(output), "model-cache")),
    definition: resolve(
      value(argv, "--definition") ??
        resolve(import.meta.dir, "../benchmarks/large-repository-definition.json"),
    ),
    modelId,
    vectorDimension,
    ...(value(argv, "--judgments")
      ? { judgments: resolve(value(argv, "--judgments") as string) }
      : {}),
    allowDownload: argv.includes("--allow-download"),
    resume: argv.includes("--resume"),
  };
}

const cli = parseCli(Bun.argv.slice(2));
if (!cli.resume) {
  const existing = await readdir(cli.stateDir).catch(() => []);
  if (existing.length > 0) {
    throw new Error("The benchmark state directory is not empty; use a fresh path or --resume.");
  }
}
const definition = parseBenchmarkDefinition(JSON.parse(await readFile(cli.definition, "utf8")));
await mkdir(dirname(cli.output), { recursive: true });
const report = await runLargeRepositoryBenchmark({
  root: cli.root,
  stateDir: cli.stateDir,
  cacheDir: cli.cacheDir,
  outputPath: cli.output,
  definition,
  modelId: cli.modelId,
  vectorDimension: cli.vectorDimension,
  quantization: "q8",
  allowDownload: cli.allowDownload,
  ...(cli.judgments ? { judgmentsPath: cli.judgments } : {}),
});
await Promise.all([
  writeFile(cli.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }),
  writeFile(cli.output.replace(/\.json$/u, ".md"), renderBenchmarkMarkdown(report), {
    mode: 0o600,
  }),
]);
console.info(`Large-repository report: ${cli.output}`);
