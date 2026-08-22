import { availableParallelism } from "node:os";
import type { AppConfig, EmbeddingConfig } from "../config/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type {
  EmbeddingError,
  EmbeddingIdentity,
  EmbeddingProvider,
  EmbedOptions,
  ModelWarmUpOptions,
} from "./contracts.ts";
import { EmbeddingWorkerClient, EmbeddingWorkerError } from "./embedding-worker-client.ts";
import {
  inspectModelAssets,
  quarantineModelCache,
  verifyOrWriteModelAssetManifest,
} from "./model-assets.ts";

export const BGE_MODEL_PROFILES = Object.freeze({
  "Xenova/bge-small-en-v1.5": { maximumTokens: 512, vectorDimension: 384 },
  "Xenova/bge-base-en-v1.5": { maximumTokens: 512, vectorDimension: 768 },
} as const);

export interface EmbeddingWorkerBoundary {
  initialize(config: {
    readonly device: EmbeddingConfig["device"];
    readonly modelId: string;
    readonly dtype: EmbeddingConfig["quantization"];
    readonly expectedDimension: number;
    readonly cacheDir: string;
    readonly localFilesOnly: boolean;
  }): Promise<void>;
  embed(texts: readonly string[], maximumTokens?: number): Promise<readonly (readonly number[])[]>;
  close(): Promise<void>;
}

interface QueueJob {
  readonly texts: readonly string[];
  readonly maximumTokens?: number;
  readonly signal?: AbortSignal;
  readonly resolve: (result: Result<readonly (readonly number[])[], EmbeddingError>) => void;
}

interface EmbeddingBatch {
  readonly texts: readonly string[];
  readonly indices: readonly number[];
  readonly maximumTokens?: number;
}

export const ACCELERATOR_TOKEN_BUCKETS = Object.freeze([64, 128, 256, 384, 512] as const);

export function acceleratorTokenBucket(tokenCount: number, maximumTokens: number): number {
  return (
    ACCELERATOR_TOKEN_BUCKETS.find(
      (candidate) => candidate >= tokenCount && candidate <= maximumTokens,
    ) ?? maximumTokens
  );
}

function embeddingFailure(code: EmbeddingError["code"], message: string): EmbeddingError {
  return { code, message };
}

function mapWorkerError(error: unknown): EmbeddingError {
  if (error instanceof EmbeddingWorkerError) {
    const code = error.code === "INVALID_REQUEST" ? "INFERENCE_FAILED" : error.code;
    return embeddingFailure(code, error.message);
  }
  return embeddingFailure(
    "INFERENCE_FAILED",
    error instanceof Error ? error.message : "Local embedding inference failed.",
  );
}

function vectorNorm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly identity: EmbeddingIdentity;
  readonly batchSize: number;
  readonly #cacheDir: string;
  readonly #workers: readonly EmbeddingWorkerBoundary[];
  readonly #availableWorkers: EmbeddingWorkerBoundary[];
  readonly #activeWorkers = new Set<EmbeddingWorkerBoundary>();
  readonly #maxQueue: number;
  readonly #queue: QueueJob[] = [];
  readonly #idleWaiters: Array<() => void> = [];
  #closed = false;
  #ready = false;
  #shutdownPromise: Promise<void> | undefined;

  constructor(
    embedding: EmbeddingConfig,
    cacheDir: string,
    options: {
      readonly batchSize?: number;
      readonly maximumTokens?: number;
      readonly maxQueue?: number;
      readonly worker?: EmbeddingWorkerBoundary;
      readonly workerCount?: number;
      readonly workerFactory?: () => EmbeddingWorkerBoundary;
    } = {},
  ) {
    const profile = BGE_MODEL_PROFILES[embedding.modelId as keyof typeof BGE_MODEL_PROFILES];
    this.identity = {
      device: embedding.device,
      modelId: embedding.modelId,
      quantization: embedding.quantization,
      vectorDimension: embedding.vectorDimension,
      maximumTokens: options.maximumTokens ?? profile?.maximumTokens ?? 512,
      normalization: embedding.normalization,
    };
    this.batchSize = options.batchSize ?? 16;
    this.#maxQueue = options.maxQueue ?? 8;
    this.#cacheDir = cacheDir;
    const workerCount = Math.max(1, Math.min(4, options.workerCount ?? 1));
    this.#workers = options.worker
      ? [options.worker]
      : Array.from(
          { length: workerCount },
          () => options.workerFactory?.() ?? new EmbeddingWorkerClient(),
        );
    this.#availableWorkers = [...this.#workers];
  }

  encodeDocument(text: string): string {
    return text;
  }

  encodeQuery(text: string): string {
    // Plan 11 retained the BGE v1.5 instruction-free convention used by both benchmarked models.
    return text;
  }

  async warmUp(options: ModelWarmUpOptions = {}): Promise<Result<void, EmbeddingError>> {
    if (this.#closed)
      return err(
        embeddingFailure("EMBEDDING_PROVIDER_CLOSED", "The embedding provider is closed."),
      );
    if (this.#ready) return ok(undefined);
    const progress = options.onProgress ?? (() => undefined);
    progress("verifying", "Verifying local model assets.");
    const inspection = await inspectModelAssets(this.#cacheDir, this.identity);
    let downloadRequired = inspection.state === "missing";
    if (inspection.state === "corrupt") {
      if (!options.allowDownload || !options.recoverCorruptAssets) {
        return err(embeddingFailure("MODEL_ASSETS_INVALID", inspection.message));
      }
      progress("recovering", "Preserving the corrupt cache before reacquiring model assets.");
      const quarantined = await quarantineModelCache(this.#cacheDir);
      if (!quarantined.ok) return quarantined;
      downloadRequired = true;
    }
    if (downloadRequired) {
      if (!options.allowDownload) {
        return err(
          embeddingFailure(
            "MODEL_ASSETS_MISSING",
            "Local model assets are unavailable in offline mode. Run bun run model:setup while online or import a controlled local asset source.",
          ),
        );
      }
      const attempts = Math.max(1, Math.min(5, options.downloadRetries ?? 2));
      let downloadError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        progress(
          "downloading",
          `Downloading the pinned model (${attempt}/${attempts}); existing verified assets remain local.`,
        );
        try {
          await this.#workers[0]?.initialize({
            device: this.identity.device,
            modelId: this.identity.modelId,
            dtype: this.identity.quantization,
            expectedDimension: this.identity.vectorDimension,
            cacheDir: this.#cacheDir,
            localFilesOnly: false,
          });
          downloadError = undefined;
          break;
        } catch (error) {
          downloadError = error;
        }
      }
      if (downloadError) return err(mapWorkerError(downloadError));
    } else {
      try {
        progress("loading-local", "Loading the model from the local cache.");
        await this.#workers[0]?.initialize({
          device: this.identity.device,
          modelId: this.identity.modelId,
          dtype: this.identity.quantization,
          expectedDimension: this.identity.vectorDimension,
          cacheDir: this.#cacheDir,
          localFilesOnly: true,
        });
      } catch (error) {
        return err(mapWorkerError(error));
      }
    }
    try {
      await Promise.all(
        this.#workers.slice(1).map((worker) =>
          worker.initialize({
            device: this.identity.device,
            modelId: this.identity.modelId,
            dtype: this.identity.quantization,
            expectedDimension: this.identity.vectorDimension,
            cacheDir: this.#cacheDir,
            localFilesOnly: true,
          }),
        ),
      );
    } catch (error) {
      return err(mapWorkerError(error));
    }
    const manifest = await verifyOrWriteModelAssetManifest(
      this.#cacheDir,
      this.identity,
      "write-if-missing",
    );
    if (!manifest.ok) return manifest;
    this.#ready = true;
    progress("ready", "Local model assets are verified and ready for offline use.");
    return ok(undefined);
  }

  async embedDocuments(
    texts: readonly string[],
    options: EmbedOptions = {},
  ): Promise<Result<readonly (readonly number[])[], EmbeddingError>> {
    if (this.#closed)
      return err(
        embeddingFailure("EMBEDDING_PROVIDER_CLOSED", "The embedding provider is closed."),
      );
    if (!this.#ready)
      return err(
        embeddingFailure("MODEL_ASSETS_MISSING", "Warm up the local model before indexing."),
      );
    if (options.signal?.aborted)
      return err(embeddingFailure("EMBEDDING_CANCELLED", "Embedding was cancelled."));
    if (texts.length === 0) return ok([]);
    if (options.tokenCounts && options.tokenCounts.length !== texts.length) {
      return err(
        embeddingFailure(
          "INFERENCE_FAILED",
          "Embedding token counts must align one-to-one with the input texts.",
        ),
      );
    }

    const batches = this.#createBatches(texts, options.tokenCounts);
    const vectors: Array<readonly number[] | undefined> = new Array(texts.length);
    let nextBatch = 0;
    let completed = 0;
    let firstError: EmbeddingError | undefined;
    const run = async () => {
      while (!firstError) {
        const index = nextBatch;
        nextBatch += 1;
        const batch = batches[index];
        if (!batch) return;
        const result = await this.#enqueue(batch.texts, batch.maximumTokens, options.signal);
        if (!result.ok) {
          firstError ??= result.error;
          return;
        }
        for (const [vectorIndex, vector] of result.value.entries()) {
          const inputIndex = batch.indices[vectorIndex];
          if (inputIndex !== undefined) vectors[inputIndex] = vector;
        }
        completed += 1;
        options.onBatch?.(completed, batches.length);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.#workers.length, batches.length) }, () => run()),
    );
    if (firstError) return err(firstError);
    if (vectors.some((vector) => !vector)) {
      return err(embeddingFailure("INFERENCE_FAILED", "An embedding result was not returned."));
    }
    return ok(vectors as readonly (readonly number[])[]);
  }

  async embedQuery(
    text: string,
    options: Pick<EmbedOptions, "signal"> = {},
  ): Promise<Result<readonly number[], EmbeddingError>> {
    const result = await this.embedDocuments([this.encodeQuery(text)], options);
    if (!result.ok) return result;
    const vector = result.value[0];
    return vector
      ? ok(vector)
      : err(embeddingFailure("INFERENCE_FAILED", "The query embedding was not returned."));
  }

  async shutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#performShutdown();
    await this.#shutdownPromise;
  }

  #enqueue(
    texts: readonly string[],
    maximumTokens?: number,
    signal?: AbortSignal,
  ): Promise<Result<readonly (readonly number[])[], EmbeddingError>> {
    if (this.#queue.length + this.#activeWorkers.size >= this.#maxQueue) {
      return Promise.resolve(
        err(embeddingFailure("EMBEDDING_QUEUE_FULL", "The bounded embedding queue is full.")),
      );
    }
    return new Promise((resolve) => {
      this.#queue.push({
        texts,
        ...(maximumTokens ? { maximumTokens } : {}),
        ...(signal ? { signal } : {}),
        resolve,
      });
      void this.#pump();
    });
  }

  async #pump(): Promise<void> {
    const worker = this.#availableWorkers.shift();
    if (!worker) return;
    const job = this.#queue.shift();
    if (!job) {
      this.#availableWorkers.unshift(worker);
      return;
    }
    this.#activeWorkers.add(worker);
    if (job.signal?.aborted) {
      job.resolve(err(embeddingFailure("EMBEDDING_CANCELLED", "Embedding was cancelled.")));
    } else {
      try {
        const vectors = await worker.embed(job.texts, job.maximumTokens);
        if (job.signal?.aborted) {
          job.resolve(err(embeddingFailure("EMBEDDING_CANCELLED", "Embedding was cancelled.")));
        } else {
          const validation = this.#validate(vectors, job.texts.length);
          job.resolve(validation.ok ? ok(vectors) : validation);
        }
      } catch (error) {
        job.resolve(err(mapWorkerError(error)));
      }
    }
    this.#activeWorkers.delete(worker);
    this.#availableWorkers.push(worker);
    if (this.#closed && this.#activeWorkers.size === 0) {
      for (const resolve of this.#idleWaiters.splice(0)) resolve();
    } else {
      void this.#pump();
    }
  }

  #createBatches(texts: readonly string[], tokenCounts?: readonly number[]): EmbeddingBatch[] {
    const encoded = texts.map((text, index) => ({
      index,
      text: this.encodeDocument(text),
      tokenCount: tokenCounts?.[index],
    }));
    if (this.identity.device === "cpu" || !tokenCounts) {
      const batches: EmbeddingBatch[] = [];
      for (let offset = 0; offset < encoded.length; offset += this.batchSize) {
        const inputs = encoded.slice(offset, offset + this.batchSize);
        batches.push({
          indices: inputs.map((input) => input.index),
          texts: inputs.map((input) => input.text),
        });
      }
      return batches;
    }

    const byBucket = new Map<number, typeof encoded>();
    for (const input of encoded) {
      const bucket = acceleratorTokenBucket(
        input.tokenCount ?? this.identity.maximumTokens,
        this.identity.maximumTokens,
      );
      const grouped = byBucket.get(bucket) ?? [];
      grouped.push(input);
      byBucket.set(bucket, grouped);
    }
    const batches: EmbeddingBatch[] = [];
    for (const [maximumTokens, inputs] of [...byBucket].sort(([left], [right]) => left - right)) {
      for (let offset = 0; offset < inputs.length; offset += this.batchSize) {
        const batch = inputs.slice(offset, offset + this.batchSize);
        batches.push({
          indices: batch.map((input) => input.index),
          maximumTokens,
          texts: batch.map((input) => input.text),
        });
      }
    }
    return batches;
  }

  async #performShutdown(): Promise<void> {
    this.#closed = true;
    for (const job of this.#queue.splice(0)) {
      job.resolve(
        err(embeddingFailure("EMBEDDING_PROVIDER_CLOSED", "The embedding provider is closed.")),
      );
    }
    if (this.#activeWorkers.size > 0)
      await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
    await Promise.all(this.#workers.map((worker) => worker.close()));
  }

  #validate(
    vectors: readonly (readonly number[])[],
    expectedCount: number,
  ): Result<void, EmbeddingError> {
    if (
      vectors.length !== expectedCount ||
      vectors.some(
        (vector) =>
          vector.length !== this.identity.vectorDimension ||
          vector.some((value) => !Number.isFinite(value)),
      )
    ) {
      return err(
        embeddingFailure(
          "VECTOR_DIMENSION_INVALID",
          `The model must return ${this.identity.vectorDimension}-dimension finite vectors.`,
        ),
      );
    }
    if (vectors.some((vector) => Math.abs(vectorNorm(vector) - 1) > 1e-3)) {
      return err(
        embeddingFailure(
          "VECTOR_NORMALIZATION_INVALID",
          "The model must return L2-normalized vectors.",
        ),
      );
    }
    return ok(undefined);
  }
}

export function createTransformersEmbeddingProvider(
  config: AppConfig,
  options?: ConstructorParameters<typeof TransformersEmbeddingProvider>[2],
): TransformersEmbeddingProvider {
  // Multiple CPU sessions improve throughput; multiple GPU sessions only contend for one device.
  const workerCount = config.embedding.device === "cpu" && availableParallelism() >= 8 ? 2 : 1;
  return new TransformersEmbeddingProvider(config.embedding, config.paths.modelCacheDir, {
    workerCount,
    ...options,
  });
}
