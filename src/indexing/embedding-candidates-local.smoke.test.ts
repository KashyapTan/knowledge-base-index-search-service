import { expect, test } from "bun:test";
import type { DataType } from "@huggingface/transformers";
import { EMBEDDING_MODEL_PROFILES, embeddingConfigFromProfile } from "../config/index.ts";
import { TransformersEmbeddingProvider } from "./embedding-provider.ts";

const runCandidateSmokes = Bun.env.KBISS_RUN_CANDIDATE_MODEL_SMOKES === "1";

const candidates = [
  ["Xenova/bge-small-en-v1.5", "KBISS_BGE_SMALL_CACHE_DIR", "q8", 384],
  ["Xenova/bge-base-en-v1.5", "KBISS_BGE_BASE_CACHE_DIR", "q8", 768],
  ["Alibaba-NLP/gte-modernbert-base", "KBISS_GTE_MODERNBERT_CACHE_DIR", "q8", 768],
  ["onnx-community/embeddinggemma-300m-ONNX", "KBISS_EMBEDDINGGEMMA_CACHE_DIR", "q8", 256],
  ["onnx-community/Qwen3-Embedding-0.6B-ONNX", "KBISS_QWEN3_EMBEDDING_CACHE_DIR", "q8", 512],
  ["jinaai/jina-embeddings-v2-base-code", "KBISS_JINA_CODE_CACHE_DIR", "q8", 768],
] as const;

function dot(left: Iterable<number>, right: Iterable<number>): number {
  const rightValues = Array.from(right);
  let score = 0;
  let index = 0;
  for (const value of left) {
    score += value * (rightValues[index] ?? 0);
    index += 1;
  }
  return score;
}

for (const [modelId, cacheVariable, dtype, dimension] of candidates) {
  const cacheDir = Bun.env[cacheVariable];
  (runCandidateSmokes && cacheDir ? test : test.skip)(
    `${modelId} executes its pinned offline profile and retrieval convention`,
    async () => {
      if (!cacheDir) throw new Error(`Set ${cacheVariable} to this profile's prepared cache.`);
      const profile = EMBEDDING_MODEL_PROFILES[modelId];
      const provider = new TransformersEmbeddingProvider(
        embeddingConfigFromProfile(profile, "cpu", dtype as DataType, dimension),
        cacheDir,
        { batchSize: 2, profile, workerCount: 1 },
      );
      try {
        expect(await provider.warmUp()).toEqual({ ok: true, value: undefined });
        const query = await provider.embedQuery(
          "How can a TypeScript client retry transient requests with exponential backoff?",
        );
        const documents = await provider.embedDocuments([
          "TypeScript retry helper uses exponential backoff for transient network failures.",
          "Astronomy notes describe the rings and moons surrounding Saturn.",
        ]);
        expect(query.ok).toBe(true);
        expect(documents.ok).toBe(true);
        if (!query.ok || !documents.ok) return;
        expect(query.value).toHaveLength(dimension);
        expect(documents.value.every((vector) => vector.length === dimension)).toBe(true);
        expect(dot(query.value, documents.value[0] ?? [])).toBeGreaterThan(
          dot(query.value, documents.value[1] ?? []),
        );
        for (const vector of [query.value, ...documents.value]) {
          expect(Math.abs(Math.sqrt(dot(vector, vector)) - 1)).toBeLessThan(1e-3);
        }
      } finally {
        await provider.shutdown();
      }
    },
    180_000,
  );
}
