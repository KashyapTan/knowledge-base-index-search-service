import type { PreTrainedTokenizer } from "@huggingface/transformers";
import { composeEmbeddingInput, type EmbeddingEncodingConfig } from "../config/index.ts";
import type { TokenCounter } from "./contracts.ts";

export interface TransformersTokenCounterOptions {
  readonly addSpecialTokens?: boolean;
  readonly encoding?: EmbeddingEncodingConfig;
  readonly expectedPromptTokenOverhead?: number;
}

export function createTransformersTokenCounter(
  tokenizer: PreTrainedTokenizer,
  options: TransformersTokenCounterOptions = {},
): TokenCounter {
  const encoding = options.encoding ?? { id: "identity", prefix: "", suffix: "", version: 1 };
  const addSpecialTokens = options.addSpecialTokens ?? true;
  if (options.expectedPromptTokenOverhead !== undefined) {
    const actual = tokenizer.encode(composeEmbeddingInput(encoding, ""), {
      add_special_tokens: addSpecialTokens,
    }).length;
    if (actual !== options.expectedPromptTokenOverhead) {
      throw new TypeError(
        `The tokenizer prompt overhead changed: expected ${options.expectedPromptTokenOverhead}, received ${actual}.`,
      );
    }
  }
  return {
    count(text: string): number {
      return tokenizer.encode(composeEmbeddingInput(encoding, text), {
        add_special_tokens: addSpecialTokens,
      }).length;
    },
  };
}

/** A deterministic test/development counter. Production indexing injects the model tokenizer. */
export function createUnicodeWordTokenCounter(): TokenCounter {
  return {
    count(text: string): number {
      const tokens = text.match(/[\p{L}\p{N}_]+|[^\s]/gu);
      return (tokens?.length ?? 0) + 2;
    },
  };
}
