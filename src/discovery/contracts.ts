import type { AppError, Result } from "../shared/result.ts";

export type FileFormat =
  | "markdown"
  | "html"
  | "python"
  | "javascript"
  | "typescript"
  | "json"
  | "yaml"
  | "toml"
  | "stylesheet"
  | "shell"
  | "sql"
  | "xml"
  | "csv"
  | "text"
  | "unknown";

export type FileReadStatus = "ready" | "unsupported" | "malformed" | "unreadable" | "unsafe";
export type FileIndexStatus = "pending" | "skipped";

export interface FileFingerprint {
  readonly size: number;
  readonly modifiedAtMs: number;
  /** Decimal nanoseconds are persisted as strings because JSON cannot represent bigint. */
  readonly modifiedAtNs: string;
  readonly changedAtNs: string;
  readonly timestampPrecisionMs: number;
  readonly contentHash?: string;
  /** Filesystem identity is useful locally but is never part of a portable file ID. */
  readonly deviceId?: string;
  readonly inode?: string;
}

export interface DiscoveredFile {
  readonly fileId: string;
  readonly rootIdentity: string;
  readonly relativePath: string;
  readonly canonicalPath: string;
  readonly filename: string;
  /** Lowercase extension including the leading dot, or an empty string. */
  readonly extension: string;
  readonly format: FileFormat;
  readonly mimeFamily: string;
  readonly fingerprint: FileFingerprint;
  readonly readStatus: FileReadStatus;
  readonly indexStatus: FileIndexStatus;
  readonly lastError?: string;
}

export type FileChangeKind =
  | "added"
  | "content-changed"
  | "metadata-only"
  | "unchanged"
  | "deleted"
  | "failed";

export type FileChangeSource = "scan" | "watch" | "reconcile";

export interface FileChange {
  readonly kind: FileChangeKind;
  readonly fileId: string;
  readonly relativePath: string;
  readonly source: FileChangeSource;
  readonly current?: DiscoveredFile;
  readonly previous?: DiscoveredFile;
  readonly error?: string;
}

export interface DiscoveryProgress {
  readonly phase: "scanning" | "complete";
  readonly discovered: number;
  readonly unchanged: number;
  readonly pending: number;
  readonly failed: number;
  readonly removed: number;
}

export interface DiscoveryScanResult {
  readonly files: readonly DiscoveredFile[];
  readonly changes: readonly FileChange[];
  readonly progress: DiscoveryProgress;
}

export type DiscoveryErrorCode =
  | "DISCOVERY_ROOT_UNAVAILABLE"
  | "MANIFEST_READ_FAILED"
  | "MANIFEST_WRITE_FAILED";

export interface DiscoveryError extends AppError<DiscoveryErrorCode> {}

export type FileChangeListener = (changes: readonly FileChange[]) => void;

export interface FileManifest {
  readonly rootIdentity: string;
  snapshot(): readonly DiscoveredFile[];
  get(fileId: string): DiscoveredFile | undefined;
  replace(
    files: readonly DiscoveredFile[],
    changes: readonly FileChange[],
  ): Promise<Result<void, DiscoveryError>>;
  subscribe(listener: FileChangeListener): () => void;
}

export interface FileScanner {
  scan(source?: FileChangeSource): Promise<Result<DiscoveryScanResult, DiscoveryError>>;
  subscribeProgress(listener: (progress: DiscoveryProgress) => void): () => void;
}

export interface RawWatchEvent {
  readonly eventType: "rename" | "change" | "unknown";
  readonly path?: string;
}

export interface WatchSubscription {
  close(): void;
}

export interface WatchSource {
  start(
    root: string,
    onEvent: (event: RawWatchEvent) => void,
    onError: (error: Error) => void,
  ): WatchSubscription;
}
