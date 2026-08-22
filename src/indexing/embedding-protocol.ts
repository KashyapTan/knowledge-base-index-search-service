import type { DataType } from "@huggingface/transformers";
import {
  DEFAULT_EMBEDDING_CONFIG,
  EMBEDDING_MODEL_PROFILES,
  type EmbeddingDevice,
  type EmbeddingEncodingConfig,
  type EmbeddingPoolingConfig,
  type EmbeddingTokenizerConfig,
} from "../config/index.ts";

const provisionalProfile = EMBEDDING_MODEL_PROFILES["Xenova/bge-small-en-v1.5"];

export const PROVISIONAL_EMBEDDING_MODEL = {
  id: DEFAULT_EMBEDDING_CONFIG.modelId,
  revision: provisionalProfile.revision,
  profileVersion: provisionalProfile.profileVersion,
  dtype: DEFAULT_EMBEDDING_CONFIG.quantization satisfies DataType,
  dimension: DEFAULT_EMBEDDING_CONFIG.vectorDimension,
  nativeDimension: provisionalProfile.nativeDimension,
  pooling: provisionalProfile.pooling,
  normalize: true,
} as const;

export interface EmbeddingWorkerConfig {
  readonly cacheDir: string;
  readonly device: EmbeddingDevice;
  readonly documentEncoding: EmbeddingEncodingConfig;
  readonly dtype: DataType;
  readonly expectedDimension: number;
  readonly localFilesOnly: boolean;
  readonly maximumTokens: number;
  readonly modelId: string;
  readonly nativeDimension: number;
  readonly pooling: EmbeddingPoolingConfig;
  readonly profileVersion: number;
  readonly queryEncoding: EmbeddingEncodingConfig;
  readonly revision: string;
  readonly tokenizer: EmbeddingTokenizerConfig;
}

export interface EmbeddingVectorBatch {
  readonly count: number;
  readonly dimension: number;
  /** Contiguous row-major storage transferred from the Worker. */
  readonly storage: Float32Array;
}

export type EmbeddingWorkerRequest =
  | {
      readonly kind: "initialize";
      readonly requestId: string;
      readonly config: EmbeddingWorkerConfig;
    }
  | {
      readonly kind: "embed";
      readonly requestId: string;
      readonly texts: readonly string[];
      readonly maximumTokens?: number;
    }
  | {
      readonly kind: "shutdown";
      readonly requestId: string;
    };

export type EmbeddingWorkerResponse =
  | {
      readonly kind: "ready";
      readonly requestId: string;
      readonly modelId: string;
      readonly profileVersion: number;
      readonly revision: string;
    }
  | ({ readonly kind: "embeddings"; readonly requestId: string } & EmbeddingVectorBatch)
  | {
      readonly kind: "stopped";
      readonly requestId: string;
    }
  | {
      readonly kind: "error";
      readonly requestId: string;
      readonly code:
        | "CONFIGURATION_INVALID"
        | "INVALID_REQUEST"
        | "MODEL_ASSETS_MISSING"
        | "MODEL_LOAD_FAILED"
        | "INFERENCE_FAILED";
      readonly message: string;
    };

export function validateEmbeddingVectorBatch(batch: EmbeddingVectorBatch): void {
  if (
    !Number.isInteger(batch.count) ||
    batch.count < 1 ||
    !Number.isInteger(batch.dimension) ||
    batch.dimension < 1 ||
    !(batch.storage instanceof Float32Array) ||
    batch.storage.byteOffset !== 0 ||
    batch.storage.byteLength === 0 ||
    batch.storage.length !== batch.count * batch.dimension
  ) {
    throw new Error("The embedding Worker returned malformed contiguous vector storage.");
  }
  for (const value of batch.storage) {
    if (!Number.isFinite(value))
      throw new Error("The embedding Worker returned a non-finite vector value.");
  }
}

export function vectorViews(batch: EmbeddingVectorBatch): readonly Float32Array[] {
  validateEmbeddingVectorBatch(batch);
  return Array.from({ length: batch.count }, (_, index) =>
    batch.storage.subarray(index * batch.dimension, (index + 1) * batch.dimension),
  );
}
