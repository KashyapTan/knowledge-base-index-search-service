import { describe, expect, test } from "bun:test";
import type { EmbeddingPoolingConfig } from "../config/index.ts";
import { type EmbeddingTensorData, poolEmbeddingTensors } from "./pooling.ts";

const tokenTensor: EmbeddingTensorData = {
  dims: [2, 3, 3],
  data: Float32Array.from([1, 0, 0, 0, 2, 0, 100, 100, 100, 100, 100, 100, 0, 0, 3, 0, 4, 0]),
};

const mask: EmbeddingTensorData = {
  dims: [2, 3],
  data: BigInt64Array.from([1n, 1n, 0n, 0n, 1n, 1n]),
};

function pooling(
  strategy: EmbeddingPoolingConfig["strategy"],
  overrides: Partial<EmbeddingPoolingConfig> = {},
): EmbeddingPoolingConfig {
  return {
    modelOutputNormalized: false,
    outputTensor: strategy === "model-output" ? "sentence_embedding" : "last_hidden_state",
    strategy,
    version: 1,
    ...overrides,
  };
}

function rows(values: Float32Array, dimension = 3): number[][] {
  return Array.from({ length: values.length / dimension }, (_, index) =>
    Array.from(values.slice(index * dimension, (index + 1) * dimension)),
  );
}

describe("profile-aware embedding pooling", () => {
  test("mean pooling masks both left and right padding before normalization", () => {
    const result = poolEmbeddingTensors({
      attentionMask: mask,
      expectedCount: 2,
      nativeDimension: 3,
      outputDimension: 3,
      outputs: { last_hidden_state: tokenTensor },
      pooling: pooling("mean"),
    });
    expect(rows(result)[0]?.[0]).toBeCloseTo(0.4472136, 6);
    expect(rows(result)[0]?.[1]).toBeCloseTo(0.8944272, 6);
    expect(rows(result)[1]?.[1]).toBeCloseTo(0.8, 6);
    expect(rows(result)[1]?.[2]).toBeCloseTo(0.6, 6);
  });

  test("CLS selects the documented first token without tensor fallback", () => {
    const result = poolEmbeddingTensors({
      attentionMask: { dims: [2, 3], data: [1, 1, 0, 1, 1, 0] },
      expectedCount: 2,
      nativeDimension: 3,
      outputDimension: 3,
      outputs: { last_hidden_state: tokenTensor, logits: { dims: [1], data: [999] } },
      pooling: pooling("cls"),
    });
    expect(rows(result)).toEqual([
      [1, 0, 0],
      [expect.closeTo(0.57735026, 6), expect.closeTo(0.57735026, 6), expect.closeTo(0.57735026, 6)],
    ]);
  });

  test("last-token pooling follows the attention mask for right and left padding", () => {
    const result = poolEmbeddingTensors({
      attentionMask: mask,
      expectedCount: 2,
      nativeDimension: 3,
      outputDimension: 3,
      outputs: { last_hidden_state: tokenTensor },
      pooling: pooling("last-token"),
    });
    expect(rows(result)).toEqual([
      [0, 1, 0],
      [0, 1, 0],
    ]);
  });

  test("named model output is selected directly and Matryoshka truncation renormalizes", () => {
    const tail = Math.sqrt(0.28);
    const named = { dims: [1, 3], data: Float32Array.from([0.6, 0.6, tail]) };
    const full = poolEmbeddingTensors({
      expectedCount: 1,
      nativeDimension: 3,
      outputDimension: 3,
      outputs: { sentence_embedding: named },
      pooling: pooling("model-output", { modelOutputNormalized: true }),
    });
    expect(Array.from(full)).toEqual([
      expect.closeTo(0.6, 6),
      expect.closeTo(0.6, 6),
      expect.closeTo(tail, 6),
    ]);

    const truncated = poolEmbeddingTensors({
      expectedCount: 1,
      nativeDimension: 3,
      outputDimension: 2,
      outputs: { sentence_embedding: named },
      pooling: pooling("model-output", { modelOutputNormalized: true }),
    });
    expect(Array.from(truncated)).toEqual([
      expect.closeTo(Math.SQRT1_2, 6),
      expect.closeTo(Math.SQRT1_2, 6),
    ]);
  });

  test.each([
    ["missing required tensor", () => ({ outputs: {} })],
    [
      "wrong token shape",
      () => ({ outputs: { last_hidden_state: { dims: [2, 3, 2], data: tokenTensor.data } } }),
    ],
    ["wrong mask shape", () => ({ attentionMask: { dims: [2, 2], data: [1, 1, 1, 1] } })],
    ["empty mask row", () => ({ attentionMask: { dims: [2, 3], data: [0, 0, 0, 0, 1, 1] } })],
    ["invalid mask value", () => ({ attentionMask: { dims: [2, 3], data: [1, 2, 0, 0, 1, 1] } })],
    [
      "non-finite tensor",
      () => ({
        outputs: { last_hidden_state: { dims: [1, 1, 3], data: [1, Number.NaN, 0] } },
        expectedCount: 1,
        attentionMask: { dims: [1, 1], data: [1] },
      }),
    ],
  ])("rejects %s", (_name, change) => {
    expect(() =>
      poolEmbeddingTensors({
        attentionMask: mask,
        expectedCount: 2,
        nativeDimension: 3,
        outputDimension: 3,
        outputs: { last_hidden_state: tokenTensor },
        pooling: pooling("mean"),
        ...change(),
      }),
    ).toThrow();
  });

  test("rejects malformed named output, zero magnitude, and falsely normalized output", () => {
    const base = {
      expectedCount: 1,
      nativeDimension: 3,
      outputDimension: 3,
      pooling: pooling("model-output", { modelOutputNormalized: true }),
    } as const;
    expect(() =>
      poolEmbeddingTensors({
        ...base,
        outputs: { sentence_embedding: { dims: [1, 2], data: [1, 0] } },
      }),
    ).toThrow("shaped");
    expect(() =>
      poolEmbeddingTensors({
        ...base,
        outputs: { sentence_embedding: { dims: [1, 3], data: [0, 0, 0] } },
      }),
    ).toThrow("magnitude");
    expect(() =>
      poolEmbeddingTensors({
        ...base,
        outputs: { sentence_embedding: { dims: [1, 3], data: [1, 1, 0] } },
      }),
    ).toThrow("L2-normalized");
  });
});
