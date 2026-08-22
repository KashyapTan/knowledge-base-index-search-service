import type { DataType } from "@huggingface/transformers";
import { DEFAULT_EMBEDDING_CONFIG } from "../config/defaults.ts";
import type { EmbeddingDevice } from "../config/index.ts";

export const PROVISIONAL_EMBEDDING_MODEL = {
  id: DEFAULT_EMBEDDING_CONFIG.modelId,
  dtype: DEFAULT_EMBEDDING_CONFIG.quantization satisfies DataType,
  dimension: DEFAULT_EMBEDDING_CONFIG.vectorDimension,
  pooling: "mean",
  normalize: true,
} as const;

export interface EmbeddingWorkerConfig {
  readonly device: EmbeddingDevice;
  readonly modelId: string;
  readonly dtype: DataType;
  readonly expectedDimension: number;
  readonly cacheDir: string;
  /** Setup may opt in to a pinned remote download; normal indexing always sets this true. */
  readonly localFilesOnly: boolean;
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
    }
  | {
      readonly kind: "embeddings";
      readonly requestId: string;
      readonly vectors: readonly (readonly number[])[];
      readonly dimension: number;
    }
  | {
      readonly kind: "stopped";
      readonly requestId: string;
    }
  | {
      readonly kind: "error";
      readonly requestId: string;
      readonly code:
        | "INVALID_REQUEST"
        | "MODEL_ASSETS_MISSING"
        | "MODEL_LOAD_FAILED"
        | "INFERENCE_FAILED";
      readonly message: string;
    };
