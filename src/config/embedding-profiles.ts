import type { DataType } from "@huggingface/transformers";
import type {
  ConfiguredEmbeddingDevice,
  EmbeddingConfig,
  EmbeddingDevice,
  EmbeddingEncodingConfig,
  EmbeddingPoolingConfig,
  EmbeddingTokenizerConfig,
} from "./contracts.ts";

export interface EmbeddingExecutionProfile {
  readonly defaultDtype: DataType;
  readonly dtypes: readonly DataType[];
  readonly maximumBatchSize: number;
  /** Maximum padded token slots admitted to one inference call. */
  readonly maximumBatchTokens: number;
  readonly shapePolicy: "dynamic" | "fixed-buckets";
  readonly tokenBuckets: readonly number[];
  readonly workerSessions: number;
}

export interface EmbeddingTaskAlternative {
  readonly id: string;
  readonly prefix: string;
  readonly suffix: string;
}

export interface EmbeddingModelProfile {
  readonly applicationIndexingLimit: number;
  readonly assetProvenance: string;
  readonly canonicalModelId: string;
  readonly defaultDevice: EmbeddingDevice;
  readonly documentEncoding: EmbeddingEncodingConfig;
  readonly execution: Readonly<Partial<Record<EmbeddingDevice, EmbeddingExecutionProfile>>>;
  readonly license: {
    readonly eligibleForTeamUse: boolean;
    readonly identifier: string;
    readonly notice?: string;
  };
  readonly matryoshkaDimensions: readonly number[];
  readonly nativeContextLimit: number;
  readonly nativeDimension: number;
  readonly pooling: EmbeddingPoolingConfig;
  readonly profileVersion: number;
  readonly queryEncoding: EmbeddingEncodingConfig;
  readonly queryTaskAlternatives: readonly EmbeddingTaskAlternative[];
  readonly revision: string;
  readonly tokenizer: EmbeddingTokenizerConfig;
}

export interface UnavailableEmbeddingCandidate {
  readonly canonicalModelId: string;
  readonly reason: string;
  readonly revision: string;
}

const noPrompt = (id: string): EmbeddingEncodingConfig => ({
  id,
  prefix: "",
  suffix: "",
  version: 1,
});

const tokenizer = (
  paddingSide: "left" | "right",
  documentOverhead: number,
  queryOverhead: number,
): EmbeddingTokenizerConfig => ({
  addSpecialTokens: true,
  paddingSide,
  promptTokenOverhead: { document: documentOverhead, query: queryOverhead },
  specialTokenPolicyVersion: 1,
  truncation: "longest-first",
  truncationSide: "right",
  version: 1,
});

const meanPooling: EmbeddingPoolingConfig = {
  modelOutputNormalized: false,
  outputTensor: "last_hidden_state",
  strategy: "mean",
  version: 1,
};

const cpuQ8: EmbeddingExecutionProfile = {
  defaultDtype: "q8",
  dtypes: ["q8", "fp32"],
  maximumBatchSize: 16,
  maximumBatchTokens: 8_192,
  shapePolicy: "dynamic",
  tokenBuckets: [],
  workerSessions: 2,
};

const bgeWebGpu: EmbeddingExecutionProfile = {
  defaultDtype: "fp16",
  dtypes: ["fp16", "fp32"],
  maximumBatchSize: 32,
  maximumBatchTokens: 8_192,
  shapePolicy: "fixed-buckets",
  tokenBuckets: [64, 128, 256, 384, 512],
  workerSessions: 1,
};

const bgeProfile = (
  canonicalModelId: "Xenova/bge-small-en-v1.5" | "Xenova/bge-base-en-v1.5",
  revision: string,
  dimension: number,
): EmbeddingModelProfile => ({
  applicationIndexingLimit: 512,
  assetProvenance: "huggingface-reviewed-onnx",
  canonicalModelId,
  defaultDevice: "cpu",
  documentEncoding: noPrompt("bge-v1.5-plan11-document-instruction-free"),
  execution: { cpu: cpuQ8, webgpu: bgeWebGpu },
  license: { eligibleForTeamUse: true, identifier: "mit" },
  matryoshkaDimensions: [dimension],
  nativeContextLimit: 512,
  nativeDimension: dimension,
  pooling: meanPooling,
  profileVersion: 2,
  queryEncoding: noPrompt("bge-v1.5-plan11-query-instruction-free"),
  queryTaskAlternatives: [
    {
      id: "bge-v1.5-retrieval-recommended",
      prefix: "Represent this sentence for searching relevant passages: ",
      suffix: "",
    },
  ],
  revision,
  tokenizer: tokenizer("right", 2, 2),
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const EMBEDDING_MODEL_PROFILES = deepFreeze({
  "Xenova/bge-small-en-v1.5": bgeProfile(
    "Xenova/bge-small-en-v1.5",
    "ea104dacec62c0de699686887e3f920caeb4f3e3",
    384,
  ),
  "Xenova/bge-base-en-v1.5": bgeProfile(
    "Xenova/bge-base-en-v1.5",
    "4d6cd88e18e51a5e020c2c305726d76ada9c03cf",
    768,
  ),
  "Alibaba-NLP/gte-modernbert-base": {
    applicationIndexingLimit: 512,
    assetProvenance: "huggingface-reviewed-onnx",
    canonicalModelId: "Alibaba-NLP/gte-modernbert-base",
    defaultDevice: "cpu",
    documentEncoding: noPrompt("gte-modernbert-symmetric-document"),
    execution: { cpu: cpuQ8 },
    license: { eligibleForTeamUse: true, identifier: "apache-2.0" },
    matryoshkaDimensions: [768],
    nativeContextLimit: 8_192,
    nativeDimension: 768,
    pooling: {
      modelOutputNormalized: false,
      outputTensor: "last_hidden_state",
      strategy: "cls",
      version: 1,
    },
    profileVersion: 1,
    queryEncoding: noPrompt("gte-modernbert-symmetric-query"),
    queryTaskAlternatives: [],
    revision: "e7f32e3c00f91d699e8c43b53106206bcc72bb22",
    tokenizer: tokenizer("right", 2, 2),
  },
  "onnx-community/embeddinggemma-300m-ONNX": {
    applicationIndexingLimit: 512,
    assetProvenance: "onnx-community-conversion-of-google-embeddinggemma-300m",
    canonicalModelId: "onnx-community/embeddinggemma-300m-ONNX",
    defaultDevice: "cpu",
    documentEncoding: {
      id: "embeddinggemma-retrieval-document-title-none",
      prefix: "title: none | text: ",
      suffix: "",
      version: 1,
    },
    execution: {
      cpu: {
        ...cpuQ8,
        dtypes: ["q8", "q4", "fp32"],
      },
    },
    license: {
      eligibleForTeamUse: true,
      identifier: "gemma",
      notice: "Use is subject to the Gemma Terms and Prohibited Use Policy.",
    },
    matryoshkaDimensions: [768, 512, 256, 128],
    nativeContextLimit: 2_048,
    nativeDimension: 768,
    pooling: {
      modelOutputNormalized: true,
      outputTensor: "sentence_embedding",
      strategy: "model-output",
      version: 1,
    },
    profileVersion: 1,
    queryEncoding: {
      id: "embeddinggemma-retrieval-query-search-result",
      prefix: "task: search result | query: ",
      suffix: "",
      version: 1,
    },
    queryTaskAlternatives: [
      {
        id: "embeddinggemma-code-retrieval-query",
        prefix: "task: code retrieval | query: ",
        suffix: "",
      },
    ],
    revision: "5090578d9565bb06545b4552f76e6bc2c93e4a66",
    tokenizer: tokenizer("right", 9, 10),
  },
  "onnx-community/Qwen3-Embedding-0.6B-ONNX": {
    applicationIndexingLimit: 512,
    assetProvenance: "onnx-community-conversion-of-Qwen3-Embedding-0.6B",
    canonicalModelId: "onnx-community/Qwen3-Embedding-0.6B-ONNX",
    defaultDevice: "cpu",
    documentEncoding: noPrompt("qwen3-embedding-retrieval-document"),
    execution: { cpu: cpuQ8 },
    license: { eligibleForTeamUse: true, identifier: "apache-2.0" },
    matryoshkaDimensions: [1024, 768, 512, 256, 128, 64, 32],
    nativeContextLimit: 32_768,
    nativeDimension: 1_024,
    pooling: {
      modelOutputNormalized: false,
      outputTensor: "last_hidden_state",
      strategy: "last-token",
      version: 1,
    },
    profileVersion: 1,
    queryEncoding: {
      id: "qwen3-embedding-web-retrieval-query",
      prefix:
        "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:",
      suffix: "",
      version: 1,
    },
    queryTaskAlternatives: [
      {
        id: "qwen3-embedding-code-retrieval-query",
        prefix:
          "Instruct: Given a code search query, retrieve relevant code passages that answer the query\nQuery:",
        suffix: "",
      },
    ],
    revision: "c25a394dd583836952667c12f008335071b3f43d",
    tokenizer: tokenizer("left", 1, 20),
  },
  "jinaai/jina-embeddings-v2-base-code": {
    applicationIndexingLimit: 512,
    assetProvenance: "huggingface-reviewed-onnx",
    canonicalModelId: "jinaai/jina-embeddings-v2-base-code",
    defaultDevice: "cpu",
    documentEncoding: noPrompt("jina-v2-code-symmetric-document"),
    execution: { cpu: cpuQ8 },
    license: { eligibleForTeamUse: true, identifier: "apache-2.0" },
    matryoshkaDimensions: [768],
    nativeContextLimit: 8_192,
    nativeDimension: 768,
    pooling: meanPooling,
    profileVersion: 1,
    queryEncoding: noPrompt("jina-v2-code-symmetric-query"),
    queryTaskAlternatives: [],
    revision: "516f4baf13dec4ddddda8631e019b5737c8bc250",
    tokenizer: tokenizer("right", 2, 2),
  },
} as const satisfies Readonly<Record<string, EmbeddingModelProfile>>);

export const UNAVAILABLE_EMBEDDING_CANDIDATES: readonly UnavailableEmbeddingCandidate[] =
  Object.freeze([
    {
      canonicalModelId: "nomic-ai/CodeRankEmbed",
      reason:
        "The pinned repository has no reviewed ONNX/Transformers.js artifact and requires remote custom code, which KBISS never executes.",
      revision: "3c4b60807d71f79b43f3c4363786d9493691f8b1",
    },
  ]);

export const DEFAULT_EMBEDDING_MODEL_ID = "Xenova/bge-small-en-v1.5" as const;

export function findEmbeddingModelProfile(modelId: string): EmbeddingModelProfile | undefined {
  return EMBEDDING_MODEL_PROFILES[modelId as keyof typeof EMBEDDING_MODEL_PROFILES];
}

export function validateEmbeddingModelProfile(profile: EmbeddingModelProfile): readonly string[] {
  const issues: string[] = [];
  if (!profile.canonicalModelId.trim()) issues.push("canonical model ID is empty");
  if (!/^[a-f0-9]{40}$/u.test(profile.revision))
    issues.push("revision is not a 40-character commit");
  if (!Number.isInteger(profile.profileVersion) || profile.profileVersion < 1)
    issues.push("profile version is invalid");
  if (!Number.isInteger(profile.nativeDimension) || profile.nativeDimension < 1)
    issues.push("native dimension is invalid");
  if (
    profile.matryoshkaDimensions.length === 0 ||
    !profile.matryoshkaDimensions.includes(profile.nativeDimension) ||
    profile.matryoshkaDimensions.some(
      (dimension, index) =>
        !Number.isInteger(dimension) ||
        dimension < 1 ||
        dimension > profile.nativeDimension ||
        profile.matryoshkaDimensions.indexOf(dimension) !== index,
    )
  )
    issues.push("Matryoshka dimensions are invalid");
  if (
    !Number.isInteger(profile.applicationIndexingLimit) ||
    profile.applicationIndexingLimit < 1 ||
    profile.applicationIndexingLimit > profile.nativeContextLimit
  )
    issues.push("application indexing limit is invalid");
  if (!profile.execution[profile.defaultDevice]) issues.push("default device is not executable");
  for (const [device, execution] of Object.entries(profile.execution)) {
    if (!execution) continue;
    if (execution.dtypes.length === 0 || !execution.dtypes.includes(execution.defaultDtype))
      issues.push(`${device} has no valid default dtype`);
    if (!Number.isInteger(execution.maximumBatchSize) || execution.maximumBatchSize < 1)
      issues.push(`${device} has an invalid maximum batch size`);
    if (
      !Number.isInteger(execution.maximumBatchTokens) ||
      execution.maximumBatchTokens < profile.applicationIndexingLimit
    )
      issues.push(`${device} has an invalid maximum batch token budget`);
    if (!Number.isInteger(execution.workerSessions) || execution.workerSessions < 1)
      issues.push(`${device} has an invalid Worker session count`);
    if (
      execution.shapePolicy === "fixed-buckets" &&
      (execution.tokenBuckets.length === 0 ||
        execution.tokenBuckets.some(
          (bucket, index) =>
            !Number.isInteger(bucket) ||
            bucket < 1 ||
            bucket > profile.applicationIndexingLimit ||
            (index > 0 && bucket <= (execution.tokenBuckets[index - 1] ?? 0)),
        ))
    )
      issues.push(`${device} has invalid accelerator token buckets`);
  }
  if (!profile.pooling.outputTensor.trim()) issues.push("pooling output tensor is empty");
  if (!profile.license.identifier.trim()) issues.push("license identifier is empty");
  for (const [kind, encoding] of [
    ["document", profile.documentEncoding],
    ["query", profile.queryEncoding],
  ] as const) {
    if (!encoding.id.trim() || !Number.isInteger(encoding.version) || encoding.version < 1)
      issues.push(`${kind} encoding identity is invalid`);
  }
  for (const value of [
    profile.tokenizer.promptTokenOverhead.document,
    profile.tokenizer.promptTokenOverhead.query,
  ]) {
    if (!Number.isInteger(value) || value < 0) issues.push("prompt token overhead is invalid");
  }
  return issues;
}

export function composeEmbeddingInput(encoding: EmbeddingEncodingConfig, text: string): string {
  return `${encoding.prefix}${text}${encoding.suffix}`;
}

export function resolveProfileDevice(
  profile: EmbeddingModelProfile,
  requested: ConfiguredEmbeddingDevice,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): EmbeddingDevice | undefined {
  if (requested !== "auto") return profile.execution[requested] ? requested : undefined;
  if (platform === "darwin" && architecture === "arm64" && profile.execution.webgpu) {
    return "webgpu";
  }
  return profile.execution[profile.defaultDevice] ? profile.defaultDevice : undefined;
}

export function embeddingConfigFromProfile(
  profile: EmbeddingModelProfile,
  device: EmbeddingDevice,
  quantization: DataType,
  vectorDimension: number,
): EmbeddingConfig {
  return {
    device,
    modelId: profile.canonicalModelId,
    nativeDimension: profile.nativeDimension,
    normalization: "l2",
    profile: {
      assetProvenance: profile.assetProvenance,
      documentEncoding: profile.documentEncoding,
      license: profile.license.identifier,
      pooling: profile.pooling,
      profileVersion: profile.profileVersion,
      queryEncoding: profile.queryEncoding,
      revision: profile.revision,
      tokenizer: profile.tokenizer,
    },
    quantization,
    vectorDimension,
  };
}
