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

  test("accounts for the exact profile prompt and rejects changed overhead", () => {
    const calls: Array<[string, { add_special_tokens: boolean }]> = [];
    const fake = {
      encode(text: string, options: { add_special_tokens: boolean }) {
        calls.push([text, options]);
        return Array.from({ length: text.length + (options.add_special_tokens ? 2 : 0) });
      },
    } as unknown as PreTrainedTokenizer;
    const encoding = { id: "document-v1", prefix: "doc: ", suffix: "!", version: 1 };
    const counter = createTransformersTokenCounter(fake, {
      addSpecialTokens: true,
      encoding,
      expectedPromptTokenOverhead: 8,
    });
    expect(counter.count("retry")).toBe(13);
    expect(calls).toEqual([
      ["doc: !", { add_special_tokens: true }],
      ["doc: retry!", { add_special_tokens: true }],
    ]);
    expect(() =>
      createTransformersTokenCounter(fake, {
        encoding,
        expectedPromptTokenOverhead: 7,
      }),
    ).toThrow("prompt overhead changed");
  });

  test("provides a deterministic Unicode-aware offline counter", () => {
    const counter = createUnicodeWordTokenCounter();
    expect(counter.count("hello, 世界! retry_1")).toBe(7);
    expect(counter.count("")).toBe(2);
  });
});
