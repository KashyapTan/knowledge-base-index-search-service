import { expect, test } from "bun:test";
import { TransformersEmbeddingProvider } from "./embedding-provider.ts";

const runLocalSmoke = Bun.env.KBISS_RUN_MODEL_SMOKE === "1";
const localCache = Bun.env.KBISS_MODEL_CACHE_DIR;

(runLocalSmoke ? test : test.skip)(
  "pinned q8 BGE-small loads only local assets through the real Worker",
  async () => {
    if (!localCache) {
      throw new Error("Set KBISS_MODEL_CACHE_DIR to the prepared BGE-small cache directory.");
    }
    const provider = new TransformersEmbeddingProvider(
      {
        modelId: "Xenova/bge-small-en-v1.5",
        normalization: "l2",
        quantization: "q8",
        vectorDimension: 384,
      },
      localCache,
      { batchSize: 2 },
    );
    try {
      // No setup opt-in is supplied, so the worker sets local_files_only and disables remote models.
      expect(await provider.warmUp()).toEqual({ ok: true, value: undefined });
      const result = await provider.embedDocuments([
        "Local private repository search.",
        "Exact identifiers and semantic descriptions.",
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
      for (const vector of result.value) {
        expect(vector).toHaveLength(384);
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        expect(Math.abs(norm - 1)).toBeLessThan(1e-3);
      }
    } finally {
      await provider.shutdown();
    }
  },
  120_000,
);
