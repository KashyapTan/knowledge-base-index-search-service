import { createHash } from "node:crypto";
import type { EmbeddingProfileCompatibility } from "../config/index.ts";
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

export function fakeEmbeddingProfile(id = "deterministic-fake"): EmbeddingProfileCompatibility {
  return {
    assetProvenance: "deterministic-test-fixture",
    documentEncoding: { id: `${id}-document`, prefix: "", suffix: "", version: 1 },
    license: "test-only",
    pooling: {
      modelOutputNormalized: false,
      outputTensor: "last_hidden_state",
      strategy: "mean",
      version: 1,
    },
    profileVersion: 1,
    queryEncoding: { id: `${id}-query`, prefix: "", suffix: "", version: 1 },
    revision: createHash("sha1").update(id).digest("hex"),
    tokenizer: {
      addSpecialTokens: true,
      paddingSide: "right",
      promptTokenOverhead: { document: 2, query: 2 },
      specialTokenPolicyVersion: 1,
      truncation: "longest-first",
      truncationSide: "right",
      version: 1,
    },
  };
}

function deterministicVector(text: string, dimension: number): Float32Array {
  const digest = createHash("sha256").update(text).digest();
  const vector = Array.from(
    { length: dimension },
    (_, index) => (digest[index % digest.length] ?? 0) / 127.5 - 1,
  );
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    vector[0] = 1;
    return Float32Array.from(vector);
  }
  return Float32Array.from(vector, (value) => value / norm);
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
      nativeDimension: options.dimension ?? 4,
      profile: fakeEmbeddingProfile(),
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
  ): Promise<Result<readonly Float32Array[], EmbeddingError>> {
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
    const vectors: Float32Array[] = [];
    const total = Math.ceil(texts.length / this.batchSize);
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      const batch = texts.slice(offset, offset + this.batchSize);
      this.embeddedTexts.push(...batch);
      vectors.push(
        ...batch.map((text) => deterministicVector(text, this.identity.vectorDimension)),
      );
      const counts = options.tokenCounts?.slice(offset, offset + batch.length);
      const maximumTokens = Math.max(...(counts ?? [this.identity.maximumTokens]));
      const paddedTokens = maximumTokens * batch.length;
      const usefulTokens = counts?.reduce((sum, value) => sum + value, 0) ?? paddedTokens;
      options.onBatch?.(Math.floor(offset / this.batchSize) + 1, total, {
        batchSize: batch.length,
        maximumTokens,
        usefulTokens,
        paddedTokens,
        fillRatio: usefulTokens / paddedTokens,
        queueWaitMs: 0,
        inferenceMs: 0,
      });
    }
    return ok(vectors);
  }

  async embedQuery(
    text: string,
    options: Pick<EmbedOptions, "signal"> = {},
  ): Promise<Result<Float32Array, EmbeddingError>> {
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
