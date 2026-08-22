import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AutoModel,
  AutoTokenizer,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Tensor,
} from "@huggingface/transformers";
import { composeEmbeddingInput } from "../config/index.ts";
import type {
  EmbeddingWorkerConfig,
  EmbeddingWorkerRequest,
  EmbeddingWorkerResponse,
} from "./embedding-protocol.ts";
import { poolEmbeddingTensors } from "./pooling.ts";

declare const self: Worker;

let model: PreTrainedModel | undefined;
let tokenizer: PreTrainedTokenizer | undefined;
let activeConfig: EmbeddingWorkerConfig | undefined;

const TOKENIZER_FILES = ["tokenizer.json", "tokenizer_config.json"] as const;
const MAX_TOKENIZER_FILE_BYTES = 64 * 1024 * 1024;

function pinnedModelDirectory(config: EmbeddingWorkerConfig): string {
  return join(config.cacheDir, ...config.modelId.split("/"), config.revision);
}

async function acquirePinnedTokenizer(config: EmbeddingWorkerConfig): Promise<string> {
  const directory = pinnedModelDirectory(config);
  await mkdir(directory, { recursive: true });
  for (const file of TOKENIZER_FILES) {
    const destination = join(directory, file);
    const existing = await lstat(destination).catch(() => undefined);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new Error(`Pinned tokenizer asset ${file} has an unsafe cache entry.`);
      }
      continue;
    }
    const url = `https://huggingface.co/${config.modelId}/resolve/${config.revision}/${file}`;
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`Pinned tokenizer asset ${file} was unavailable.`);
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_TOKENIZER_FILE_BYTES) {
      throw new Error(`Pinned tokenizer asset ${file} exceeded the size limit.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_TOKENIZER_FILE_BYTES) {
      throw new Error(`Pinned tokenizer asset ${file} had an invalid size.`);
    }
    JSON.parse(new TextDecoder().decode(bytes));
    const temporary = `${destination}.pending-${randomUUID()}`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  return directory;
}

function post(response: EmbeddingWorkerResponse, transfer: readonly Transferable[] = []): void {
  self.postMessage(response, [...transfer]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unknown embedding worker error occurred.";
}

async function initialize(
  request: Extract<EmbeddingWorkerRequest, { kind: "initialize" }>,
): Promise<void> {
  try {
    if (
      !/^[a-f0-9]{40}$/u.test(request.config.revision) ||
      !Number.isInteger(request.config.profileVersion) ||
      request.config.profileVersion < 1 ||
      !Number.isInteger(request.config.nativeDimension) ||
      request.config.nativeDimension < request.config.expectedDimension ||
      !Number.isInteger(request.config.maximumTokens) ||
      request.config.maximumTokens < 1 ||
      !request.config.pooling.outputTensor
    ) {
      post({
        kind: "error",
        requestId: request.requestId,
        code: "CONFIGURATION_INVALID",
        message: "The embedding Worker received an invalid or unpinned model profile.",
      });
      return;
    }
    if (model) await model.dispose();
    model = undefined;
    tokenizer = undefined;
    activeConfig = undefined;
    // During setup, go straight to the pinned Hub artifact instead of probing an unrelated
    // node_modules/models path. Normal inference remains strictly local.
    env.allowLocalModels = true;
    env.allowRemoteModels = !request.config.localFilesOnly;
    env.cacheDir = request.config.cacheDir;
    const common = {
      cache_dir: request.config.cacheDir,
      local_files_only: request.config.localFilesOnly,
      revision: request.config.revision,
    } as const;
    // Transformers.js 4.2 tokenizer discovery drops revision/cache options during its metadata
    // probe. Explicit setup therefore acquires the two inert JSON assets from the immutable commit,
    // and every tokenizer load targets that exact local directory. Model loading remains on the
    // normal Transformers.js pinned-revision path.
    const tokenizerDirectory = request.config.localFilesOnly
      ? pinnedModelDirectory(request.config)
      : await acquirePinnedTokenizer(request.config);
    tokenizer = await AutoTokenizer.from_pretrained(tokenizerDirectory, {
      local_files_only: true,
    });
    if (tokenizer.padding_side !== request.config.tokenizer.paddingSide) {
      throw new Error(
        `Expected ${request.config.tokenizer.paddingSide} tokenizer padding, received ${tokenizer.padding_side}.`,
      );
    }
    const truncationSide = String(tokenizer._tokenizerConfig.truncation_side ?? "right");
    if (truncationSide !== request.config.tokenizer.truncationSide) {
      throw new Error(
        `Expected ${request.config.tokenizer.truncationSide} tokenizer truncation, received ${truncationSide}.`,
      );
    }
    for (const [kind, encoding, expected] of [
      [
        "document",
        request.config.documentEncoding,
        request.config.tokenizer.promptTokenOverhead.document,
      ],
      ["query", request.config.queryEncoding, request.config.tokenizer.promptTokenOverhead.query],
    ] as const) {
      const actual = tokenizer.encode(composeEmbeddingInput(encoding, ""), {
        add_special_tokens: request.config.tokenizer.addSpecialTokens,
      }).length;
      if (actual !== expected) {
        throw new Error(
          `The ${kind} prompt overhead changed: expected ${expected}, received ${actual}.`,
        );
      }
    }
    model = await AutoModel.from_pretrained(request.config.modelId, {
      ...common,
      device: request.config.device,
      dtype: request.config.dtype,
    });
    // Inference never needs the network, including after an explicit setup download.
    env.allowRemoteModels = false;
    activeConfig = request.config;
    post({
      kind: "ready",
      requestId: request.requestId,
      modelId: request.config.modelId,
      profileVersion: request.config.profileVersion,
      revision: request.config.revision,
    });
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
    const maximumTokens = request.maximumTokens ?? activeConfig.maximumTokens;
    if (
      !Number.isInteger(maximumTokens) ||
      maximumTokens < 1 ||
      maximumTokens > activeConfig.maximumTokens
    ) {
      throw new Error(
        `The requested token limit exceeds the approved ${activeConfig.maximumTokens}.`,
      );
    }
    const modelInputs = tokenizer([...request.texts], {
      padding: request.maximumTokens ? "max_length" : true,
      truncation: true,
      add_special_tokens: activeConfig.tokenizer.addSpecialTokens,
      max_length: maximumTokens,
    });
    const output = (await model(modelInputs)) as Readonly<Record<string, Tensor | undefined>>;
    const storage = poolEmbeddingTensors({
      attentionMask: modelInputs.attention_mask,
      expectedCount: request.texts.length,
      nativeDimension: activeConfig.nativeDimension,
      outputDimension: activeConfig.expectedDimension,
      outputs: output,
      pooling: activeConfig.pooling,
    });
    const response: EmbeddingWorkerResponse = {
      kind: "embeddings",
      requestId: request.requestId,
      storage,
      count: request.texts.length,
      dimension: activeConfig.expectedDimension,
    };
    post(response, [storage.buffer]);
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
