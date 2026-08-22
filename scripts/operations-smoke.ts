import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadAppConfig } from "../src/config/index.ts";
import {
  type EmbeddingVectorBatch,
  type EmbeddingWorkerBoundary,
  EmbeddingWorkerError,
  TransformersEmbeddingProvider,
} from "../src/indexing/index.ts";
import { importModelAssetSource, resetLocalState } from "../src/operations/index.ts";

class ControlledModelWorker implements EmbeddingWorkerBoundary {
  readonly #cacheDir: string;
  readonly #dimension: number;

  constructor(cacheDir: string, dimension: number) {
    this.#cacheDir = cacheDir;
    this.#dimension = dimension;
  }

  async initialize(config: { readonly localFilesOnly: boolean }): Promise<void> {
    const output = join(
      this.#cacheDir,
      "Xenova",
      "bge-small-en-v1.5",
      "onnx",
      "model_quantized.onnx",
    );
    if (!(await Bun.file(output).exists())) {
      if (config.localFilesOnly) {
        throw new EmbeddingWorkerError({
          kind: "error",
          requestId: "operations-smoke",
          code: "MODEL_ASSETS_MISSING",
          message: "Controlled assets are missing.",
        });
      }
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, "controlled local smoke asset");
    }
  }

  async embed(texts: readonly string[]): Promise<EmbeddingVectorBatch> {
    const storage = new Float32Array(texts.length * this.#dimension);
    for (let index = 0; index < texts.length; index += 1) storage[index * this.#dimension] = 1;
    return { count: texts.length, dimension: this.#dimension, storage };
  }

  async close(): Promise<void> {}
}

const fixture = await mkdtemp(join(tmpdir(), "kbiss-operations-smoke-"));
try {
  const root = join(fixture, "source");
  const project = join(fixture, "project");
  await Promise.all([mkdir(root), mkdir(project)]);
  await writeFile(join(root, "guide.md"), "# Controlled local smoke fixture\n");
  const loaded = await loadAppConfig({
    argv: ["--root", root, "--embedding-device", "cpu", "--quantization", "q8"],
    env: {
      KBISS_CACHE_DIR: join(fixture, "cache"),
      KBISS_STATE_DIR: join(fixture, "state"),
    },
    homeDir: fixture,
    projectDir: project,
  });
  if (!loaded.ok) throw new Error(loaded.error.message);
  const config = loaded.value;
  const first = new TransformersEmbeddingProvider(config.embedding, config.paths.modelCacheDir, {
    worker: new ControlledModelWorker(config.paths.modelCacheDir, config.embedding.vectorDimension),
  });
  const prepared = await first.warmUp({ allowDownload: true, downloadRetries: 1 });
  await first.shutdown();
  if (!prepared.ok) throw new Error(prepared.error.message);

  const bundle = join(fixture, "portable-model-bundle");
  await cp(config.paths.modelCacheDir, bundle, { recursive: true });
  const reset = await resetLocalState(config, ["model-cache"], { confirmed: true });
  if (!reset.ok) throw new Error(reset.error.message);
  const imported = await importModelAssetSource(config, bundle);
  if (!imported.ok) throw new Error(imported.error.message);

  const offline = new TransformersEmbeddingProvider(config.embedding, config.paths.modelCacheDir, {
    worker: new ControlledModelWorker(config.paths.modelCacheDir, config.embedding.vectorDimension),
  });
  const restarted = await offline.warmUp({ allowDownload: false });
  await offline.shutdown();
  if (!restarted.ok) throw new Error(restarted.error.message);
  console.info("KBISS controlled first-setup and fully offline restart smoke passed.");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
