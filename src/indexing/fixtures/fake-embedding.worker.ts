import type { EmbeddingWorkerRequest, EmbeddingWorkerResponse } from "../embedding-protocol.ts";

declare const self: Worker;

function post(response: EmbeddingWorkerResponse, transfer: readonly Transferable[] = []): void {
  self.postMessage(response, [...transfer]);
}

self.onmessage = (event: MessageEvent<EmbeddingWorkerRequest>) => {
  const request = event.data;
  switch (request.kind) {
    case "initialize":
      post({
        kind: "ready",
        requestId: request.requestId,
        modelId: request.config.modelId,
        profileVersion: request.config.profileVersion,
        revision: request.config.revision,
      });
      break;
    case "embed":
      setTimeout(() => {
        const storage = new Float32Array(request.texts.length * 2);
        for (let index = 0; index < request.texts.length; index += 1) storage[index * 2] = 1;
        post(
          {
            kind: "embeddings",
            requestId: request.requestId,
            count: request.texts.length,
            dimension: 2,
            storage,
          },
          [storage.buffer],
        );
      }, 20);
      break;
    case "shutdown":
      post({ kind: "stopped", requestId: request.requestId });
      break;
  }
};
