import type { EmbeddingPoolingConfig } from "../config/index.ts";

export interface EmbeddingTensorData {
  readonly data: ArrayLike<number | bigint>;
  readonly dims: readonly number[];
}

export interface PoolEmbeddingOptions {
  readonly attentionMask?: EmbeddingTensorData;
  readonly expectedCount: number;
  readonly nativeDimension: number;
  readonly outputDimension: number;
  readonly outputs: Readonly<Record<string, EmbeddingTensorData | undefined>>;
  readonly pooling: EmbeddingPoolingConfig;
}

function tensorValue(tensor: EmbeddingTensorData, index: number): number {
  const value = Number(tensor.data[index]);
  if (!Number.isFinite(value)) throw new Error("The model returned a non-finite tensor value.");
  return value;
}

function validateMask(
  mask: EmbeddingTensorData | undefined,
  count: number,
  sequence: number,
): void {
  if (mask?.dims.length !== 2 || mask.dims[0] !== count || mask.dims[1] !== sequence) {
    throw new Error(`Expected an attention mask shaped [${count}, ${sequence}].`);
  }
  if (mask.data.length !== count * sequence) {
    throw new Error("The attention mask storage length is invalid.");
  }
}

function normalizeRows(
  values: Float32Array,
  count: number,
  dimension: number,
  mustAlreadyBeNormalized: boolean,
): void {
  for (let row = 0; row < count; row += 1) {
    const offset = row * dimension;
    let squared = 0;
    for (let column = 0; column < dimension; column += 1) {
      const value = values[offset + column];
      if (value === undefined || !Number.isFinite(value))
        throw new Error("The pooled embedding contains a non-finite value.");
      squared += value * value;
    }
    const norm = Math.sqrt(squared);
    if (!Number.isFinite(norm) || norm <= 1e-12)
      throw new Error("The pooled embedding has zero or invalid magnitude.");
    if (mustAlreadyBeNormalized) {
      if (Math.abs(norm - 1) > 1e-3)
        throw new Error("The model output tensor was expected to be L2-normalized.");
      continue;
    }
    for (let column = 0; column < dimension; column += 1) {
      values[offset + column] = (values[offset + column] ?? 0) / norm;
    }
  }
}

export function poolEmbeddingTensors(options: PoolEmbeddingOptions): Float32Array {
  const tensor = options.outputs[options.pooling.outputTensor];
  if (!tensor) {
    throw new Error(
      `The embedding model did not return the required ${options.pooling.outputTensor} tensor.`,
    );
  }
  if (
    !Number.isInteger(options.expectedCount) ||
    options.expectedCount < 1 ||
    !Number.isInteger(options.nativeDimension) ||
    options.nativeDimension < 1 ||
    !Number.isInteger(options.outputDimension) ||
    options.outputDimension < 1 ||
    options.outputDimension > options.nativeDimension
  ) {
    throw new Error("The requested embedding count or dimension is invalid.");
  }

  const { expectedCount: count, nativeDimension, outputDimension } = options;
  const values = new Float32Array(count * outputDimension);
  if (options.pooling.strategy === "model-output") {
    if (
      tensor.dims.length !== 2 ||
      tensor.dims[0] !== count ||
      tensor.dims[1] !== nativeDimension ||
      tensor.data.length !== count * nativeDimension
    ) {
      throw new Error(
        `Expected ${options.pooling.outputTensor} shaped [${count}, ${nativeDimension}].`,
      );
    }
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < outputDimension; column += 1) {
        values[row * outputDimension + column] = tensorValue(
          tensor,
          row * nativeDimension + column,
        );
      }
    }
  } else {
    if (
      tensor.dims.length !== 3 ||
      tensor.dims[0] !== count ||
      tensor.dims[2] !== nativeDimension
    ) {
      throw new Error(
        `Expected ${options.pooling.outputTensor} shaped [${count}, sequence, ${nativeDimension}].`,
      );
    }
    const sequence = tensor.dims[1];
    if (!sequence || tensor.data.length !== count * sequence * nativeDimension) {
      throw new Error("The token embedding tensor storage length is invalid.");
    }
    validateMask(options.attentionMask, count, sequence);

    for (let row = 0; row < count; row += 1) {
      let selectedTokens = 0;
      let lastToken = -1;
      for (let token = 0; token < sequence; token += 1) {
        const maskValue = tensorValue(
          options.attentionMask as EmbeddingTensorData,
          row * sequence + token,
        );
        if (maskValue !== 0 && maskValue !== 1)
          throw new Error("The attention mask must contain only zero and one values.");
        if (maskValue === 1) {
          selectedTokens += 1;
          lastToken = token;
        }
      }
      if (selectedTokens === 0 || lastToken < 0)
        throw new Error("The attention mask contains an empty input row.");

      if (options.pooling.strategy === "cls") {
        if (tensorValue(options.attentionMask as EmbeddingTensorData, row * sequence) !== 1)
          throw new Error("CLS pooling requires an active first token.");
        for (let column = 0; column < outputDimension; column += 1) {
          values[row * outputDimension + column] = tensorValue(
            tensor,
            row * sequence * nativeDimension + column,
          );
        }
        continue;
      }

      if (options.pooling.strategy === "last-token") {
        for (let column = 0; column < outputDimension; column += 1) {
          values[row * outputDimension + column] = tensorValue(
            tensor,
            (row * sequence + lastToken) * nativeDimension + column,
          );
        }
        continue;
      }

      for (let token = 0; token < sequence; token += 1) {
        if (tensorValue(options.attentionMask as EmbeddingTensorData, row * sequence + token) === 0)
          continue;
        for (let column = 0; column < outputDimension; column += 1) {
          const target = row * outputDimension + column;
          values[target] =
            (values[target] ?? 0) +
            tensorValue(tensor, (row * sequence + token) * nativeDimension + column);
        }
      }
      for (let column = 0; column < outputDimension; column += 1) {
        const target = row * outputDimension + column;
        values[target] = (values[target] ?? 0) / selectedTokens;
      }
    }
  }

  const matryoshkaTruncated = outputDimension !== nativeDimension;
  normalizeRows(
    values,
    count,
    outputDimension,
    options.pooling.modelOutputNormalized && !matryoshkaTruncated,
  );
  return values;
}
