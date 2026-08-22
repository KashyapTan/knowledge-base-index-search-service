import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { AutoTokenizer } from "@huggingface/transformers";
import * as lancedb from "@lancedb/lancedb";
import type { AppConfig } from "../config/index.ts";
import { loadAppConfig } from "../config/index.ts";
import {
  createDiscoveryService,
  type DiscoveredFile,
  type FileManifest,
} from "../discovery/index.ts";
import { evaluateJudgments, loadJudgmentSet } from "../evaluation/index.ts";
import { createExtractionPipeline, createTransformersTokenCounter } from "../extraction/index.ts";
import {
  CHUNKS_TABLE,
  createIndexingService,
  createTransformersEmbeddingProvider,
  type EmbeddingProvider,
  type LanceIndexStore,
  openLanceIndex,
} from "../indexing/index.ts";
import { pinnedDependencyVersions } from "../operations/index.ts";
import {
  createSearchService,
  type LanceCandidateRetriever,
  openLanceCandidateRetriever,
  type SearchResponse,
} from "../search/index.ts";
import { SafeFileAccess } from "../server/file-access.ts";
import { runGrep } from "../ui/viewer/grep.ts";
import type {
  BenchmarkDefinition,
  LargeRepositoryBenchmarkReport,
  QueryBenchmark,
  TimingKey,
} from "./contracts.ts";
import { summarizeDistribution } from "./statistics.ts";

interface BenchmarkRunOptions {
  readonly root: string;
  readonly stateDir: string;
  readonly cacheDir: string;
  readonly outputPath: string;
  readonly definition: BenchmarkDefinition;
  readonly modelId: string;
  readonly vectorDimension: number;
  readonly quantization: "q8";
  readonly allowDownload: boolean;
  readonly judgmentsPath?: string;
  readonly generatedAt?: string;
}

function expectOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function isInside(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export async function validateBenchmarkPaths(options: {
  readonly root: string;
  readonly stateDir: string;
  readonly cacheDir: string;
  readonly outputPath: string;
  readonly projectDir: string;
}): Promise<void> {
  const lexicalRoot = resolve(options.root);
  const lexicalProject = resolve(options.projectDir);
  const root = await realpath(options.root);
  const project = await realpath(options.projectDir);
  for (const [label, candidate] of [
    ["state", resolve(options.stateDir)],
    ["cache", resolve(options.cacheDir)],
    ["output", resolve(options.outputPath)],
  ] as const) {
    if (
      isInside(lexicalRoot, candidate) ||
      isInside(root, candidate) ||
      isInside(lexicalProject, candidate) ||
      isInside(project, candidate)
    ) {
      throw new Error(`Benchmark ${label} data must be outside the source and KBISS repositories.`);
    }
  }
}

export function parseBenchmarkDefinition(value: unknown): BenchmarkDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The benchmark definition must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    !Array.isArray(record.ignorePatterns) ||
    !record.ignorePatterns.every((item) => typeof item === "string" && item.trim()) ||
    !Array.isArray(record.queries) ||
    record.queries.length === 0 ||
    !record.queries.every((item) => typeof item === "string" && item.trim()) ||
    !Number.isInteger(record.warmRuns) ||
    Number(record.warmRuns) < 10 ||
    !Number.isInteger(record.annThreshold) ||
    Number(record.annThreshold) < 1
  ) {
    throw new Error("The benchmark definition is incomplete or invalid.");
  }
  return {
    schemaVersion: 1,
    ignorePatterns: record.ignorePatterns as string[],
    queries: record.queries as string[],
    warmRuns: Number(record.warmRuns),
    annThreshold: Number(record.annThreshold),
  };
}

async function measure<T>(operation: () => Promise<T>): Promise<{ value: T; elapsedMs: number }> {
  const startedAt = performance.now();
  const value = await operation();
  return { value, elapsedMs: performance.now() - startedAt };
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  async function visit(current: string): Promise<void> {
    const info = await lstat(current).catch(() => undefined);
    if (!info) return;
    if (info.isFile()) {
      total += info.size;
      return;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    for (const entry of await readdir(current)) await visit(join(current, entry));
  }
  await visit(path);
  return total;
}

async function gitValue(root: string, args: readonly string[]): Promise<string | undefined> {
  const process = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(process.stdout).text();
  return (await process.exited) === 0 ? output.trim() : undefined;
}

async function loopbackReadyMs(): Promise<number> {
  const startedAt = performance.now();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("<!doctype html><title>KBISS</title>", { status: 200 }),
  });
  try {
    const response = await fetch(server.url);
    await response.text();
    return performance.now() - startedAt;
  } finally {
    await server.stop(true);
  }
}

class MemorySampler {
  #peak = process.memoryUsage().rss;
  readonly #timer: ReturnType<typeof setInterval>;

  constructor() {
    this.#timer = setInterval(() => {
      this.#peak = Math.max(this.#peak, process.memoryUsage().rss);
    }, 50);
  }

  stop(): number {
    clearInterval(this.#timer);
    this.#peak = Math.max(this.#peak, process.memoryUsage().rss);
    return this.#peak;
  }
}

async function chunkTokenCounts(config: AppConfig): Promise<number[]> {
  const connection = await lancedb.connect(config.paths.lanceDbDir);
  try {
    const chunks = await connection.openTable(CHUNKS_TABLE);
    try {
      const rows = (await chunks.query().select(["token_count"]).toArray()) as Record<
        string,
        unknown
      >[];
      return rows.map((row) => Number(row.token_count)).filter(Number.isFinite);
    } finally {
      chunks.close();
    }
  } finally {
    connection.close();
  }
}

function queryBenchmark(label: string, responses: readonly SearchResponse[]): QueryBenchmark {
  const timing = (key: TimingKey) =>
    summarizeDistribution(responses.map((response) => response.timing[key]));
  return {
    queryLabel: label,
    totalMs: timing("totalMs"),
    embeddingMs: timing("embeddingMs"),
    retrievalMs: timing("retrievalMs"),
    vectorMs: timing("vectorMs"),
    bm25Ms: timing("bm25Ms"),
    metadataMs: timing("metadataMs"),
    fusionMs: timing("fusionMs"),
    aggregationMs: timing("aggregationMs"),
    returnedFiles: responses.at(-1)?.results.length ?? 0,
  };
}

async function measureViewer(
  config: AppConfig,
  manifest: FileManifest,
  files: readonly DiscoveredFile[],
): Promise<LargeRepositoryBenchmarkReport["viewer"]> {
  const candidates = files
    .filter((file) => file.readStatus === "ready" && file.fingerprint.size <= 64 * 1024 * 1024)
    .toSorted((left, right) => left.fingerprint.size - right.fingerprint.size);
  const small = candidates[0];
  const large = candidates.at(-1);
  if (!small || !large) throw new Error("The corpus has no viewable files for viewer benchmarks.");
  const access = new SafeFileAccess(config.sourceRoots[0], manifest);
  const openOne = async (file: DiscoveredFile) => {
    const opened = await measure(async () => {
      const response = expectOk(await access.content(file.fileId));
      return response.text();
    });
    const grep = await measure(async () => {
      runGrep(opened.value, { query: "error", regex: false, caseSensitive: false });
    });
    return { bytes: file.fingerprint.size, openMs: opened.elapsedMs, grepMs: grep.elapsedMs };
  };
  const [smallResult, largeResult] = await Promise.all([openOne(small), openOne(large)]);
  return {
    smallFileBytes: smallResult.bytes,
    smallOpenMs: smallResult.openMs,
    smallGrepMs: smallResult.grepMs,
    largeFileBytes: largeResult.bytes,
    largeOpenMs: largeResult.openMs,
    largeGrepMs: largeResult.grepMs,
  };
}

async function runIncrementalFixture(
  config: AppConfig,
  embeddings: EmbeddingProvider,
  tokenizer: ReturnType<typeof createTransformersTokenCounter>,
  representative: DiscoveredFile,
): Promise<LargeRepositoryBenchmarkReport["incrementalFixture"]> {
  const temporary = await mkdtemp(join(dirname(config.paths.applicationStateDir), "mutation-"));
  let store: LanceIndexStore | undefined;
  try {
    const root = join(temporary, "source");
    await mkdir(root, { recursive: true });
    const extension = extname(representative.relativePath) || ".txt";
    const original = join(root, `representative${extension}`);
    await copyFile(representative.canonicalPath, original);
    const loaded = await loadAppConfig({
      argv: [
        "--root",
        root,
        "--model",
        config.embedding.modelId,
        "--quantization",
        config.embedding.quantization,
        "--vector-dimension",
        String(config.embedding.vectorDimension),
      ],
      env: {
        KBISS_STATE_DIR: join(temporary, "state"),
        KBISS_CACHE_DIR: config.paths.applicationCacheDir,
      },
      projectDir: resolve(import.meta.dir, "../.."),
    });
    const fixtureConfig = expectOk(loaded);
    const discovery = expectOk(await createDiscoveryService(fixtureConfig));
    store = expectOk(await openLanceIndex(fixtureConfig));
    const extraction = createExtractionPipeline(
      fixtureConfig,
      tokenizer,
      embeddings.identity.maximumTokens,
    );
    const indexing = createIndexingService(fixtureConfig, { extraction, embeddings, store });
    const initial = expectOk(await discovery.scanner.scan("scan"));
    expectOk(await indexing.indexFiles(initial.files));

    const content = await readFile(original, "utf8");
    const pending = `${original}.pending`;
    await writeFile(pending, `${content}\nPlan 11 incremental benchmark marker.\n`);
    await rename(pending, original);
    const update = await measure(async () => {
      const scan = expectOk(await discovery.scanner.scan("reconcile"));
      expectOk(await indexing.applyChanges(scan.changes));
    });

    const deletion = await measure(async () => {
      await unlink(original);
      const scan = expectOk(await discovery.scanner.scan("reconcile"));
      expectOk(await indexing.applyChanges(scan.changes));
    });

    await copyFile(representative.canonicalPath, original);
    let scan = expectOk(await discovery.scanner.scan("reconcile"));
    expectOk(await indexing.applyChanges(scan.changes));
    const renamed = join(root, `renamed-representative${extension}`);
    const renameResult = await measure(async () => {
      await rename(original, renamed);
      scan = expectOk(await discovery.scanner.scan("reconcile"));
      expectOk(await indexing.applyChanges(scan.changes));
    });
    return {
      sourceWasExternalCopy: true,
      updateMs: update.elapsedMs,
      deleteMs: deletion.elapsedMs,
      renameMs: renameResult.elapsedMs,
    };
  } finally {
    store?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

function countsBy<T>(values: readonly T[], key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const name = key(value);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export async function runLargeRepositoryBenchmark(
  options: BenchmarkRunOptions,
): Promise<LargeRepositoryBenchmarkReport> {
  const canonicalRoot = await realpath(options.root);
  const projectDir = resolve(import.meta.dir, "../..");
  await validateBenchmarkPaths({ ...options, root: canonicalRoot, projectDir });
  const gitRevision = await gitValue(canonicalRoot, ["rev-parse", "HEAD"]);
  const gitStatusBefore = await gitValue(canonicalRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  const browserReady = await loopbackReadyMs();
  const loaded = await loadAppConfig({
    argv: [
      "--root",
      canonicalRoot,
      "--model",
      options.modelId,
      "--quantization",
      options.quantization,
      "--vector-dimension",
      String(options.vectorDimension),
    ],
    env: { KBISS_STATE_DIR: options.stateDir, KBISS_CACHE_DIR: options.cacheDir },
    projectDir,
  });
  const config = expectOk(loaded);
  const embeddings = createTransformersEmbeddingProvider(config);
  const memory = new MemorySampler();
  let store: LanceIndexStore | undefined;
  let retriever: LanceCandidateRetriever | undefined;
  try {
    const modelLoad = await measure(async () =>
      expectOk(
        await embeddings.warmUp({
          allowDownload: options.allowDownload,
          downloadRetries: 3,
          recoverCorruptAssets: options.allowDownload,
        }),
      ),
    );
    const tokenizerLoad = await measure(async () => {
      const tokenizer = await AutoTokenizer.from_pretrained(config.embedding.modelId, {
        cache_dir: config.paths.modelCacheDir,
        local_files_only: true,
      });
      return createTransformersTokenCounter(tokenizer);
    });
    const discovery = expectOk(
      await createDiscoveryService(config, {
        scanner: { ignorePatterns: options.definition.ignorePatterns },
      }),
    );
    const initialScan = await measure(async () => expectOk(await discovery.scanner.scan("scan")));
    store = expectOk(
      await openLanceIndex(config, { annThreshold: options.definition.annThreshold }),
    );
    const extraction = createExtractionPipeline(
      config,
      tokenizerLoad.value,
      embeddings.identity.maximumTokens,
    );
    const indexing = createIndexingService(config, { extraction, embeddings, store });
    const initialIndex = await measure(async () =>
      expectOk(await indexing.indexFiles(initialScan.value.files)),
    );
    const tokens = await chunkTokenCounts(config);
    const noChange = await measure(async () => {
      const scan = expectOk(await discovery.scanner.scan("reconcile"));
      return expectOk(await indexing.indexFiles(scan.files));
    });
    retriever = expectOk(await openLanceCandidateRetriever(config));
    const search = createSearchService({ embeddings, retriever });
    const queries: QueryBenchmark[] = [];
    for (const [index, query] of options.definition.queries.entries()) {
      expectOk(await search.search({ query, fileCount: 10 }));
      const responses: SearchResponse[] = [];
      for (let run = 0; run < options.definition.warmRuns; run += 1) {
        responses.push(expectOk(await search.search({ query, fileCount: 10 })));
      }
      queries.push(queryBenchmark(`query-${String(index + 1).padStart(2, "0")}`, responses));
    }
    const relevance = options.judgmentsPath
      ? await evaluateJudgments(
          await loadJudgmentSet(options.judgmentsPath),
          async (query, fileCount) => expectOk(await search.search({ query, fileCount })),
          {
            generatedAt: options.generatedAt ?? new Date().toISOString(),
            settings: {
              model: config.embedding,
              chunking: config.index,
              search: "DEFAULT_SEARCH_CONFIG",
            },
          },
        )
      : null;
    const viewer = await measureViewer(config, discovery.manifest, initialScan.value.files);
    const representative = initialScan.value.files
      .filter((file) => file.readStatus === "ready" && file.fingerprint.size > 0)
      .toSorted((left, right) => left.fingerprint.size - right.fingerprint.size)[0];
    if (!representative) throw new Error("No supported file is available for incremental timing.");
    const incrementalFixture = await runIncrementalFixture(
      config,
      embeddings,
      tokenizerLoad.value,
      representative,
    );
    const peakRssBytes = memory.stop();
    const gitStatusAfter = await gitValue(canonicalRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const files = initialScan.value.files;
    const readyFiles = files.filter((file) => file.readStatus === "ready");
    const failedFiles = files.filter((file) =>
      ["unreadable", "unsafe", "malformed"].includes(file.readStatus),
    );
    const skippedFiles = files.filter((file) => file.readStatus !== "ready").length;
    const dependencies = await pinnedDependencyVersions();
    const cpuList = cpus();
    const report: LargeRepositoryBenchmarkReport = {
      schemaVersion: 1,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      corpus: {
        rootIdentity: config.sourceRoots[0].identity,
        revision: gitRevision || null,
        dirty: gitStatusBefore === undefined ? null : gitStatusBefore.length > 0,
        supportedFileCount: readyFiles.length,
        totalBytes: readyFiles.reduce((sum, file) => sum + file.fingerprint.size, 0),
        formatDistribution: countsBy(readyFiles, (file) => file.format),
        readyFiles: readyFiles.length,
        skippedFiles,
        failedFiles: failedFiles.length,
        failureReasons: countsBy(failedFiles, (file) => file.lastError ?? file.readStatus),
        readOnlyVerification: {
          stateOutsideSource: !isInside(canonicalRoot, config.paths.applicationStateDir),
          outputOutsideSource: !isInside(canonicalRoot, resolve(options.outputPath)),
          gitStatusUnchanged:
            gitStatusBefore === undefined || gitStatusAfter === undefined
              ? null
              : gitStatusBefore === gitStatusAfter,
        },
      },
      environment: {
        os: `${platform()} ${release()}`,
        architecture: process.arch,
        cpu: cpuList[0]?.model ?? "unknown",
        logicalCpus: cpuList.length,
        totalMemoryBytes: totalmem(),
        bunVersion: Bun.version,
        dependencies,
      },
      settings: {
        modelId: config.embedding.modelId,
        quantization: config.embedding.quantization,
        vectorDimension: config.embedding.vectorDimension,
        chunkSizeTokens: config.index.chunkSizeTokens,
        chunkOverlapTokens: config.index.chunkOverlapTokens,
        extractorVersion: config.index.extractorVersion,
        chunkerVersion: config.index.chunkerVersion,
        indexSchemaVersion: config.index.schemaVersion,
        annThreshold: options.definition.annThreshold,
        indexStrategy: tokens.length >= options.definition.annThreshold ? "ivf-flat" : "exact",
        ignorePatterns: options.definition.ignorePatterns,
      },
      startup: {
        loopbackBrowserReadyMs: browserReady,
        modelLoadMs: modelLoad.elapsedMs,
        tokenizerLoadMs: tokenizerLoad.elapsedMs,
        initialScanMs: initialScan.elapsedMs,
      },
      indexing: {
        initialWallMs: initialIndex.elapsedMs,
        chunksPerSecond:
          initialIndex.elapsedMs === 0
            ? 0
            : initialIndex.value.progress.committedChunks / (initialIndex.elapsedMs / 1_000),
        extractedChunkCount: tokens.length,
        embeddedChunks: initialIndex.value.progress.embeddedChunks,
        reusedChunks: initialIndex.value.progress.reusedChunks,
        changedFiles:
          initialIndex.value.progress.totalFiles -
          initialIndex.value.progress.unchangedFiles -
          initialIndex.value.progress.skippedFiles -
          initialIndex.value.progress.failedFiles,
        skippedFiles: initialIndex.value.progress.skippedFiles,
        failedFiles: initialIndex.value.progress.failedFiles,
        errors: initialIndex.value.progress.errors,
        tokenDistribution: summarizeDistribution(tokens),
        noChangeReconciliationMs: noChange.elapsedMs,
        noChangeFiles: noChange.value.progress.unchangedFiles,
      },
      memory: {
        peakRssBytes,
        steadyRssBytes: process.memoryUsage().rss,
      },
      storage: {
        indexBytes: await directoryBytes(config.paths.indexDir),
        modelCacheBytes: await directoryBytes(config.paths.modelCacheDir),
      },
      queries,
      viewer,
      incrementalFixture,
      relevance,
    };
    if (report.corpus.readOnlyVerification.gitStatusUnchanged === false) {
      throw new Error("The source repository changed while the read-only benchmark was running.");
    }
    return report;
  } finally {
    memory.stop();
    retriever?.close();
    store?.close();
    await embeddings.shutdown();
  }
}
