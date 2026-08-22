import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingWorkerConfig } from "./embedding-protocol.ts";
import {
  acceleratorTokenBucket,
  createTransformersEmbeddingProvider,
  type EmbeddingWorkerBoundary,
  TransformersEmbeddingProvider,
} from "./embedding-provider.ts";
import { EmbeddingWorkerClient, EmbeddingWorkerError } from "./embedding-worker-client.ts";
import { FakeEmbeddingProvider } from "./fake-embedding-provider.ts";
import {
  inspectModelAssets,
  quarantineModelCache,
  verifyOrWriteModelAssetManifest,
} from "./model-assets.ts";
import { indexingConfig } from "./test-helpers.ts";

let fixture = "";

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "kbiss-embedding-provider-"));
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

const embedding = {
  device: "cpu" as const,
  modelId: "kbiss/fake-model",
  normalization: "l2" as const,
  quantization: "fp32" as const,
  vectorDimension: 2,
};

describe("model asset integrity", () => {
  const identity = {
    device: embedding.device,
    modelId: embedding.modelId,
    quantization: embedding.quantization,
    vectorDimension: embedding.vectorDimension,
    maximumTokens: 512,
    normalization: embedding.normalization,
  };

  test("records checksums and rejects changed cached assets", async () => {
    const cache = join(fixture, "models");
    await mkdir(join(cache, "model"), { recursive: true });
    const asset = join(cache, "model", "weights.onnx");
    await writeFile(asset, "weights-one");
    const identity = {
      device: embedding.device,
      modelId: embedding.modelId,
      quantization: embedding.quantization,
      vectorDimension: embedding.vectorDimension,
      maximumTokens: 512,
      normalization: embedding.normalization,
    };
    expect(await verifyOrWriteModelAssetManifest(cache, identity, "write-if-missing")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await verifyOrWriteModelAssetManifest(cache, identity, "verify")).toEqual({
      ok: true,
      value: undefined,
    });
    await writeFile(asset, "weights-two");
    await utimes(asset, new Date(1000), new Date(1000));
    const changed = await verifyOrWriteModelAssetManifest(cache, identity, "verify");
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe("MODEL_ASSETS_INVALID");
  });

  test("rejects malformed and model-incompatible manifests", async () => {
    const cache = join(fixture, "models");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "kbiss-model-assets.json"), "not-json");
    const provider = new TransformersEmbeddingProvider(embedding, cache, {
      worker: new RecordingWorker(cache),
    });
    const result = await provider.warmUp();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MODEL_ASSETS_INVALID");
    await provider.shutdown();
  });

  test("rejects cached asset symlinks after a manifest is written", async () => {
    const cache = join(fixture, "symlink-models");
    await mkdir(cache, { recursive: true });
    const asset = join(cache, "weights.bin");
    const outside = join(fixture, "outside.bin");
    await writeFile(asset, "same bytes");
    await writeFile(outside, "same bytes");
    const identity = {
      device: embedding.device,
      modelId: embedding.modelId,
      quantization: embedding.quantization,
      vectorDimension: embedding.vectorDimension,
      maximumTokens: 512,
      normalization: embedding.normalization,
    };
    expect((await verifyOrWriteModelAssetManifest(cache, identity, "write-if-missing")).ok).toBe(
      true,
    );
    await rm(asset);
    await symlink(outside, asset);
    const verified = await verifyOrWriteModelAssetManifest(cache, identity, "verify");
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.error.code).toBe("MODEL_ASSETS_INVALID");
  });

  test("inspects missing, unreadable, mismatched, and incomplete asset caches", async () => {
    const missing = join(fixture, "missing-models");
    expect(await inspectModelAssets(missing, identity)).toMatchObject({ state: "missing" });
    expect(await verifyOrWriteModelAssetManifest(missing, identity, "verify")).toEqual({
      ok: true,
      value: undefined,
    });
    expect((await verifyOrWriteModelAssetManifest(missing, identity, "write-if-missing")).ok).toBe(
      false,
    );

    const unreadableManifest = join(fixture, "unreadable-manifest");
    await mkdir(join(unreadableManifest, "kbiss-model-assets.json"), { recursive: true });
    expect(await inspectModelAssets(unreadableManifest, identity)).toMatchObject({
      state: "corrupt",
    });

    const mismatch = join(fixture, "mismatch-models");
    await mkdir(mismatch);
    await writeFile(join(mismatch, "weights.bin"), "weights");
    expect((await verifyOrWriteModelAssetManifest(mismatch, identity, "write-if-missing")).ok).toBe(
      true,
    );
    expect(
      await inspectModelAssets(mismatch, { ...identity, modelId: "kbiss/different-model" }),
    ).toMatchObject({ state: "corrupt" });
    await rm(join(mismatch, "weights.bin"));
    expect(await inspectModelAssets(mismatch, identity)).toMatchObject({ state: "corrupt" });
  });

  test("quarantines present caches, initializes missing caches, and reports unsafe failures", async () => {
    const missing = join(fixture, "new-cache");
    expect(await quarantineModelCache(missing)).toEqual({ ok: true, value: undefined });
    const present = join(fixture, "present-cache");
    await mkdir(present);
    await writeFile(join(present, "asset"), "asset");
    const quarantined = await quarantineModelCache(present);
    expect(quarantined.ok).toBe(true);
    if (quarantined.ok)
      expect(await Bun.file(join(quarantined.value as string, "asset")).exists()).toBe(true);

    const blockedParent = join(fixture, "blocked-parent");
    await writeFile(blockedParent, "file");
    expect((await quarantineModelCache(join(blockedParent, "cache"))).ok).toBe(false);

    const symlinkCache = join(fixture, "write-symlink-cache");
    await mkdir(symlinkCache);
    await symlink(join(fixture, "outside.bin"), join(symlinkCache, "linked.bin"));
    expect(
      (await verifyOrWriteModelAssetManifest(symlinkCache, identity, "write-if-missing")).ok,
    ).toBe(false);
  });
});

class RecordingWorker implements EmbeddingWorkerBoundary {
  readonly configs: EmbeddingWorkerConfig[] = [];
  readonly embedMaximumTokens: Array<number | undefined> = [];
  readonly #cache: string;
  readonly #failLocal: boolean;
  closeCalls = 0;

  constructor(cache: string, failLocal = false) {
    this.#cache = cache;
    this.#failLocal = failLocal;
  }

  async initialize(config: EmbeddingWorkerConfig): Promise<void> {
    this.configs.push(config);
    if (config.localFilesOnly && this.#failLocal) {
      throw new EmbeddingWorkerError({
        kind: "error",
        requestId: "test",
        code: "MODEL_ASSETS_MISSING",
        message: "Assets are missing.",
      });
    }
    await mkdir(this.#cache, { recursive: true });
    await writeFile(join(this.#cache, "weights.bin"), "local weights");
  }

  async embed(
    texts: readonly string[],
    maximumTokens?: number,
  ): Promise<readonly (readonly number[])[]> {
    this.embedMaximumTokens.push(maximumTokens);
    return texts.map(() => [1, 0]);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class ConcurrentWorker implements EmbeddingWorkerBoundary {
  readonly #cache: string;
  readonly #state: { active: number; maxActive: number };
  initializeCalls = 0;
  closeCalls = 0;

  constructor(cache: string, state: { active: number; maxActive: number }) {
    this.#cache = cache;
    this.#state = state;
  }

  async initialize(): Promise<void> {
    this.initializeCalls += 1;
    await mkdir(this.#cache, { recursive: true });
    await writeFile(join(this.#cache, "weights.bin"), "local weights");
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    this.#state.active += 1;
    this.#state.maxActive = Math.max(this.#state.maxActive, this.#state.active);
    await Bun.sleep(20);
    this.#state.active -= 1;
    return texts.map(() => [1, 0]);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

describe("Transformers provider orchestration", () => {
  test("uses fixed accelerator token buckets and restores original vector order", async () => {
    expect([1, 64, 65, 384, 385, 900].map((count) => acceleratorTokenBucket(count, 512))).toEqual([
      64, 64, 128, 384, 512, 512,
    ]);
    const cache = join(fixture, "bucketed-models");
    const worker = new RecordingWorker(cache);
    worker.embed = async (texts, maximumTokens) => {
      worker.embedMaximumTokens.push(maximumTokens);
      return texts.map((text) =>
        text === "short" ? [1, 0] : text === "medium" ? [0, 1] : [-1, 0],
      );
    };
    const provider = new TransformersEmbeddingProvider(
      { ...embedding, device: "webgpu", quantization: "fp16" },
      cache,
      { batchSize: 16, worker },
    );
    expect((await provider.warmUp({ allowDownload: true })).ok).toBe(true);
    expect(
      await provider.embedDocuments(["long", "short", "medium"], {
        tokenCounts: [300, 10, 70],
      }),
    ).toEqual({
      ok: true,
      value: [
        [-1, 0],
        [1, 0],
        [0, 1],
      ],
    });
    expect(worker.embedMaximumTokens).toEqual([64, 128, 384]);
    const invalid = await provider.embedDocuments(["one", "two"], { tokenCounts: [1] });
    expect(invalid).toMatchObject({ ok: false, error: { code: "INFERENCE_FAILED" } });
    await provider.shutdown();
  });

  test("runs document batches across a bounded pool of warm workers", async () => {
    const cache = join(fixture, "pooled-models");
    const state = { active: 0, maxActive: 0 };
    const workers: ConcurrentWorker[] = [];
    const provider = new TransformersEmbeddingProvider(embedding, cache, {
      batchSize: 1,
      workerCount: 2,
      workerFactory: () => {
        const worker = new ConcurrentWorker(cache, state);
        workers.push(worker);
        return worker;
      },
    });
    expect(await provider.warmUp({ allowDownload: true })).toEqual({ ok: true, value: undefined });
    expect(await provider.warmUp({ allowDownload: true })).toEqual({ ok: true, value: undefined });
    const result = await provider.embedDocuments(["one", "two", "three", "four"]);
    expect(result.ok && result.value).toHaveLength(4);
    expect(state.maxActive).toBe(2);
    expect(workers.map((worker) => worker.initializeCalls)).toEqual([1, 1]);
    await provider.shutdown();
    expect(workers.map((worker) => worker.closeCalls)).toEqual([1, 1]);
  });

  test("preserves a corrupt cache and retries pinned acquisition with progress", async () => {
    const cache = join(fixture, "recover-models");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "kbiss-model-assets.json"), "{");
    const worker = new RecordingWorker(cache, true);
    const provider = new TransformersEmbeddingProvider(embedding, cache, { worker });
    const phases: string[] = [];
    expect(
      await provider.warmUp({
        allowDownload: true,
        recoverCorruptAssets: true,
        downloadRetries: 3,
        onProgress: (phase) => phases.push(phase),
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(phases).toEqual(["verifying", "recovering", "downloading", "ready"]);
    expect(
      (await readdir(fixture)).some((name) => name.startsWith("recover-models.corrupt-")),
    ).toBe(true);
    expect(worker.configs.map((entry) => entry.localFilesOnly)).toEqual([false]);
    await provider.shutdown();
  });

  test("requires explicit setup before allowing a pinned remote download", async () => {
    const cache = join(fixture, "models");
    const missingWorker = new RecordingWorker(cache, true);
    const missing = new TransformersEmbeddingProvider(embedding, cache, { worker: missingWorker });
    const unavailable = await missing.warmUp();
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) expect(unavailable.error.code).toBe("MODEL_ASSETS_MISSING");
    expect(missingWorker.configs).toEqual([]);
    await missing.shutdown();

    const setupCache = join(fixture, "setup-models");
    const setupWorker = new RecordingWorker(setupCache, true);
    const setup = new TransformersEmbeddingProvider(embedding, setupCache, { worker: setupWorker });
    expect(await setup.warmUp({ allowDownload: true })).toEqual({ ok: true, value: undefined });
    expect(setupWorker.configs.map((config) => config.localFilesOnly)).toEqual([false]);
    expect(await Bun.file(join(setupCache, "kbiss-model-assets.json")).exists()).toBe(true);
    await setup.shutdown();
  });

  test("uses one real Worker with bounded backpressure, cancellation, batching, and shutdown", async () => {
    const cache = join(fixture, "worker-models");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "weights.bin"), "fixture");
    const boundary = new EmbeddingWorkerClient(
      new URL("./fixtures/fake-embedding.worker.ts", import.meta.url),
    );
    const provider = new TransformersEmbeddingProvider(embedding, cache, {
      worker: boundary,
      batchSize: 1,
      maxQueue: 2,
    });
    expect(await provider.warmUp({ allowDownload: true })).toEqual({ ok: true, value: undefined });

    const controller = new AbortController();
    const first = provider.embedDocuments(["first"]);
    const cancelled = provider.embedDocuments(["cancelled"], { signal: controller.signal });
    controller.abort();
    const rejected = await provider.embedDocuments(["overflow"]);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("EMBEDDING_QUEUE_FULL");
    expect(await first).toEqual({ ok: true, value: [[1, 0]] });
    const cancelledResult = await cancelled;
    expect(cancelledResult.ok).toBe(false);
    if (!cancelledResult.ok) expect(cancelledResult.error.code).toBe("EMBEDDING_CANCELLED");

    const batches: number[] = [];
    const batched = await provider.embedDocuments(["one", "two", "three"], {
      onBatch: (completed) => batches.push(completed),
    });
    expect(batched.ok && batched.value).toHaveLength(3);
    expect(batches).toEqual([1, 2, 3]);
    expect(await provider.embedQuery("query")).toEqual({ ok: true, value: [1, 0] });
    await provider.shutdown();
    const closed = await provider.embedDocuments(["late"]);
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.error.code).toBe("EMBEDDING_PROVIDER_CLOSED");
  });

  test("rejects malformed dimensions and non-normalized vectors", async () => {
    const cache = join(fixture, "invalid-models");
    const worker = new RecordingWorker(cache);
    worker.embed = async () => [[1, 1, 1]];
    const provider = new TransformersEmbeddingProvider(embedding, cache, { worker });
    expect((await provider.warmUp({ allowDownload: true })).ok).toBe(true);
    const dimensions = await provider.embedDocuments(["bad"]);
    expect(dimensions.ok).toBe(false);
    if (!dimensions.ok) expect(dimensions.error.code).toBe("VECTOR_DIMENSION_INVALID");
    worker.embed = async () => [[1, 1]];
    const normalization = await provider.embedDocuments(["bad norm"]);
    expect(normalization.ok).toBe(false);
    if (!normalization.ok) expect(normalization.error.code).toBe("VECTOR_NORMALIZATION_INVALID");
    await provider.shutdown();
  });

  test("composes from AppConfig and maps real Worker protocol and crash failures", async () => {
    const config = indexingConfig(fixture, join(fixture, "state"), join(fixture, "cache"), 2);
    const composed = createTransformersEmbeddingProvider(config, {
      worker: new RecordingWorker(config.paths.modelCacheDir),
    });
    expect(composed.identity.vectorDimension).toBe(2);
    await composed.shutdown();

    let messageHandler: ((event: MessageEvent) => void) | null = null;
    const wrongKind = new EmbeddingWorkerClient("fixture:wrong-kind", () => {
      const worker = {
        get onmessage() {
          return messageHandler;
        },
        set onmessage(value) {
          messageHandler = value;
        },
        onerror: null,
        postMessage(request: { kind: string; requestId: string }) {
          const response =
            request.kind === "shutdown"
              ? { kind: "stopped", requestId: request.requestId }
              : { kind: "ready", requestId: request.requestId, modelId: "wrong" };
          queueMicrotask(() => messageHandler?.({ data: response } as MessageEvent));
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    });
    await expect(wrongKind.embed(["wrong-kind"])).rejects.toThrow(
      "Expected worker response embeddings",
    );
    await wrongKind.close();
    await wrongKind.close();
    await expect(wrongKind.embed(["closed"])).rejects.toThrow("closed");

    let errorHandler: ((event: ErrorEvent) => void) | null = null;
    const crashing = new EmbeddingWorkerClient("fixture:crashing", () => {
      const worker = {
        onmessage: null,
        get onerror() {
          return errorHandler;
        },
        set onerror(value) {
          errorHandler = value;
        },
        postMessage() {
          queueMicrotask(() => errorHandler?.({ message: "fixture worker crash" } as ErrorEvent));
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    });
    await expect(
      crashing.initialize({
        device: embedding.device,
        modelId: embedding.modelId,
        dtype: embedding.quantization,
        expectedDimension: 2,
        cacheDir: fixture,
        localFilesOnly: true,
      }),
    ).rejects.toThrow("fixture worker crash");
    await crashing.close();
  });
});

describe("deterministic fake provider", () => {
  test("covers deterministic success, errors, cancellation, query, and lifecycle", async () => {
    const unready = new FakeEmbeddingProvider({ dimension: 3 });
    expect((await unready.embedDocuments(["text"])).ok).toBe(false);
    expect(unready.encodeDocument("doc")).toBe("doc");
    expect(unready.encodeQuery("query")).toBe("query");

    const failedWarmup = new FakeEmbeddingProvider({ failWarmUp: true });
    expect((await failedWarmup.warmUp()).ok).toBe(false);

    const provider = new FakeEmbeddingProvider({ dimension: 3, failOnText: "fail" });
    expect(await provider.warmUp()).toEqual({ ok: true, value: undefined });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await provider.embedDocuments(["text"], { signal: controller.signal });
    expect(cancelled.ok).toBe(false);
    const failed = await provider.embedDocuments(["please fail"]);
    expect(failed.ok).toBe(false);
    const query = await provider.embedQuery("query");
    expect(query.ok).toBe(true);
    if (query.ok) {
      expect(query.value).toHaveLength(3);
      expect(
        Math.abs(Math.sqrt(query.value.reduce((sum, value) => sum + value * value, 0)) - 1),
      ).toBeLessThan(1e-10);
    }
    await provider.shutdown();
    expect((await provider.embedDocuments(["late"])).ok).toBe(false);
    expect(provider.shutdownCalls).toBe(1);
  });
});
