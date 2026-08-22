import { availableParallelism } from "node:os";
import {
  type AppConfig,
  composeEmbeddingInput,
  type EmbeddingConfig,
  type EmbeddingModelProfile,
  findEmbeddingModelProfile,
  validateEmbeddingModelProfile,
} from "../config/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type {
  EmbeddingError,
  EmbeddingIdentity,
  EmbeddingProvider,
  EmbeddingVector,
  EmbedOptions,
  ModelWarmUpOptions,
} from "./contracts.ts";
import type { EmbeddingVectorBatch, EmbeddingWorkerConfig } from "./embedding-protocol.ts";
import { validateEmbeddingVectorBatch, vectorViews } from "./embedding-protocol.ts";
import { EmbeddingWorkerClient, EmbeddingWorkerError } from "./embedding-worker-client.ts";
import {
  inspectModelAssets,
  quarantineModelCache,
  verifyOrWriteModelAssetManifest,
} from "./model-assets.ts";

export interface EmbeddingWorkerBoundary {
  initialize(config: EmbeddingWorkerConfig): Promise<void>;
  embed(texts: readonly string[], maximumTokens?: number): Promise<EmbeddingVectorBatch>;
  close(): Promise<void>;
}

interface QueueJob {
  readonly texts: readonly string[];
  readonly maximumTokens?: number;
  readonly signal?: AbortSignal;
  readonly resolve: (result: Result<readonly Float32Array[], EmbeddingError>) => void;
}

interface EmbeddingBatch {
  readonly texts: readonly string[];
  readonly indices: readonly number[];
  readonly maximumTokens?: number;
}

export const ACCELERATOR_TOKEN_BUCKETS = Object.freeze([64, 128, 256, 384, 512] as const);

export function acceleratorTokenBucket(
  tokenCount: number,
  maximumTokens: number,
  buckets: readonly number[] = ACCELERATOR_TOKEN_BUCKETS,
): number {
  return (
    buckets.find((candidate) => candidate >= tokenCount && candidate <= maximumTokens) ??
    maximumTokens
  );
}

function embeddingFailure(code: EmbeddingError["code"], message: string): EmbeddingError {
  return { code, message };
}

function mapWorkerError(error: unknown): EmbeddingError {
  if (error instanceof EmbeddingWorkerError) {
    const code =
      error.code === "INVALID_REQUEST" || error.code === "CONFIGURATION_INVALID"
        ? "INFERENCE_FAILED"
        : error.code;
    return embeddingFailure(code, error.message);
  }
  return embeddingFailure(
    "INFERENCE_FAILED",
    error instanceof Error ? error.message : "Local embedding inference failed.",
  );
}

function vectorNorm(vector: EmbeddingVector): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

function sameProfileConfig(embedding: EmbeddingConfig, profile: EmbeddingModelProfile): boolean {
  return (
    embedding.modelId === profile.canonicalModelId &&
    embedding.nativeDimension === profile.nativeDimension &&
    embedding.profile.revision === profile.revision &&
    embedding.profile.profileVersion === profile.profileVersion &&
    JSON.stringify(embedding.profile.pooling) === JSON.stringify(profile.pooling) &&
    JSON.stringify(embedding.profile.documentEncoding) ===
      JSON.stringify(profile.documentEncoding) &&
    JSON.stringify(embedding.profile.queryEncoding) === JSON.stringify(profile.queryEncoding) &&
    JSON.stringify(embedding.profile.tokenizer) === JSON.stringify(profile.tokenizer)
  );
}

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly identity: EmbeddingIdentity;
  readonly batchSize: number;
  readonly #cacheDir: string;
  readonly #profile: EmbeddingModelProfile;
  readonly #execution: NonNullable<EmbeddingModelProfile["execution"][EmbeddingConfig["device"]]>;
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
      readonly profile?: EmbeddingModelProfile;
      readonly worker?: EmbeddingWorkerBoundary;
      readonly workerCount?: number;
      readonly workerFactory?: () => EmbeddingWorkerBoundary;
    } = {},
  ) {
    const profile = options.profile ?? findEmbeddingModelProfile(embedding.modelId);
    const profileIssues = profile ? validateEmbeddingModelProfile(profile) : ["profile is missing"];
    if (!profile || profileIssues.length > 0 || !sameProfileConfig(embedding, profile)) {
      throw new TypeError(
        `The embedding configuration does not match a reviewed model profile${profileIssues.length ? `: ${profileIssues.join("; ")}` : ""}.`,
      );
    }
    const execution = profile.execution[embedding.device];
    if (
      !execution?.dtypes.includes(embedding.quantization) ||
      !profile.matryoshkaDimensions.includes(embedding.vectorDimension)
    ) {
      throw new TypeError(
        "The embedding device, dtype, or output dimension is incompatible with the selected profile.",
      );
    }
    this.#profile = profile;
    this.#execution = execution;
    this.identity = {
      device: embedding.device,
      maximumTokens: options.maximumTokens ?? profile.applicationIndexingLimit,
      modelId: embedding.modelId,
      nativeDimension: embedding.nativeDimension,
      normalization: embedding.normalization,
      profile: embedding.profile,
      quantization: embedding.quantization,
      vectorDimension: embedding.vectorDimension,
    };
    if (
      this.identity.maximumTokens < 1 ||
      this.identity.maximumTokens > profile.applicationIndexingLimit
    ) {
      throw new TypeError(
        "The embedding token limit exceeds the model profile's approved indexing limit.",
      );
    }
    this.batchSize = Math.max(
      1,
      Math.min(options.batchSize ?? execution.maximumBatchSize, execution.maximumBatchSize),
    );
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
    return composeEmbeddingInput(this.#profile.documentEncoding, text);
  }

  encodeQuery(text: string): string {
    return composeEmbeddingInput(this.#profile.queryEncoding, text);
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
    if (downloadRequired && !options.allowDownload) {
      return err(
        embeddingFailure(
          "MODEL_ASSETS_MISSING",
          "Local model assets are unavailable in offline mode. Run bun run model:setup while online or import a controlled local asset source.",
        ),
      );
    }

    const firstWorker = this.#workers[0];
    if (!firstWorker)
      return err(embeddingFailure("MODEL_LOAD_FAILED", "No embedding Worker is available."));
    if (downloadRequired) {
      const attempts = Math.max(1, Math.min(5, options.downloadRetries ?? 2));
      let downloadError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        progress(
          "downloading",
          `Downloading the pinned model (${attempt}/${attempts}); existing verified assets remain local.`,
        );
        try {
          await firstWorker.initialize(this.#workerConfig(false));
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
        await firstWorker.initialize(this.#workerConfig(true));
      } catch (error) {
        return err(mapWorkerError(error));
      }
    }
    try {
      await Promise.all(
        this.#workers.slice(1).map((worker) => worker.initialize(this.#workerConfig(true))),
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

  embedDocuments(
    texts: readonly string[],
    options: EmbedOptions = {},
  ): Promise<Result<readonly EmbeddingVector[], EmbeddingError>> {
    return this.#embedInputs(
      texts.map((text) => this.encodeDocument(text)),
      options,
    );
  }

  async embedQuery(
    text: string,
    options: Pick<EmbedOptions, "signal"> = {},
  ): Promise<Result<EmbeddingVector, EmbeddingError>> {
    const result = await this.#embedInputs([this.encodeQuery(text)], options);
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

  async #embedInputs(
    encodedTexts: readonly string[],
    options: EmbedOptions,
  ): Promise<Result<readonly Float32Array[], EmbeddingError>> {
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
    if (encodedTexts.length === 0) return ok([]);
    if (options.tokenCounts && options.tokenCounts.length !== encodedTexts.length) {
      return err(
        embeddingFailure(
          "INFERENCE_FAILED",
          "Embedding token counts must align one-to-one with the input texts.",
        ),
      );
    }

    const batches = this.#createBatches(encodedTexts, options.tokenCounts);
    const vectors: Array<Float32Array | undefined> = new Array(encodedTexts.length);
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
    if (vectors.some((vector) => !vector))
      return err(embeddingFailure("INFERENCE_FAILED", "An embedding result was not returned."));
    return ok(vectors as readonly Float32Array[]);
  }

  #workerConfig(localFilesOnly: boolean): EmbeddingWorkerConfig {
    return {
      cacheDir: this.#cacheDir,
      device: this.identity.device,
      documentEncoding: this.identity.profile.documentEncoding,
      dtype: this.identity.quantization,
      expectedDimension: this.identity.vectorDimension,
      localFilesOnly,
      maximumTokens: this.identity.maximumTokens,
      modelId: this.identity.modelId,
      nativeDimension: this.identity.nativeDimension,
      pooling: this.identity.profile.pooling,
      profileVersion: this.identity.profile.profileVersion,
      queryEncoding: this.identity.profile.queryEncoding,
      revision: this.identity.profile.revision,
      tokenizer: this.identity.profile.tokenizer,
    };
  }

  #enqueue(
    texts: readonly string[],
    maximumTokens?: number,
    signal?: AbortSignal,
  ): Promise<Result<readonly Float32Array[], EmbeddingError>> {
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
        const batch = await worker.embed(job.texts, job.maximumTokens);
        if (job.signal?.aborted) {
          job.resolve(err(embeddingFailure("EMBEDDING_CANCELLED", "Embedding was cancelled.")));
        } else {
          job.resolve(this.#validate(batch, job.texts.length));
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
    const encoded = texts.map((text, index) => ({ index, text, tokenCount: tokenCounts?.[index] }));
    if (this.#execution.shapePolicy === "dynamic" || !tokenCounts) {
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
        this.#execution.tokenBuckets,
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
    batch: EmbeddingVectorBatch,
    expectedCount: number,
  ): Result<readonly Float32Array[], EmbeddingError> {
    try {
      validateEmbeddingVectorBatch(batch);
    } catch {
      return err(
        embeddingFailure(
          "VECTOR_DIMENSION_INVALID",
          `The model must return contiguous ${this.identity.vectorDimension}-dimension finite vectors.`,
        ),
      );
    }
    if (batch.count !== expectedCount || batch.dimension !== this.identity.vectorDimension) {
      return err(
        embeddingFailure(
          "VECTOR_DIMENSION_INVALID",
          `The model must return ${this.identity.vectorDimension}-dimension finite vectors.`,
        ),
      );
    }
    const vectors = vectorViews(batch);
    if (vectors.some((vector) => Math.abs(vectorNorm(vector) - 1) > 1e-3)) {
      return err(
        embeddingFailure(
          "VECTOR_NORMALIZATION_INVALID",
          "The model must return L2-normalized vectors.",
        ),
      );
    }
    return ok(vectors);
  }
}

export function createTransformersEmbeddingProvider(
  config: AppConfig,
  options?: ConstructorParameters<typeof TransformersEmbeddingProvider>[2],
): TransformersEmbeddingProvider {
  const profile = options?.profile ?? findEmbeddingModelProfile(config.embedding.modelId);
  if (!profile) throw new TypeError("The configured embedding model has no reviewed profile.");
  const execution = profile.execution[config.embedding.device];
  if (!execution) throw new TypeError("The configured embedding device has no reviewed profile.");
  const measuredCpuWorkers = availableParallelism() >= 8 ? 2 : 1;
  const workerCount =
    config.embedding.device === "cpu" ? Math.min(measuredCpuWorkers, execution.workerSessions) : 1;
  return new TransformersEmbeddingProvider(config.embedding, config.paths.modelCacheDir, {
    profile,
    workerCount,
    ...options,
  });
}
