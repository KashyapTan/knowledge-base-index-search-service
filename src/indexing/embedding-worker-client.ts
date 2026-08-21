import type {
  EmbeddingWorkerConfig,
  EmbeddingWorkerRequest,
  EmbeddingWorkerResponse,
} from "./embedding-protocol.ts";

interface PendingRequest {
  readonly resolve: (response: EmbeddingWorkerResponse) => void;
  readonly reject: (error: Error) => void;
}

export class EmbeddingWorkerClient {
  readonly #worker: Worker;
  readonly #pending = new Map<string, PendingRequest>();
  #closed = false;

  constructor(workerUrl = new URL("./embedding.worker.ts", import.meta.url).href) {
    this.#worker = new Worker(workerUrl, { name: "kbiss-embedding", ref: true });
    this.#worker.onmessage = (event: MessageEvent<EmbeddingWorkerResponse>) => {
      const pending = this.#pending.get(event.data.requestId);
      if (!pending) return;
      this.#pending.delete(event.data.requestId);
      pending.resolve(event.data);
    };
    this.#worker.onerror = (event) => {
      const error = new Error(event.message || "The embedding worker failed.");
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      this.#closed = true;
      this.#worker.terminate();
    };
  }

  async initialize(config: EmbeddingWorkerConfig): Promise<void> {
    const response = await this.#request({
      kind: "initialize",
      requestId: crypto.randomUUID(),
      config,
    });
    this.#expectKind(response, "ready");
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    const response = await this.#request({
      kind: "embed",
      requestId: crypto.randomUUID(),
      texts,
    });
    this.#expectKind(response, "embeddings");
    return response.vectors;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      const response = await this.#request({ kind: "shutdown", requestId: crypto.randomUUID() });
      this.#expectKind(response, "stopped");
    } finally {
      this.#closed = true;
      this.#worker.terminate();
    }
  }

  #request(request: EmbeddingWorkerRequest): Promise<EmbeddingWorkerResponse> {
    if (this.#closed) return Promise.reject(new Error("The embedding worker is closed."));

    return new Promise((resolve, reject) => {
      this.#pending.set(request.requestId, { resolve, reject });
      this.#worker.postMessage(request);
    });
  }

  #expectKind<TKind extends EmbeddingWorkerResponse["kind"]>(
    response: EmbeddingWorkerResponse,
    expectedKind: TKind,
  ): asserts response is Extract<EmbeddingWorkerResponse, { kind: TKind }> {
    if (response.kind === "error") {
      throw new Error(`${response.code}: ${response.message}`);
    }
    if (response.kind !== expectedKind) {
      throw new Error(`Expected worker response ${expectedKind}, received ${response.kind}.`);
    }
  }
}
