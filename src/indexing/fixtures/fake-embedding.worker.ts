import type { EmbeddingWorkerRequest, EmbeddingWorkerResponse } from "../embedding-protocol.ts";

declare const self: Worker;

function post(response: EmbeddingWorkerResponse): void {
  self.postMessage(response);
}

self.onmessage = (event: MessageEvent<EmbeddingWorkerRequest>) => {
  const request = event.data;
  switch (request.kind) {
    case "initialize":
      post({
        kind: "ready",
        requestId: request.requestId,
        modelId: request.config.modelId,
      });
      break;
    case "embed":
      setTimeout(() => {
        post({
          kind: "embeddings",
          requestId: request.requestId,
          vectors: request.texts.map(() => [1, 0]),
          dimension: 2,
        });
      }, 20);
      break;
    case "shutdown":
      post({ kind: "stopped", requestId: request.requestId });
      break;
  }
};
