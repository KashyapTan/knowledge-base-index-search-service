import { describe, expect, test } from "bun:test";
import type { PreTrainedTokenizer } from "@huggingface/transformers";
import { createTransformersTokenCounter, createUnicodeWordTokenCounter } from "./tokenizer.ts";

describe("token counters", () => {
  test("adapts the selected Transformers tokenizer including special tokens", () => {
    const calls: unknown[] = [];
    const fake = {
      encode(text: string, options: unknown) {
        calls.push([text, options]);
        return [101, 10, 11, 102];
      },
    } as unknown as PreTrainedTokenizer;
    expect(createTransformersTokenCounter(fake).count("gateway")).toBe(4);
    expect(calls).toEqual([["gateway", { add_special_tokens: true }]]);
  });

  test("provides a deterministic Unicode-aware offline counter", () => {
    const counter = createUnicodeWordTokenCounter();
    expect(counter.count("hello, 世界! retry_1")).toBe(7);
    expect(counter.count("")).toBe(2);
  });
});
