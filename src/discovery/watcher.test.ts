import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "../shared/result.ts";
import type {
  DiscoveryError,
  DiscoveryProgress,
  DiscoveryScanResult,
  FileChangeSource,
  FileScanner,
  RawWatchEvent,
  WatchSource,
  WatchSubscription,
} from "./contracts.ts";
import { JsonFileManifest } from "./manifest.ts";
import { RepositoryScanner } from "./scanner.ts";
import { DiscoveryWatcher, NativeWatchSource, type WatchScheduler } from "./watcher.ts";

class ManualWatchSource implements WatchSource {
  event: ((event: RawWatchEvent) => void) | undefined;
  error: ((error: Error) => void) | undefined;
  closed = false;

  start(
    _root: string,
    onEvent: (event: RawWatchEvent) => void,
    onError: (error: Error) => void,
  ): WatchSubscription {
    this.event = onEvent;
    this.error = onError;
    return { close: () => (this.closed = true) };
  }
}

interface Scheduled {
  readonly callback: () => void;
  due: number;
  readonly interval?: number;
  cancelled: boolean;
}

class FakeScheduler implements WatchScheduler {
  time = 0;
  readonly scheduled: Scheduled[] = [];

  now(): number {
    return this.time;
  }
  setTimeout(callback: () => void, delayMs: number): Scheduled {
    const scheduled = { callback, due: this.time + delayMs, cancelled: false };
    this.scheduled.push(scheduled);
    return scheduled;
  }
  clearTimeout(handle: unknown): void {
    (handle as Scheduled).cancelled = true;
  }
  setInterval(callback: () => void, intervalMs: number): Scheduled {
    const scheduled = {
      callback,
      due: this.time + intervalMs,
      interval: intervalMs,
      cancelled: false,
    };
    this.scheduled.push(scheduled);
    return scheduled;
  }
  clearInterval(handle: unknown): void {
    (handle as Scheduled).cancelled = true;
  }
  advance(milliseconds: number): void {
    const target = this.time + milliseconds;
    for (;;) {
      const next = this.scheduled
        .filter((item) => !item.cancelled && item.due <= target)
        .sort((left, right) => left.due - right.due)[0];
      if (!next) break;
      this.time = next.due;
      if (next.interval === undefined) next.cancelled = true;
      else next.due += next.interval;
      next.callback();
    }
    this.time = target;
  }
}

const emptyProgress: DiscoveryProgress = {
  phase: "complete",
  discovered: 0,
  unchanged: 0,
  pending: 0,
  failed: 0,
  removed: 0,
};

class RecordingScanner implements FileScanner {
  readonly sources: FileChangeSource[] = [];
  blockNext = false;
  failNext: "result" | "throw" | undefined;
  #release: (() => void) | undefined;

  async scan(
    source: FileChangeSource = "scan",
  ): Promise<Result<DiscoveryScanResult, DiscoveryError>> {
    this.sources.push(source);
    const failure = this.failNext;
    this.failNext = undefined;
    if (failure === "throw") throw new Error("unexpected scan failure");
    if (failure === "result") {
      return err({ code: "DISCOVERY_ROOT_UNAVAILABLE", message: "expected scan failure" });
    }
    if (this.blockNext) {
      this.blockNext = false;
      await new Promise<void>((resolve) => {
        this.#release = resolve;
      });
    }
    return ok({ files: [], changes: [], progress: emptyProgress });
  }
  release(): void {
    this.#release?.();
    this.#release = undefined;
  }
  subscribeProgress(_listener: (progress: DiscoveryProgress) => void): () => void {
    return () => undefined;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Condition was not reached.");
}

let fixture = "";

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "kbiss-watcher-")));
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe("discovery watcher", () => {
  test("debounces duplicate editor events into one normalized watch scan", async () => {
    const source = new ManualWatchSource();
    const scheduler = new FakeScheduler();
    const scanner = new RecordingScanner();
    const watcher = new DiscoveryWatcher(fixture, scanner, {
      debounceMs: 50,
      reconciliationIntervalMs: 1_000,
      watchSource: source,
      scheduler,
    });
    await watcher.start();
    source.event?.({ eventType: "rename", path: "file.txt" });
    source.event?.({ eventType: "change", path: "file.txt" });
    scheduler.advance(49);
    expect(scanner.sources).toEqual(["scan"]);
    scheduler.advance(1);
    await waitFor(() => scanner.sources.length === 2);
    expect(scanner.sources).toEqual(["scan", "watch"]);
    watcher.stop();
    expect(source.closed).toBe(true);
  });

  test("reconciles after event loss, periodic checks, and simulated sleep", async () => {
    const source = new ManualWatchSource();
    const scheduler = new FakeScheduler();
    const scanner = new RecordingScanner();
    const errors: string[] = [];
    const watcher = new DiscoveryWatcher(fixture, scanner, {
      reconciliationIntervalMs: 100,
      watchSource: source,
      scheduler,
      onError: (error) => errors.push(error.message),
    });
    await watcher.start();
    source.error?.(new Error("overflow"));
    await waitFor(() => scanner.sources.length === 2);
    expect(scanner.sources.at(-1)).toBe("reconcile");
    expect(errors).toEqual(["overflow"]);

    scheduler.advance(100);
    await waitFor(() => scanner.sources.length === 3);
    expect(scanner.sources.at(-1)).toBe("reconcile");
    watcher.checkForWake(1_000);
    await waitFor(() => scanner.sources.length === 4);
    expect(scanner.sources.at(-1)).toBe("reconcile");
    watcher.stop();
  });

  test("queues reconciliation behind an in-flight watch scan", async () => {
    const source = new ManualWatchSource();
    const scheduler = new FakeScheduler();
    const scanner = new RecordingScanner();
    const watcher = new DiscoveryWatcher(fixture, scanner, {
      debounceMs: 0,
      reconciliationIntervalMs: 1_000,
      watchSource: source,
      scheduler,
    });
    await watcher.start();
    scanner.blockNext = true;
    source.event?.({ eventType: "change" });
    scheduler.advance(0);
    await waitFor(() => scanner.sources.at(-1) === "watch");
    source.error?.(new Error("lost events"));
    scanner.release();
    await waitFor(() => scanner.sources.at(-1) === "reconcile");
    expect(scanner.sources).toEqual(["scan", "watch", "reconcile"]);
    watcher.stop();
  });

  test("reports structured and unexpected scan failures without wedging future scans", async () => {
    const source = new ManualWatchSource();
    const scheduler = new FakeScheduler();
    const scanner = new RecordingScanner();
    const errors: string[] = [];
    const watcher = new DiscoveryWatcher(fixture, scanner, {
      debounceMs: 0,
      reconciliationIntervalMs: 1_000,
      watchSource: source,
      scheduler,
      onError: (error) => errors.push(error.message),
    });
    await watcher.start();
    scanner.failNext = "result";
    watcher.requestReconciliation();
    await waitFor(() => errors.length === 1);
    scanner.failNext = "throw";
    watcher.requestReconciliation();
    await waitFor(() => errors.length === 2);
    watcher.requestReconciliation();
    await waitFor(() => scanner.sources.length === 4);
    expect(errors).toEqual(["expected scan failure", "unexpected scan failure"]);
    watcher.stop();
  });

  test("re-stats atomic saves and emits the final content change", async () => {
    const root = join(fixture, "source");
    const state = join(fixture, "state");
    await Promise.all([mkdir(root), mkdir(state)]);
    const target = join(root, "document.md");
    await writeFile(target, "old");
    const opened = await JsonFileManifest.open(join(state, "manifest.json"), "root-id");
    if (!opened.ok) throw new Error(opened.error.message);
    const scanner = new RepositoryScanner({ identity: "root-id", path: root }, opened.value);
    const source = new ManualWatchSource();
    const scheduler = new FakeScheduler();
    const watcher = new DiscoveryWatcher(root, scanner, {
      debounceMs: 20,
      reconciliationIntervalMs: 1_000,
      watchSource: source,
      scheduler,
    });
    const kinds: string[] = [];
    opened.value.subscribe((changes) => kinds.push(...changes.map((change) => change.kind)));
    await watcher.start();
    kinds.length = 0;
    const replacement = join(root, ".document.md.tmp");
    await writeFile(replacement, "new final content");
    await rename(replacement, target);
    source.event?.({ eventType: "rename", path: ".document.md.tmp" });
    source.event?.({ eventType: "rename", path: "document.md" });
    scheduler.advance(20);
    await waitFor(() => kinds.includes("content-changed"));
    expect(await readFile(target, "utf8")).toBe("new final content");
    expect(kinds).toEqual(["content-changed"]);
    watcher.stop();
  });

  test("starts and closes the native adapter on a real directory", () => {
    const subscription = new NativeWatchSource().start(
      fixture,
      () => undefined,
      () => undefined,
    );
    subscription.close();
  });

  test("uses the native adapter and system timers for real filesystem events", async () => {
    const scanner = new RecordingScanner();
    const watcher = new DiscoveryWatcher(fixture, scanner, {
      debounceMs: 1,
      reconciliationIntervalMs: 10_000,
    });
    await watcher.start();
    await writeFile(join(fixture, "native-event.txt"), "event");
    await waitFor(() => scanner.sources.includes("watch"));
    watcher.stop();
    expect(scanner.sources).toEqual(["scan", "watch"]);
  });
});
