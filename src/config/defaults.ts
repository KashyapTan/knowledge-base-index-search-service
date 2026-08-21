import type { DataType } from "@huggingface/transformers";
import type { EmbeddingConfig, IndexConfig } from "./contracts.ts";

export const APPLICATION_NAME = "kbiss";
export const APPLICATION_VERSION = "0.1.0";
export const COMPATIBILITY_DESCRIPTOR_VERSION = 1;
export const DEFAULT_PORT = 3210;
export const DEFAULT_SOURCE_ROOT = "~/dev/card-gateway-artifacts";
export const SUPPORTED_QUANTIZATIONS: ReadonlySet<DataType> = new Set([
  "auto",
  "fp32",
  "fp16",
  "q8",
  "int8",
  "uint8",
  "q4",
  "bnb4",
  "q4f16",
  "q2",
  "q2f16",
  "q1",
  "q1f16",
]);

export const DEFAULT_EMBEDDING_CONFIG = Object.freeze({
  modelId: "Xenova/bge-small-en-v1.5",
  normalization: "l2",
  quantization: "q8",
  vectorDimension: 384,
} as const satisfies EmbeddingConfig);

export const DEFAULT_INDEX_CONFIG: IndexConfig = Object.freeze({
  chunkOverlapTokens: 50,
  chunkSizeTokens: 400,
  chunkerVersion: 1,
  extractorVersion: 1,
  schemaVersion: 1,
});
