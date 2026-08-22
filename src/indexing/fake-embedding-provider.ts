import { createHash } from "node:crypto";
import { err, ok, type Result } from "../shared/result.ts";
import type {
  EmbeddingError,
  EmbeddingIdentity,
  EmbeddingProvider,
  EmbedOptions,
} from "./contracts.ts";

export interface FakeEmbeddingProviderOptions {
  readonly dimension?: number;
  readonly batchSize?: number;
  readonly failWarmUp?: boolean;
  readonly failOnText?: string;
}

function deterministicVector(text: string, dimension: number): readonly number[] {
  const digest = createHash("sha256").update(text).digest();
  const vector = Array.from(
    { length: dimension },
    (_, index) => (digest[index % digest.length] ?? 0) / 127.5 - 1,
  );
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => value / norm);
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly identity: EmbeddingIdentity;
  readonly batchSize: number;
  readonly embeddedTexts: string[] = [];
  warmUpCalls = 0;
  shutdownCalls = 0;
  readonly #failWarmUp: boolean;
  readonly #failOnText: string | undefined;
  #closed = false;
  #ready = false;

  constructor(options: FakeEmbeddingProviderOptions = {}) {
    this.identity = {
      device: "cpu",
      modelId: "kbiss/deterministic-fake",
      quantization: "fp32",
      vectorDimension: options.dimension ?? 4,
      maximumTokens: 512,
      normalization: "l2",
    };
    this.batchSize = options.batchSize ?? 2;
    this.#failWarmUp = options.failWarmUp ?? false;
    this.#failOnText = options.failOnText;
  }

  encodeDocument(text: string): string {
    return text;
  }

  encodeQuery(text: string): string {
    return text;
  }

  async warmUp(): Promise<Result<void, EmbeddingError>> {
    this.warmUpCalls += 1;
    if (this.#failWarmUp)
      return err({ code: "MODEL_ASSETS_MISSING", message: "Fake model assets are unavailable." });
    this.#ready = true;
    return ok(undefined);
  }

  async embedDocuments(
    texts: readonly string[],
    options: EmbedOptions = {},
  ): Promise<Result<readonly (readonly number[])[], EmbeddingError>> {
    if (this.#closed)
      return err({ code: "EMBEDDING_PROVIDER_CLOSED", message: "The fake provider is closed." });
    if (!this.#ready)
      return err({ code: "MODEL_ASSETS_MISSING", message: "Warm up the fake provider first." });
    if (options.signal?.aborted)
      return err({ code: "EMBEDDING_CANCELLED", message: "Embedding was cancelled." });
    const failOnText = this.#failOnText;
    if (failOnText && texts.some((text) => text.includes(failOnText))) {
      return err({ code: "INFERENCE_FAILED", message: "Deterministic fake inference failed." });
    }
    const vectors: (readonly number[])[] = [];
    const total = Math.ceil(texts.length / this.batchSize);
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      const batch = texts.slice(offset, offset + this.batchSize);
      this.embeddedTexts.push(...batch);
      vectors.push(
        ...batch.map((text) => deterministicVector(text, this.identity.vectorDimension)),
      );
      options.onBatch?.(Math.floor(offset / this.batchSize) + 1, total);
    }
    return ok(vectors);
  }

  async embedQuery(
    text: string,
    options: Pick<EmbedOptions, "signal"> = {},
  ): Promise<Result<readonly number[], EmbeddingError>> {
    const result = await this.embedDocuments([text], options);
    if (!result.ok) return result;
    const vector = result.value[0];
    return vector
      ? ok(vector)
      : err({ code: "INFERENCE_FAILED", message: "The fake query vector was not returned." });
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.#closed = true;
  }
}
