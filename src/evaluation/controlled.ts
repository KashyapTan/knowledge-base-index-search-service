import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAppConfig } from "../config/index.ts";
import { createDiscoveryService } from "../discovery/index.ts";
import { createExtractionPipeline, createUnicodeWordTokenCounter } from "../extraction/index.ts";
import { createIndexingService, type LanceIndexStore, openLanceIndex } from "../indexing/index.ts";
import {
  createSearchService,
  type LanceCandidateRetriever,
  openLanceCandidateRetriever,
} from "../search/index.ts";
import type { RelevanceEvaluationReport } from "./contracts.ts";
import { FixtureSemanticEmbeddingProvider } from "./fixture-embedding-provider.ts";
import { loadJudgmentSet } from "./judgments.ts";
import { evaluateJudgments } from "./metrics.ts";

export interface ControlledEvaluationEvidence {
  readonly discoveredFiles: number;
  readonly indexedChunks: number;
  readonly unchangedFilesOnSecondPass: number;
  readonly failedFiles: number;
}

export interface ControlledEvaluationRun {
  readonly report: RelevanceEvaluationReport;
  readonly evidence: ControlledEvaluationEvidence;
}

function expectOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export async function runControlledEvaluation(
  options: {
    readonly fixtureRoot?: string;
    readonly judgmentsPath?: string;
    readonly generatedAt?: string;
  } = {},
): Promise<ControlledEvaluationRun> {
  const fixtureRoot = await realpath(
    options.fixtureRoot ?? resolve(import.meta.dir, "../../fixtures/relevance/repository"),
  );
  const judgmentsPath =
    options.judgmentsPath ?? resolve(import.meta.dir, "../../fixtures/relevance/judgments.json");
  const temporary = await mkdtemp(join(tmpdir(), "kbiss-controlled-evaluation-"));
  const embeddings = new FixtureSemanticEmbeddingProvider();
  let store: LanceIndexStore | undefined;
  let retriever: LanceCandidateRetriever | undefined;
  try {
    const loaded = await loadAppConfig({
      argv: [
        "--root",
        fixtureRoot,
        "--model",
        embeddings.identity.modelId,
        "--embedding-device",
        embeddings.identity.device,
        "--quantization",
        embeddings.identity.quantization,
        "--vector-dimension",
        String(embeddings.identity.vectorDimension),
      ],
      env: {
        KBISS_STATE_DIR: join(temporary, "state"),
        KBISS_CACHE_DIR: join(temporary, "cache"),
      },
      projectDir: resolve(import.meta.dir, "../.."),
    });
    const config = expectOk(loaded);
    const discovery = expectOk(await createDiscoveryService(config));
    const scan = expectOk(await discovery.scanner.scan("scan"));
    store = expectOk(await openLanceIndex(config));
    const extraction = createExtractionPipeline(
      config,
      createUnicodeWordTokenCounter(),
      embeddings.identity.maximumTokens,
    );
    const indexing = createIndexingService(config, { extraction, embeddings, store });
    const first = expectOk(await indexing.indexFiles(scan.files));
    const secondScan = expectOk(await discovery.scanner.scan("reconcile"));
    const second = expectOk(await indexing.indexFiles(secondScan.files));
    retriever = expectOk(await openLanceCandidateRetriever(config));
    const search = createSearchService({ embeddings, retriever });
    const judgments = await loadJudgmentSet(judgmentsPath);
    const report = await evaluateJudgments(
      judgments,
      async (query, fileCount) => expectOk(await search.search({ query, fileCount })),
      {
        ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
        settings: {
          embedding: embeddings.identity,
          chunking: config.index,
          search: "DEFAULT_SEARCH_CONFIG",
        },
      },
    );
    return {
      report,
      evidence: {
        discoveredFiles: scan.files.length,
        indexedChunks: first.progress.committedChunks,
        unchangedFilesOnSecondPass: second.progress.unchangedFiles,
        failedFiles: first.progress.failedFiles,
      },
    };
  } finally {
    retriever?.close();
    store?.close();
    await embeddings.shutdown();
    await rm(temporary, { recursive: true, force: true });
  }
}
