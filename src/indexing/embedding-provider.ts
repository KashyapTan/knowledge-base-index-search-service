import type { AppConfig, EmbeddingConfig } from "../config/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type {
  EmbeddingError,
  EmbeddingIdentity,
  EmbeddingProvider,
  EmbedOptions,
} from "./contracts.ts";
import { EmbeddingWorkerClient, EmbeddingWorkerError } from "./embedding-worker-client.ts";
import { verifyOrWriteModelAssetManifest } from "./model-assets.ts";

export const BGE_MODEL_PROFILES = Object.freeze({
  "Xenova/bge-small-en-v1.5": { maximumTokens: 512, vectorDimension: 384 },
  "Xenova/bge-base-en-v1.5": { maximumTokens: 512, vectorDimension: 768 },
} as const);

export interface EmbeddingWorkerBoundary {
  initialize(config: {
    readonly modelId: string;
    readonly dtype: EmbeddingConfig["quantization"];
    readonly expectedDimension: number;
    readonly cacheDir: string;
    readonly localFilesOnly: boolean;
  }): Promise<void>;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
  close(): Promise<void>;
}

interface QueueJob {
  readonly texts: readonly string[];
  readonly signal?: AbortSignal;
  readonly resolve: (result: Result<readonly (readonly number[])[], EmbeddingError>) => void;
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
  readonly #worker: EmbeddingWorkerBoundary;
  readonly #maxQueue: number;
  readonly #queue: QueueJob[] = [];
  readonly #idleWaiters: Array<() => void> = [];
  #active = false;
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
    } = {},
  ) {
    const profile = BGE_MODEL_PROFILES[embedding.modelId as keyof typeof BGE_MODEL_PROFILES];
    this.identity = {
      modelId: embedding.modelId,
      quantization: embedding.quantization,
      vectorDimension: embedding.vectorDimension,
      maximumTokens: options.maximumTokens ?? profile?.maximumTokens ?? 512,
      normalization: embedding.normalization,
    };
    this.batchSize = options.batchSize ?? 16;
    this.#maxQueue = options.maxQueue ?? 8;
    this.#cacheDir = cacheDir;
    this.#worker = options.worker ?? new EmbeddingWorkerClient();
  }

  encodeDocument(text: string): string {
    return text;
  }

  encodeQuery(text: string): string {
    // BGE v1.5 works without an instruction; Plan 11 decides whether corpus evidence justifies one.
    return text;
  }

  async warmUp(
    options: { readonly allowDownload?: boolean } = {},
  ): Promise<Result<void, EmbeddingError>> {
    if (this.#closed)
      return err(
        embeddingFailure("EMBEDDING_PROVIDER_CLOSED", "The embedding provider is closed."),
      );
    const assets = await verifyOrWriteModelAssetManifest(this.#cacheDir, this.identity, "verify");
    if (!assets.ok) return assets;
    try {
      await this.#worker.initialize({
        modelId: this.identity.modelId,
        dtype: this.identity.quantization,
        expectedDimension: this.identity.vectorDimension,
        cacheDir: this.#cacheDir,
        localFilesOnly: true,
      });
    } catch (error) {
      if (!(error instanceof EmbeddingWorkerError) || error.code !== "MODEL_ASSETS_MISSING") {
        return err(mapWorkerError(error));
      }
      if (!options.allowDownload) return err(mapWorkerError(error));
      try {
        await this.#worker.initialize({
          modelId: this.identity.modelId,
          dtype: this.identity.quantization,
          expectedDimension: this.identity.vectorDimension,
          cacheDir: this.#cacheDir,
          localFilesOnly: false,
        });
      } catch (downloadError) {
        return err(mapWorkerError(downloadError));
      }
    }
    const manifest = await verifyOrWriteModelAssetManifest(
      this.#cacheDir,
      this.identity,
      "write-if-missing",
    );
    if (!manifest.ok) return manifest;
    this.#ready = true;
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

    const batches: string[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      batches.push(
        texts.slice(offset, offset + this.batchSize).map((text) => this.encodeDocument(text)),
      );
    }
    const vectors: (readonly number[])[] = [];
    for (const [index, batch] of batches.entries()) {
      const result = await this.#enqueue(batch, options.signal);
      if (!result.ok) return result;
      vectors.push(...result.value);
      options.onBatch?.(index + 1, batches.length);
    }
    return ok(vectors);
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
    signal?: AbortSignal,
  ): Promise<Result<readonly (readonly number[])[], EmbeddingError>> {
    if (this.#queue.length + Number(this.#active) >= this.#maxQueue) {
      return Promise.resolve(
        err(embeddingFailure("EMBEDDING_QUEUE_FULL", "The bounded embedding queue is full.")),
      );
    }
    return new Promise((resolve) => {
      this.#queue.push({ texts, ...(signal ? { signal } : {}), resolve });
      void this.#pump();
    });
  }

  async #pump(): Promise<void> {
    if (this.#active) return;
    const job = this.#queue.shift();
    if (!job) return;
    this.#active = true;
    if (job.signal?.aborted) {
      job.resolve(err(embeddingFailure("EMBEDDING_CANCELLED", "Embedding was cancelled.")));
    } else {
      try {
        const vectors = await this.#worker.embed(job.texts);
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
    this.#active = false;
    if (this.#closed) {
      for (const resolve of this.#idleWaiters.splice(0)) resolve();
    } else {
      void this.#pump();
    }
  }

  async #performShutdown(): Promise<void> {
    this.#closed = true;
    for (const job of this.#queue.splice(0)) {
      job.resolve(
        err(embeddingFailure("EMBEDDING_PROVIDER_CLOSED", "The embedding provider is closed.")),
      );
    }
    if (this.#active) await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
    await this.#worker.close();
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
  return new TransformersEmbeddingProvider(config.embedding, config.paths.modelCacheDir, options);
}
