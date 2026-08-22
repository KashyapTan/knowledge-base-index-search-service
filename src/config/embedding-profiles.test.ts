import { describe, expect, test } from "bun:test";
import {
  composeEmbeddingInput,
  EMBEDDING_MODEL_PROFILES,
  embeddingConfigFromProfile,
  findEmbeddingModelProfile,
  resolveProfileDevice,
  UNAVAILABLE_EMBEDDING_CANDIDATES,
  validateEmbeddingModelProfile,
} from "./embedding-profiles.ts";

describe("versioned embedding model profiles", () => {
  test("pins and validates every selectable production profile", () => {
    expect(Object.keys(EMBEDDING_MODEL_PROFILES)).toHaveLength(6);
    for (const [modelId, profile] of Object.entries(EMBEDDING_MODEL_PROFILES)) {
      expect(profile.canonicalModelId).toBe(modelId);
      expect(profile.revision).toMatch(/^[a-f0-9]{40}$/u);
      expect(validateEmbeddingModelProfile(profile)).toEqual([]);
      expect(profile.license.eligibleForTeamUse).toBe(true);
      expect(profile.execution.cpu?.dtypes).toContain(profile.execution.cpu?.defaultDtype);
    }
    expect(
      new Set(Object.values(EMBEDDING_MODEL_PROFILES).map((profile) => profile.revision)).size,
    ).toBe(6);
  });

  test("documents CodeRankEmbed as unavailable instead of executing custom code", () => {
    expect(UNAVAILABLE_EMBEDDING_CANDIDATES).toEqual([
      expect.objectContaining({
        canonicalModelId: "nomic-ai/CodeRankEmbed",
        reason: expect.stringContaining("no reviewed ONNX/Transformers.js artifact"),
      }),
    ]);
    expect(findEmbeddingModelProfile("nomic-ai/CodeRankEmbed")).toBeUndefined();
  });

  test("derives immutable compatibility fields and composes distinct query/document prompts", () => {
    const gemma = EMBEDDING_MODEL_PROFILES["onnx-community/embeddinggemma-300m-ONNX"];
    const config = embeddingConfigFromProfile(gemma, "cpu", "q8", 256);
    expect(config).toMatchObject({
      modelId: gemma.canonicalModelId,
      nativeDimension: 768,
      vectorDimension: 256,
      profile: {
        profileVersion: 1,
        revision: gemma.revision,
        pooling: { strategy: "model-output", outputTensor: "sentence_embedding" },
      },
    });
    expect(composeEmbeddingInput(gemma.queryEncoding, "find retries")).toBe(
      "task: search result | query: find retries",
    );
    expect(composeEmbeddingInput(gemma.documentEncoding, "retry.ts")).toBe(
      "title: none | text: retry.ts",
    );
  });

  test("auto device selection uses only reviewed execution paths", () => {
    const bge = EMBEDDING_MODEL_PROFILES["Xenova/bge-small-en-v1.5"];
    const gte = EMBEDDING_MODEL_PROFILES["Alibaba-NLP/gte-modernbert-base"];
    expect(resolveProfileDevice(bge, "auto", "darwin", "arm64")).toBe("webgpu");
    expect(resolveProfileDevice(bge, "auto", "linux", "x64")).toBe("cpu");
    expect(resolveProfileDevice(gte, "auto", "darwin", "arm64")).toBe("cpu");
    expect(resolveProfileDevice(gte, "webgpu", "darwin", "arm64")).toBeUndefined();
  });

  test("reports invalid revisions, dimensions, limits, execution, buckets, prompts, and license metadata", () => {
    const valid = EMBEDDING_MODEL_PROFILES["Xenova/bge-small-en-v1.5"];
    const invalid = {
      ...valid,
      applicationIndexingLimit: 999,
      canonicalModelId: " ",
      defaultDevice: "coreml" as const,
      execution: {
        webgpu: {
          defaultDtype: "fp16" as const,
          dtypes: [] as const,
          maximumBatchSize: 0,
          maximumBatchTokens: 0,
          shapePolicy: "fixed-buckets" as const,
          tokenBuckets: [128, 64, 999],
          workerSessions: 0,
        },
      },
      license: { eligibleForTeamUse: false, identifier: "" },
      matryoshkaDimensions: [385, 385],
      pooling: { ...valid.pooling, outputTensor: "" },
      profileVersion: 0,
      queryEncoding: { ...valid.queryEncoding, id: "", version: 0 },
      revision: "main",
      tokenizer: {
        ...valid.tokenizer,
        promptTokenOverhead: { document: -1, query: 2 },
      },
    };
    expect(validateEmbeddingModelProfile(invalid)).toEqual(
      expect.arrayContaining([
        "canonical model ID is empty",
        "revision is not a 40-character commit",
        "profile version is invalid",
        "Matryoshka dimensions are invalid",
        "application indexing limit is invalid",
        "default device is not executable",
        "webgpu has no valid default dtype",
        "webgpu has an invalid maximum batch size",
        "webgpu has an invalid maximum batch token budget",
        "webgpu has an invalid Worker session count",
        "webgpu has invalid accelerator token buckets",
        "pooling output tensor is empty",
        "license identifier is empty",
        "query encoding identity is invalid",
        "prompt token overhead is invalid",
      ]),
    );
  });
});
