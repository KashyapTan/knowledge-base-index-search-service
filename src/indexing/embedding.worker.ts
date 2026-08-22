import {
  AutoModel,
  AutoTokenizer,
  env,
  mean_pooling,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Tensor,
} from "@huggingface/transformers";
import type {
  EmbeddingWorkerConfig,
  EmbeddingWorkerRequest,
  EmbeddingWorkerResponse,
} from "./embedding-protocol.ts";

declare const self: Worker;

let model: PreTrainedModel | undefined;
let tokenizer: PreTrainedTokenizer | undefined;
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
    if (model) await model.dispose();
    model = undefined;
    tokenizer = undefined;
    activeConfig = undefined;
    // During setup, go straight to the pinned Hub artifact instead of probing an unrelated
    // node_modules/models path. Normal inference remains strictly local.
    env.allowLocalModels = request.config.localFilesOnly;
    env.allowRemoteModels = !request.config.localFilesOnly;
    env.cacheDir = request.config.cacheDir;
    const common = {
      cache_dir: request.config.cacheDir,
      local_files_only: request.config.localFilesOnly,
    } as const;
    // Transformers.js shares cache metadata between these loaders. Serial acquisition avoids a
    // first-run race in which both loaders try to populate the same missing config file.
    tokenizer = await AutoTokenizer.from_pretrained(request.config.modelId, common);
    model = await AutoModel.from_pretrained(request.config.modelId, {
      ...common,
      device: request.config.device,
      dtype: request.config.dtype,
    });
    // Inference never needs the network, including after an explicit setup download.
    env.allowRemoteModels = false;
    activeConfig = request.config;
    post({ kind: "ready", requestId: request.requestId, modelId: request.config.modelId });
  } catch (error) {
    env.allowRemoteModels = false;
    post({
      kind: "error",
      requestId: request.requestId,
      code: "MODEL_LOAD_FAILED",
      message: `The configured ${request.config.dtype} model could not be loaded on ${request.config.device}. ${errorMessage(error)}`,
    });
  }
}

async function embed(request: Extract<EmbeddingWorkerRequest, { kind: "embed" }>): Promise<void> {
  if (!model || !tokenizer || !activeConfig) {
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
    const modelInputs = tokenizer([...request.texts], {
      padding: request.maximumTokens ? "max_length" : true,
      truncation: true,
      ...(request.maximumTokens ? { max_length: request.maximumTokens } : {}),
    });
    const output = (await model(modelInputs)) as {
      readonly last_hidden_state?: Tensor;
      readonly logits?: Tensor;
      readonly token_embeddings?: Tensor;
    };
    const hidden = output.last_hidden_state ?? output.logits ?? output.token_embeddings;
    if (!hidden) throw new Error("The embedding model did not return token embeddings.");
    const pooled = mean_pooling(hidden, modelInputs.attention_mask).normalize(2, -1);
    const dimension = pooled.dims.at(-1);
    if (dimension !== activeConfig.expectedDimension) {
      throw new Error(
        `Expected ${activeConfig.expectedDimension} embedding values, received ${String(dimension)}.`,
      );
    }

    const flatValues = Array.from(pooled.data, Number);
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
      void (async () => {
        if (model) await model.dispose();
        model = undefined;
        tokenizer = undefined;
        activeConfig = undefined;
        env.allowRemoteModels = false;
        post({ kind: "stopped", requestId: request.requestId });
      })();
      break;
  }
};
