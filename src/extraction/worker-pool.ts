import { availableParallelism } from "node:os";
import type { AppConfig } from "../config/index.ts";
import type { DiscoveredFile } from "../discovery/index.ts";
import { err, type Result } from "../shared/result.ts";
import type { ExtractedFile, ExtractionError, ExtractionPipeline } from "./contracts.ts";
import type {
  ExtractionWorkerConfig,
  ExtractionWorkerRequest,
  ExtractionWorkerResponse,
} from "./worker-protocol.ts";

interface PendingRequest {
  readonly resolve: (response: ExtractionWorkerResponse) => void;
  readonly reject: (error: Error) => void;
}

export interface ExtractionWorkerBoundary {
  initialize(config: ExtractionWorkerConfig): Promise<void>;
  extract(file: DiscoveredFile): Promise<Result<ExtractedFile, ExtractionError>>;
  close(): Promise<void>;
}

export class ExtractionWorkerClient implements ExtractionWorkerBoundary {
  readonly #worker: Worker;
  readonly #pending = new Map<string, PendingRequest>();
  #closed = false;

  constructor(
    workerUrl: string | URL = new URL("./extraction.worker.ts", import.meta.url),
    workerFactory: (url: string | URL) => Worker = (url) =>
      new Worker(url, { name: "kbiss-extraction", ref: true }),
  ) {
    this.#worker = workerFactory(workerUrl);
    this.#worker.onmessage = (event: MessageEvent<ExtractionWorkerResponse>) => {
      const pending = this.#pending.get(event.data.requestId);
      if (!pending) return;
      this.#pending.delete(event.data.requestId);
      pending.resolve(event.data);
    };
    this.#worker.onerror = (event) => {
      const error = new Error(event.message || "The extraction worker failed.");
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      this.#closed = true;
      this.#worker.terminate();
    };
  }

  async initialize(config: ExtractionWorkerConfig): Promise<void> {
    const response = await this.#request({
      kind: "initialize",
      requestId: crypto.randomUUID(),
      config,
    });
    if (response.kind === "error") throw new Error(response.error.message);
    if (response.kind !== "ready")
      throw new Error("The extraction worker returned an invalid response.");
  }

  async extract(file: DiscoveredFile): Promise<Result<ExtractedFile, ExtractionError>> {
    const response = await this.#request({
      kind: "extract",
      requestId: crypto.randomUUID(),
      file,
    });
    if (response.kind === "extracted") return { ok: true, value: response.value };
    if (response.kind === "error") return err(response.error);
    return err({
      code: "EXTRACTION_FAILED",
      message: "The extraction worker returned an invalid response.",
      fileId: file.fileId,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      const response = await this.#request({ kind: "shutdown", requestId: crypto.randomUUID() });
      if (response.kind !== "stopped") throw new Error("The extraction worker did not stop.");
    } finally {
      this.#closed = true;
      this.#worker.terminate();
    }
  }

  #request(request: ExtractionWorkerRequest): Promise<ExtractionWorkerResponse> {
    if (this.#closed) return Promise.reject(new Error("The extraction worker is closed."));
    return new Promise((resolve, reject) => {
      this.#pending.set(request.requestId, { resolve, reject });
      this.#worker.postMessage(request);
    });
  }
}

interface QueueJob {
  readonly file: DiscoveredFile;
  readonly signal?: AbortSignal;
  readonly resolve: (result: Result<ExtractedFile, ExtractionError>) => void;
}

export class WorkerExtractionPool implements ExtractionPipeline {
  readonly #config: ExtractionWorkerConfig;
  readonly #workers: readonly ExtractionWorkerBoundary[];
  readonly #available: ExtractionWorkerBoundary[];
  readonly #active = new Set<ExtractionWorkerBoundary>();
  readonly #queue: QueueJob[] = [];
  readonly #idleWaiters: Array<() => void> = [];
  readonly #capacityWaiters: Array<(available: boolean) => void> = [];
  readonly #maxQueue: number;
  #initialization: Promise<void> | undefined;
  #closed = false;
  #capacityReservations = 0;

  constructor(
    config: AppConfig,
    maximumTokens: number,
    options: {
      readonly workerCount?: number;
      readonly maxQueue?: number;
      readonly workerFactory?: () => ExtractionWorkerBoundary;
    } = {},
  ) {
    const workerCount = Math.max(1, Math.min(8, options.workerCount ?? 1));
    this.#config = { config, maximumTokens };
    this.#workers = Array.from(
      { length: workerCount },
      () => options.workerFactory?.() ?? new ExtractionWorkerClient(),
    );
    this.#available = [...this.#workers];
    this.#maxQueue = Math.max(workerCount, options.maxQueue ?? 256);
  }

  async process(
    file: DiscoveredFile,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<ExtractedFile, ExtractionError>> {
    if (this.#closed) return err(this.#failure(file, "The extraction pool is closed."));
    const available = await this.#waitForCapacity(options.signal);
    if (!available) {
      return err(
        this.#failure(
          file,
          options.signal?.aborted ? "Extraction was cancelled." : "The extraction pool is closed.",
        ),
      );
    }
    this.#capacityReservations -= 1;
    if (this.#closed) return err(this.#failure(file, "The extraction pool is closed."));
    return new Promise((resolve) => {
      this.#queue.push({ file, ...(options.signal ? { signal: options.signal } : {}), resolve });
      void this.#ensureReady()
        .then(() => this.#pump())
        .catch(() => this.#failQueued("The extraction workers could not initialize."));
    });
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#failQueued("The extraction pool is closed.");
    for (const waiter of this.#capacityWaiters.splice(0)) waiter(false);
    await this.#initialization?.catch(() => undefined);
    if (this.#active.size > 0)
      await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
    await Promise.all(this.#workers.map((worker) => worker.close().catch(() => undefined)));
  }

  #ensureReady(): Promise<void> {
    this.#initialization ??= Promise.all(
      this.#workers.map((worker) => worker.initialize(this.#config)),
    ).then(() => undefined);
    return this.#initialization;
  }

  #pump(): void {
    while (!this.#closed && this.#available.length > 0 && this.#queue.length > 0) {
      const worker = this.#available.shift();
      const job = this.#queue.shift();
      if (!worker || !job) return;
      this.#active.add(worker);
      if (job.signal?.aborted) {
        this.#active.delete(worker);
        this.#available.push(worker);
        job.resolve(err(this.#failure(job.file, "Extraction was cancelled.")));
        this.#releaseCapacity();
        continue;
      }
      void worker
        .extract(job.file)
        .then(job.resolve)
        .catch(() => job.resolve(err(this.#failure(job.file, "The extraction worker failed."))))
        .finally(() => {
          this.#active.delete(worker);
          this.#available.push(worker);
          this.#releaseCapacity();
          if (this.#closed && this.#active.size === 0) {
            for (const resolve of this.#idleWaiters.splice(0)) resolve();
          } else {
            this.#pump();
          }
        });
    }
  }

  #waitForCapacity(signal?: AbortSignal): Promise<boolean> {
    if (this.#closed || signal?.aborted) return Promise.resolve(false);
    if (this.#queue.length + this.#active.size + this.#capacityReservations < this.#maxQueue) {
      this.#capacityReservations += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const finish = (available: boolean) => {
        signal?.removeEventListener("abort", abort);
        resolve(available);
      };
      const abort = () => {
        const index = this.#capacityWaiters.indexOf(finish);
        if (index >= 0) this.#capacityWaiters.splice(index, 1);
        finish(false);
      };
      this.#capacityWaiters.push(finish);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  #releaseCapacity(): void {
    const waiter = this.#capacityWaiters.shift();
    if (!waiter) return;
    this.#capacityReservations += 1;
    waiter(true);
  }

  #failQueued(message: string): void {
    for (const job of this.#queue.splice(0)) {
      job.resolve(err(this.#failure(job.file, message)));
      this.#releaseCapacity();
    }
  }

  #failure(file: DiscoveredFile, message: string): ExtractionError {
    return { code: "EXTRACTION_FAILED", message, fileId: file.fileId };
  }
}

export function createWorkerExtractionPipeline(
  config: AppConfig,
  maximumTokens: number,
  options?: ConstructorParameters<typeof WorkerExtractionPool>[2],
): WorkerExtractionPool {
  const workerCount = availableParallelism() >= 8 ? 4 : availableParallelism() >= 4 ? 2 : 1;
  return new WorkerExtractionPool(config, maximumTokens, { workerCount, ...options });
}
