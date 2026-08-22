import type { AppConfig } from "../config/index.ts";
import type { DiscoveredFile } from "../discovery/index.ts";
import type { ExtractedFile, ExtractionError } from "./contracts.ts";

export interface ExtractionWorkerConfig {
  readonly config: AppConfig;
  readonly maximumTokens: number;
}

export type ExtractionWorkerRequest =
  | {
      readonly kind: "initialize";
      readonly requestId: string;
      readonly config: ExtractionWorkerConfig;
    }
  | { readonly kind: "extract"; readonly requestId: string; readonly file: DiscoveredFile }
  | { readonly kind: "shutdown"; readonly requestId: string };

export type ExtractionWorkerResponse =
  | { readonly kind: "ready"; readonly requestId: string }
  | { readonly kind: "extracted"; readonly requestId: string; readonly value: ExtractedFile }
  | {
      readonly kind: "error";
      readonly requestId: string;
      readonly error: ExtractionError;
    }
  | { readonly kind: "stopped"; readonly requestId: string };
