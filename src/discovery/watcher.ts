import { watch } from "node:fs";
import type {
  FileChangeSource,
  FileScanner,
  RawWatchEvent,
  WatchSource,
  WatchSubscription,
} from "./contracts.ts";

export interface WatchScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemScheduler: WatchScheduler = {
  now: Date.now,
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  setInterval(callback, intervalMs) {
    return setInterval(callback, intervalMs);
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export class NativeWatchSource implements WatchSource {
  start(
    root: string,
    onEvent: (event: RawWatchEvent) => void,
    onError: (error: Error) => void,
  ): WatchSubscription {
    let watcher: ReturnType<typeof watch>;
    const listener = (eventType: string, filename: string | Buffer | null): void => {
      onEvent({
        eventType: eventType === "rename" || eventType === "change" ? eventType : "unknown",
        ...(filename === null ? {} : { path: filename.toString() }),
      });
    };
    try {
      watcher = watch(root, { recursive: true, persistent: false }, listener);
    } catch {
      // A periodic full reconciliation preserves correctness on filesystems without recursive watch.
      watcher = watch(root, { persistent: false }, listener);
    }
    watcher.on("error", onError);
    return { close: () => watcher.close() };
  }
}

export interface DiscoveryWatcherOptions {
  readonly debounceMs?: number;
  readonly reconciliationIntervalMs?: number;
  readonly watchSource?: WatchSource;
  readonly scheduler?: WatchScheduler;
  readonly onError?: (error: Error) => void;
}

/** Coalesces raw filesystem noise into authoritative metadata-first reconciliation scans. */
export class DiscoveryWatcher {
  readonly #root: string;
  readonly #scanner: FileScanner;
  readonly #debounceMs: number;
  readonly #reconciliationIntervalMs: number;
  readonly #watchSource: WatchSource;
  readonly #scheduler: WatchScheduler;
  readonly #onError: ((error: Error) => void) | undefined;
  #subscription: WatchSubscription | undefined;
  #debounceHandle: unknown;
  #intervalHandle: unknown;
  #running = false;
  #scanRunning = false;
  #queuedSource: FileChangeSource | undefined;
  #lastClockCheck = 0;

  constructor(root: string, scanner: FileScanner, options: DiscoveryWatcherOptions = {}) {
    this.#root = root;
    this.#scanner = scanner;
    this.#debounceMs = Math.max(0, options.debounceMs ?? 100);
    this.#reconciliationIntervalMs = Math.max(1, options.reconciliationIntervalMs ?? 60_000);
    this.#watchSource = options.watchSource ?? new NativeWatchSource();
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#onError = options.onError;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#lastClockCheck = this.#scheduler.now();
    this.#subscription = this.#watchSource.start(
      this.#root,
      () => this.#scheduleWatchScan(),
      (error) => {
        this.#onError?.(error);
        this.requestReconciliation();
      },
    );
    this.#intervalHandle = this.#scheduler.setInterval(
      () => this.#periodicCheck(),
      this.#reconciliationIntervalMs,
    );
    await this.#runScan("scan");
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    if (this.#debounceHandle !== undefined) this.#scheduler.clearTimeout(this.#debounceHandle);
    if (this.#intervalHandle !== undefined) this.#scheduler.clearInterval(this.#intervalHandle);
    this.#debounceHandle = undefined;
    this.#intervalHandle = undefined;
    this.#queuedSource = undefined;
    this.#subscription?.close();
    this.#subscription = undefined;
  }

  requestReconciliation(): void {
    if (!this.#running) return;
    if (this.#debounceHandle !== undefined) {
      this.#scheduler.clearTimeout(this.#debounceHandle);
      this.#debounceHandle = undefined;
    }
    void this.#runScan("reconcile");
  }

  /** Public for deterministic sleep/wake checks; periodic scheduling calls the same path. */
  checkForWake(now = this.#scheduler.now()): void {
    const elapsed = now - this.#lastClockCheck;
    this.#lastClockCheck = now;
    if (elapsed >= this.#reconciliationIntervalMs * 2) this.requestReconciliation();
  }

  #scheduleWatchScan(): void {
    if (!this.#running) return;
    if (this.#debounceHandle !== undefined) this.#scheduler.clearTimeout(this.#debounceHandle);
    this.#debounceHandle = this.#scheduler.setTimeout(() => {
      this.#debounceHandle = undefined;
      void this.#runScan("watch");
    }, this.#debounceMs);
  }

  #periodicCheck(): void {
    if (!this.#running) return;
    const now = this.#scheduler.now();
    this.checkForWake(now);
    // Even without a detected sleep, this bounds recovery time for dropped native events.
    void this.#runScan("reconcile");
  }

  async #runScan(source: FileChangeSource): Promise<void> {
    if (!this.#running) return;
    if (this.#scanRunning) {
      if (source === "reconcile" || this.#queuedSource === undefined) this.#queuedSource = source;
      return;
    }
    this.#scanRunning = true;
    try {
      const result = await this.#scanner.scan(source);
      if (!result.ok) this.#onError?.(new Error(result.error.message));
    } catch (error) {
      this.#onError?.(error instanceof Error ? error : new Error("A discovery scan failed."));
    } finally {
      this.#scanRunning = false;
    }
    const queued = this.#queuedSource;
    this.#queuedSource = undefined;
    if (queued && this.#running) await this.#runScan(queued);
  }
}
