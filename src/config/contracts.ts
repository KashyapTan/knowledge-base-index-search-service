import type { DataType } from "@huggingface/transformers";
import type { AppError } from "../shared/result.ts";

export const LOOPBACK_HOST = "127.0.0.1" as const;

export interface SourceRoot {
  /** A stable, opaque identity derived from the canonical path. */
  readonly identity: string;
  /** The canonical absolute path. Never use this value as a persisted record ID. */
  readonly path: string;
}

export interface EmbeddingConfig {
  readonly modelId: string;
  readonly normalization: "l2";
  readonly quantization: DataType;
  readonly vectorDimension: number;
}

export interface IndexConfig {
  readonly chunkOverlapTokens: number;
  readonly chunkSizeTokens: number;
  readonly chunkerVersion: number;
  readonly extractorVersion: number;
  readonly schemaVersion: number;
}

export interface ResolvedPaths {
  readonly applicationCacheDir: string;
  readonly applicationStateDir: string;
  readonly compatibilityFile: string;
  readonly diagnosticLogsDir: string;
  readonly indexDir: string;
  readonly indexMetadataDir: string;
  readonly indexNamespace: string;
  readonly lanceDbDir: string;
  readonly modelCacheDir: string;
  readonly rootNamespace: string;
}

export interface IndexCompatibility {
  readonly applicationVersion: string;
  readonly chunking: {
    readonly overlapTokens: number;
    readonly sizeTokens: number;
    readonly version: number;
  };
  readonly descriptorVersion: number;
  readonly embedding: EmbeddingConfig;
  readonly extractorVersion: number;
  readonly indexSchemaVersion: number;
  /** An opaque hash; the absolute source path is deliberately not persisted. */
  readonly rootIdentity: string;
}

export interface AppConfig {
  readonly embedding: EmbeddingConfig;
  readonly index: IndexConfig;
  /** Prevent every model-loading path from using the network. */
  readonly offline: boolean;
  readonly paths: ResolvedPaths;
  readonly server: {
    readonly hostname: typeof LOOPBACK_HOST;
    readonly port: number;
  };
  /** Plan 2 validates exactly one entry; the array preserves a future multi-root contract. */
  readonly sourceRoots: readonly [SourceRoot];
  readonly compatibility: IndexCompatibility;
}

export type ConfigurationErrorCode =
  | "CLI_ARGUMENT_INVALID"
  | "CONFIG_FILE_INVALID"
  | "CONFIG_VALUE_INVALID"
  | "HOME_DIRECTORY_UNAVAILABLE"
  | "ROOT_NOT_FOUND"
  | "ROOT_NOT_DIRECTORY"
  | "ROOT_UNREADABLE"
  | "STATE_DIRECTORY_UNAVAILABLE"
  | "STATE_PATH_UNSAFE"
  | "PORT_UNAVAILABLE"
  | "PORT_CHECK_FAILED"
  | "SERVER_START_FAILED";

export interface ConfigurationError extends AppError<ConfigurationErrorCode> {}

export type CompatibilityStatus =
  | "compatible"
  | "migration-required"
  | "rebuild-required"
  | "corrupt";

export interface CompatibilityAssessment {
  readonly status: CompatibilityStatus;
  readonly reasons: readonly string[];
  readonly stored?: IndexCompatibility;
}

export type CompatibilityErrorCode =
  | "COMPATIBILITY_METADATA_UNREADABLE"
  | "COMPATIBILITY_METADATA_WRITE_FAILED";

export interface CompatibilityError extends AppError<CompatibilityErrorCode> {}

export interface StartupIssue {
  readonly code: string;
  readonly message: string;
  readonly fileId?: string;
}

export type ActiveStartupPhase =
  | "starting"
  | "validating"
  | "loading_model"
  | "scanning"
  | "indexing"
  | "ready";

interface StartupStateBase {
  readonly changedAt: number;
  readonly issues: readonly StartupIssue[];
}

export type StartupState =
  | (StartupStateBase & { readonly phase: ActiveStartupPhase })
  | (StartupStateBase & {
      readonly phase: "degraded";
      readonly resumePhase: "scanning" | "indexing" | "ready";
    })
  | (StartupStateBase & {
      readonly phase: "error";
      readonly error: StartupIssue;
    });

export type StartupEvent =
  | { readonly type: "begin_validation" }
  | { readonly type: "configuration_validated" }
  | { readonly type: "model_loaded" }
  | { readonly type: "scan_completed" }
  | { readonly type: "index_committed" }
  | { readonly type: "file_error"; readonly issue: StartupIssue }
  | { readonly type: "continue_degraded" }
  | { readonly type: "fatal_error"; readonly error: StartupIssue };

export interface StartupTransitionError extends AppError<"INVALID_STARTUP_TRANSITION"> {}
