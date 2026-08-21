import { afterEach, describe, expect, test } from "bun:test";
import type { GrepResult } from "./grep.ts";
import { browserGrepExecutor, LARGE_FILE_GREP_THRESHOLD } from "./grep-executor.ts";

const originalWorker = globalThis.Worker;

class FakeWorker {
  static latest: FakeWorker | undefined;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<GrepResult>) => void) | null = null;
  terminated = false;
  posted: unknown;

  constructor(_url: URL, _options: WorkerOptions) {
    FakeWorker.latest = this;
  }

  postMessage(value: unknown): void {
    this.posted = value;
  }

  terminate(): void {
    this.terminated = true;
  }
}

function installWorker(): void {
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
}

afterEach(() => {
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: originalWorker });
  FakeWorker.latest = undefined;
});

describe("browser grep execution", () => {
  test("runs small work after yielding and honors cancellation", async () => {
    const options = { query: "a", regex: false, caseSensitive: true } as const;
    expect(
      (await browserGrepExecutor("a", options, new AbortController().signal)).matches,
    ).toHaveLength(1);
    const already = new AbortController();
    already.abort();
    await expect(browserGrepExecutor("a", options, already.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    const during = new AbortController();
    const operation = browserGrepExecutor("a", options, during.signal);
    during.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
  });

  test("uses a disposable Worker for large results, success, failure, and cancellation", async () => {
    installWorker();
    const content = "a".repeat(LARGE_FILE_GREP_THRESHOLD);
    const options = { query: "a", regex: false, caseSensitive: true } as const;

    const success = browserGrepExecutor(content, options, new AbortController().signal);
    const successWorker = FakeWorker.latest;
    expect(successWorker?.posted).toMatchObject({ content, options });
    successWorker?.onmessage?.({
      data: { matches: [], limited: false },
    } as unknown as MessageEvent<GrepResult>);
    expect(await success).toEqual({ matches: [], limited: false });
    expect(successWorker?.terminated).toBe(true);

    const failed = browserGrepExecutor(content, options, new AbortController().signal);
    FakeWorker.latest?.onerror?.({} as ErrorEvent);
    await expect(failed).rejects.toThrow("worker failed");

    const controller = new AbortController();
    const cancelled = browserGrepExecutor(content, options, controller.signal);
    const cancelledWorker = FakeWorker.latest;
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelledWorker?.terminated).toBe(true);
  });
});
