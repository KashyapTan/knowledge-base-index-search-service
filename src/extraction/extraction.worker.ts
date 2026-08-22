import { join } from "node:path";
import { AutoTokenizer, env } from "@huggingface/transformers";
import type { ExtractionPipeline } from "./contracts.ts";
import { createExtractionPipeline } from "./service.ts";
import { createTransformersTokenCounter } from "./tokenizer.ts";
import type { ExtractionWorkerRequest, ExtractionWorkerResponse } from "./worker-protocol.ts";

declare const self: Worker;

let pipeline: ExtractionPipeline | undefined;

function post(response: ExtractionWorkerResponse): void {
  self.postMessage(response);
}

self.onmessage = (event: MessageEvent<ExtractionWorkerRequest>) => {
  const request = event.data;
  switch (request.kind) {
    case "initialize":
      void (async () => {
        try {
          const embedding = request.config.config.embedding;
          env.allowLocalModels = true;
          env.allowRemoteModels = false;
          const tokenizer = await AutoTokenizer.from_pretrained(
            join(
              request.config.config.paths.modelCacheDir,
              ...embedding.modelId.split("/"),
              embedding.profile.revision,
            ),
            {
              local_files_only: true,
            },
          );
          if (tokenizer.padding_side !== embedding.profile.tokenizer.paddingSide) {
            throw new TypeError("The cached tokenizer padding policy does not match its profile.");
          }
          pipeline = createExtractionPipeline(
            request.config.config,
            createTransformersTokenCounter(tokenizer, {
              addSpecialTokens: embedding.profile.tokenizer.addSpecialTokens,
              encoding: embedding.profile.documentEncoding,
              expectedPromptTokenOverhead: embedding.profile.tokenizer.promptTokenOverhead.document,
            }),
            request.config.maximumTokens,
          );
          post({ kind: "ready", requestId: request.requestId });
        } catch {
          post({
            kind: "error",
            requestId: request.requestId,
            error: {
              code: "EXTRACTION_FAILED",
              message: "The local extraction worker could not initialize its tokenizer.",
              fileId: "worker-initialization",
            },
          });
        }
      })();
      break;
    case "extract":
      void (async () => {
        if (!pipeline) {
          post({
            kind: "error",
            requestId: request.requestId,
            error: {
              code: "EXTRACTION_FAILED",
              message: "The extraction worker is not initialized.",
              fileId: request.file.fileId,
            },
          });
          return;
        }
        const result = await pipeline.process(request.file);
        post(
          result.ok
            ? { kind: "extracted", requestId: request.requestId, value: result.value }
            : { kind: "error", requestId: request.requestId, error: result.error },
        );
      })();
      break;
    case "shutdown":
      pipeline = undefined;
      post({ kind: "stopped", requestId: request.requestId });
      break;
  }
};
