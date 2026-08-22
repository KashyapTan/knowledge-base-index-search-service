import { createHash } from "node:crypto";
import type {
  EmbeddingError,
  EmbeddingIdentity,
  EmbeddingProvider,
  EmbedOptions,
} from "../indexing/index.ts";
import { err, ok, type Result } from "../shared/result.ts";

const DIMENSION = 32;
const conceptGroups: readonly (readonly string[])[] = [
  ["retry", "retries", "retried", "retryable", "reattempt", "attempted", "again"],
  ["temporary", "transient", "recoverable", "connection", "reset"],
  ["backoff", "exponential", "delay", "scheduler", "jitter"],
  ["duplicate", "twice", "repeated", "replay", "idempotency", "idempotent"],
  ["charge", "charging", "payment", "customer", "processor"],
  ["certificate", "pin", "handshake", "tls"],
  ["timeout", "timeouts", "deadline"],
] as const;

function tokens(text: string): readonly string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function vectorFor(text: string): readonly number[] {
  const vector = Array<number>(DIMENSION).fill(0);
  for (const token of tokens(text)) {
    for (const [index, group] of conceptGroups.entries()) {
      if (group.includes(token)) vector[index] = (vector[index] ?? 0) + 3;
    }
    const digest = createHash("sha256").update(token).digest();
    const bucket = conceptGroups.length + ((digest[0] ?? 0) % (DIMENSION - conceptGroups.length));
    vector[bucket] = (vector[bucket] ?? 0) + 0.25;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    vector[DIMENSION - 1] = 1;
    return vector;
  }
  return vector.map((value) => value / norm);
}

/**
 * Offline-only semantic fixture. Concept aliases are explicit and reviewable; it is never used by
 * production or by the BGE model decision.
 */
export class FixtureSemanticEmbeddingProvider implements EmbeddingProvider {
  readonly identity: EmbeddingIdentity = {
    modelId: "kbiss/controlled-semantic-fixture",
    quantization: "fp32",
    vectorDimension: DIMENSION,
    maximumTokens: 512,
    normalization: "l2",
  };
  readonly batchSize = 16;
  #ready = false;
  #closed = false;

  encodeDocument(text: string): string {
    return text;
  }

  encodeQuery(text: string): string {
    return text;
  }

  async warmUp(): Promise<Result<void, EmbeddingError>> {
    if (this.#closed) {
      return err({ code: "EMBEDDING_PROVIDER_CLOSED", message: "The fixture provider is closed." });
    }
    this.#ready = true;
    return ok(undefined);
  }

  async embedDocuments(
    texts: readonly string[],
    options: EmbedOptions = {},
  ): Promise<Result<readonly (readonly number[])[], EmbeddingError>> {
    if (this.#closed) {
      return err({ code: "EMBEDDING_PROVIDER_CLOSED", message: "The fixture provider is closed." });
    }
    if (!this.#ready) {
      return err({ code: "MODEL_ASSETS_MISSING", message: "Warm up the fixture provider first." });
    }
    if (options.signal?.aborted) {
      return err({ code: "EMBEDDING_CANCELLED", message: "Fixture inference was cancelled." });
    }
    const output: (readonly number[])[] = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      const batch = texts.slice(offset, offset + this.batchSize);
      output.push(...batch.map(vectorFor));
      options.onBatch?.(
        Math.floor(offset / this.batchSize) + 1,
        Math.ceil(texts.length / this.batchSize),
      );
    }
    return ok(output);
  }

  async embedQuery(
    text: string,
    options: Pick<EmbedOptions, "signal"> = {},
  ): Promise<Result<readonly number[], EmbeddingError>> {
    const result = await this.embedDocuments([text], options);
    return result.ok ? ok(result.value[0] ?? vectorFor("empty")) : result;
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
  }
}
