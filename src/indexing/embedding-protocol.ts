import type { DataType } from "@huggingface/transformers";

export const PROVISIONAL_EMBEDDING_MODEL = {
  id: "Xenova/bge-small-en-v1.5",
  dtype: "q8" satisfies DataType,
  dimension: 384,
  pooling: "mean",
  normalize: true,
} as const;

export interface EmbeddingWorkerConfig {
  readonly modelId: string;
  readonly dtype: DataType;
  readonly expectedDimension: number;
  readonly cacheDir: string;
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
      readonly code: "INVALID_REQUEST" | "MODEL_LOAD_FAILED" | "INFERENCE_FAILED";
      readonly message: string;
    };
