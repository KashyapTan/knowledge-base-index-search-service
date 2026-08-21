import { type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import type {
  EmbeddingWorkerConfig,
  EmbeddingWorkerRequest,
  EmbeddingWorkerResponse,
} from "./embedding-protocol.ts";

declare const self: Worker;

let extractor: FeatureExtractionPipeline | undefined;
let activeConfig: EmbeddingWorkerConfig | undefined;

function post(response: EmbeddingWorkerResponse): void {
  self.postMessage(response);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unknown embedding worker error occurred.";
}

async function initialize(
  request: Extract<EmbeddingWorkerRequest, { kind: "initialize" }>,
): Promise<void> {
  try {
    extractor = await pipeline("feature-extraction", request.config.modelId, {
      cache_dir: request.config.cacheDir,
      dtype: request.config.dtype,
    });
    activeConfig = request.config;
    post({ kind: "ready", requestId: request.requestId, modelId: request.config.modelId });
  } catch (error) {
    post({
      kind: "error",
      requestId: request.requestId,
      code: "MODEL_LOAD_FAILED",
      message: errorMessage(error),
    });
  }
}

async function embed(request: Extract<EmbeddingWorkerRequest, { kind: "embed" }>): Promise<void> {
  if (!extractor || !activeConfig) {
    post({
      kind: "error",
      requestId: request.requestId,
      code: "INVALID_REQUEST",
      message: "Initialize the embedding worker before requesting embeddings.",
    });
    return;
  }

  if (request.texts.length === 0) {
    post({
      kind: "error",
      requestId: request.requestId,
      code: "INVALID_REQUEST",
      message: "At least one input text is required.",
    });
    return;
  }

  try {
    const output = await extractor([...request.texts], { pooling: "mean", normalize: true });
    const dimension = output.dims.at(-1);
    if (dimension !== activeConfig.expectedDimension) {
      throw new Error(
        `Expected ${activeConfig.expectedDimension} embedding values, received ${String(dimension)}.`,
      );
    }

    const flatValues = Array.from(output.data, Number);
    const vectors = request.texts.map((_, index) => {
      const start = index * dimension;
      return flatValues.slice(start, start + dimension);
    });

    post({ kind: "embeddings", requestId: request.requestId, vectors, dimension });
  } catch (error) {
    post({
      kind: "error",
      requestId: request.requestId,
      code: "INFERENCE_FAILED",
      message: errorMessage(error),
    });
  }
}

self.onmessage = (event: MessageEvent<EmbeddingWorkerRequest>) => {
  const request = event.data;
  switch (request.kind) {
    case "initialize":
      void initialize(request);
      break;
    case "embed":
      void embed(request);
      break;
    case "shutdown":
      extractor = undefined;
      activeConfig = undefined;
      post({ kind: "stopped", requestId: request.requestId });
      break;
  }
};
