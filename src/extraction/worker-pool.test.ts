import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../config/index.ts";
import type { DiscoveredFile } from "../discovery/index.ts";
import { extracted, indexableFile, indexingConfig, searchChunk } from "../indexing/test-helpers.ts";
import { ok } from "../shared/result.ts";
import {
  createWorkerExtractionPipeline,
  type ExtractionWorkerBoundary,
  ExtractionWorkerClient,
  WorkerExtractionPool,
} from "./worker-pool.ts";

class FixtureWorker implements ExtractionWorkerBoundary {
  readonly #state: { active: number; maxActive: number };
  readonly #failInitialization: boolean;
  closeCalls = 0;

  constructor(
    state: { active: number; maxActive: number },
    options: { readonly failInitialization?: boolean } = {},
  ) {
    this.#state = state;
    this.#failInitialization = options.failInitialization ?? false;
  }

  async initialize(): Promise<void> {
    if (this.#failInitialization) throw new Error("fixture initialization failed");
  }

  async extract(file: DiscoveredFile) {
    this.#state.active += 1;
    this.#state.maxActive = Math.max(this.#state.maxActive, this.#state.active);
    await Bun.sleep(10);
    this.#state.active -= 1;
    return ok(extracted(file, [searchChunk(file, `${file.filename}-chunk`, file.filename, 0)]));
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function config(): AppConfig {
  return indexingConfig("/tmp/root", "/tmp/state", "/tmp/cache");
}

describe("worker extraction pool", () => {
  test("maps the real Worker protocol, invalid responses, closure, and crashes", async () => {
    let messageHandler: ((event: MessageEvent) => void) | null = null;
    const file = indexableFile("protocol.md", "protocol");
    const client = new ExtractionWorkerClient("fixture:extraction", () => {
      const worker = {
        get onmessage() {
          return messageHandler;
        },
        set onmessage(value) {
          messageHandler = value;
        },
        onerror: null,
        postMessage(request: { kind: string; requestId: string; file?: DiscoveredFile }) {
          const response =
            request.kind === "initialize"
              ? { kind: "ready", requestId: request.requestId }
              : request.kind === "extract" && request.file
                ? {
                    kind: "extracted",
                    requestId: request.requestId,
                    value: extracted(request.file, [
                      searchChunk(request.file, "protocol-chunk", "protocol", 0),
                    ]),
                  }
                : { kind: "stopped", requestId: request.requestId };
          queueMicrotask(() => messageHandler?.({ data: response } as MessageEvent));
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    });
    await client.initialize({ config: config(), maximumTokens: 512 });
    expect((await client.extract(file)).ok).toBe(true);
    await client.close();
    await client.close();
    await expect(client.extract(file)).rejects.toThrow("closed");

    let errorHandler: ((event: ErrorEvent) => void) | null = null;
    const crashing = new ExtractionWorkerClient("fixture:crashing", () => {
      const worker = {
        onmessage: null,
        get onerror() {
          return errorHandler;
        },
        set onerror(value) {
          errorHandler = value;
        },
        postMessage() {
          queueMicrotask(() => errorHandler?.({ message: "fixture crash" } as ErrorEvent));
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    });
    await expect(crashing.initialize({ config: config(), maximumTokens: 512 })).rejects.toThrow(
      "fixture crash",
    );
    await crashing.close();
  });

  test("bounds parallel extraction and drains queued files", async () => {
    const state = { active: 0, maxActive: 0 };
    const workers: FixtureWorker[] = [];
    const pool = new WorkerExtractionPool(config(), 512, {
      workerCount: 2,
      workerFactory: () => {
        const worker = new FixtureWorker(state);
        workers.push(worker);
        return worker;
      },
    });
    const files = [
      indexableFile("a.md", "a"),
      indexableFile("b.md", "b"),
      indexableFile("c.md", "c"),
    ];
    const results = await Promise.all(files.map((file) => pool.process(file)));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(state.maxActive).toBe(2);
    await pool.shutdown();
    await pool.shutdown();
    expect(workers.map((worker) => worker.closeCalls)).toEqual([1, 1]);
    expect((await pool.process(files[0] as DiscoveredFile)).ok).toBe(false);
  });

  test("fails closed when initialization fails or the bounded queue is full", async () => {
    const state = { active: 0, maxActive: 0 };
    const failed = new WorkerExtractionPool(config(), 512, {
      workerFactory: () => new FixtureWorker(state, { failInitialization: true }),
    });
    const file = indexableFile("failed.md", "failed");
    const initialization = await failed.process(file);
    expect(initialization).toMatchObject({ ok: false, error: { code: "EXTRACTION_FAILED" } });
    await failed.shutdown();

    const bounded = new WorkerExtractionPool(config(), 512, {
      maxQueue: 1,
      workerFactory: () => new FixtureWorker(state),
    });
    const first = bounded.process(indexableFile("first.md", "first"));
    const overflow = await bounded.process(indexableFile("overflow.md", "overflow"));
    expect(overflow).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("full") },
    });
    expect((await first).ok).toBe(true);
    await bounded.shutdown();

    const composed = createWorkerExtractionPipeline(config(), 512, {
      workerCount: 1,
      workerFactory: () => new FixtureWorker(state),
    });
    expect((await composed.process(file)).ok).toBe(true);
    await composed.shutdown();
  });
});
