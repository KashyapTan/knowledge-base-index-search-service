import type { PreTrainedTokenizer } from "@huggingface/transformers";
import type { TokenCounter } from "./contracts.ts";

export function createTransformersTokenCounter(tokenizer: PreTrainedTokenizer): TokenCounter {
  return {
    count(text: string): number {
      return tokenizer.encode(text, { add_special_tokens: true }).length;
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
