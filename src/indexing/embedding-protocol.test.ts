import { describe, expect, test } from "bun:test";
import { EMBEDDING_MODEL_PROFILES, embeddingConfigFromProfile } from "../config/index.ts";
import {
  type EmbeddingWorkerConfig,
  validateEmbeddingVectorBatch,
  vectorViews,
} from "./embedding-protocol.ts";
import { EmbeddingWorkerClient } from "./embedding-worker-client.ts";

const profile = EMBEDDING_MODEL_PROFILES["Xenova/bge-small-en-v1.5"];
const embedding = embeddingConfigFromProfile(profile, "cpu", "q8", 384);
const workerConfig: EmbeddingWorkerConfig = {
  cacheDir: "/fixture/model-cache",
  device: embedding.device,
  documentEncoding: profile.documentEncoding,
  dtype: embedding.quantization,
  expectedDimension: embedding.vectorDimension,
  localFilesOnly: true,
  maximumTokens: profile.applicationIndexingLimit,
  modelId: embedding.modelId,
  nativeDimension: profile.nativeDimension,
  pooling: profile.pooling,
  profileVersion: profile.profileVersion,
  queryEncoding: profile.queryEncoding,
  revision: profile.revision,
  tokenizer: profile.tokenizer,
};

describe("contiguous embedding Worker protocol", () => {
  test("preserves row order with zero-copy typed views", () => {
    const storage = Float32Array.from([1, 2, 3, 4, 5, 6]);
    const batch = { count: 3, dimension: 2, storage };
    expect(() => validateEmbeddingVectorBatch(batch)).not.toThrow();
    const vectors = vectorViews(batch);
    expect(vectors.map((vector) => Array.from(vector))).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(vectors.every((vector) => vector.buffer === storage.buffer)).toBe(true);
    const secondVector = vectors[1];
    if (!secondVector) throw new Error("Expected a second vector view.");
    secondVector[0] = 30;
    expect(storage[2]).toBe(30);
  });

  test.each([
    { count: 0, dimension: 2, storage: new Float32Array() },
    { count: 2, dimension: 0, storage: new Float32Array() },
    { count: 2, dimension: 2, storage: new Float32Array(3) },
    { count: 1, dimension: 2, storage: Float32Array.from([1, Number.NaN]) },
    { count: 1, dimension: 1, storage: new Float32Array(new ArrayBuffer(8), 4, 1) },
  ])("rejects malformed storage %#", (batch) => {
    expect(() => validateEmbeddingVectorBatch(batch)).toThrow(/malformed contiguous|non-finite/u);
  });

  test("rejects detached storage ownership", () => {
    const storage = Float32Array.from([1, 0]);
    structuredClone(storage, { transfer: [storage.buffer] });
    expect(storage.byteLength).toBe(0);
    expect(() => validateEmbeddingVectorBatch({ count: 1, dimension: 2, storage })).toThrow(
      "malformed contiguous vector storage",
    );
  });

  test("client accepts transferred ownership and rejects malformed or detached responses", async () => {
    let messageHandler: ((event: MessageEvent) => void) | null = null;
    const originalBuffers: ArrayBuffer[] = [];
    let mode: "valid" | "malformed" | "detached" = "valid";
    const client = new EmbeddingWorkerClient("fixture:transfer", () => {
      const worker = {
        get onmessage() {
          return messageHandler;
        },
        set onmessage(value) {
          messageHandler = value;
        },
        onerror: null,
        postMessage(request: { kind: string; requestId: string }) {
          if (request.kind === "shutdown") {
            queueMicrotask(() =>
              messageHandler?.({
                data: { kind: "stopped", requestId: request.requestId },
              } as MessageEvent),
            );
            return;
          }
          if (request.kind === "initialize") {
            queueMicrotask(() =>
              messageHandler?.({
                data: {
                  kind: "ready",
                  requestId: request.requestId,
                  modelId: workerConfig.modelId,
                  profileVersion: workerConfig.profileVersion,
                  revision: workerConfig.revision,
                },
              } as MessageEvent),
            );
            return;
          }
          const sender = Float32Array.from(mode === "malformed" ? [1] : [1, 0, 0, 1]);
          const receiver = structuredClone(sender, { transfer: [sender.buffer] });
          originalBuffers.push(sender.buffer);
          if (mode === "detached") structuredClone(receiver, { transfer: [receiver.buffer] });
          queueMicrotask(() =>
            messageHandler?.({
              data: {
                kind: "embeddings",
                requestId: request.requestId,
                count: 2,
                dimension: 2,
                storage: receiver,
              },
            } as MessageEvent),
          );
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    });

    await client.initialize(workerConfig);
    const valid = await client.embed(["one", "two"]);
    expect(Array.from(valid.storage)).toEqual([1, 0, 0, 1]);
    expect(originalBuffers[0]?.byteLength).toBe(0);
    mode = "malformed";
    await expect(client.embed(["one", "two"])).rejects.toThrow("malformed contiguous");
    mode = "detached";
    await expect(client.embed(["one", "two"])).rejects.toThrow("malformed contiguous");
    await client.close();
  });

  test("client rejects a Worker that acknowledges a different immutable profile", async () => {
    let messageHandler: ((event: MessageEvent) => void) | null = null;
    const client = new EmbeddingWorkerClient("fixture:wrong-profile", () => {
      const worker = {
        get onmessage() {
          return messageHandler;
        },
        set onmessage(value) {
          messageHandler = value;
        },
        onerror: null,
        postMessage(request: { requestId: string }) {
          queueMicrotask(() =>
            messageHandler?.({
              data: {
                kind: "ready",
                requestId: request.requestId,
                modelId: workerConfig.modelId,
                profileVersion: workerConfig.profileVersion,
                revision: "f".repeat(40),
              },
            } as MessageEvent),
          );
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    });
    await expect(client.initialize(workerConfig)).rejects.toThrow("unexpected model profile");
  });
});
