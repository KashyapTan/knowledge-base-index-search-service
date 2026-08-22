import type { AppConfig, StartupIssue, StartupState } from "../config/index.ts";
import type {
  DiscoveredFile,
  DiscoveryProgress,
  FileManifest,
  FileScanner,
} from "../discovery/index.ts";
import type {
  EmbeddingProvider,
  IndexingProgress,
  IndexingService,
  IndexStore,
} from "../indexing/index.ts";
import type { SearchRequest, SearchResponse, SearchService } from "../search/index.ts";
import type { AppError, Result } from "../shared/result.ts";

export const API_PREFIX = "/api/v1";
export const MAX_REQUEST_BYTES = 32 * 1024;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export type ApiErrorCode =
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "HOST_NOT_ALLOWED"
  | "ORIGIN_NOT_ALLOWED"
  | "CSRF_TOKEN_INVALID"
  | "CONTENT_TYPE_INVALID"
  | "REQUEST_TOO_LARGE"
  | "REQUEST_BODY_INVALID"
  | "SEARCH_BUSY"
  | "SEARCH_CANCELLED"
  | "SEARCH_UNAVAILABLE"
  | "SEARCH_FAILED"
  | "FILE_ID_INVALID"
  | "FILE_NOT_FOUND"
  | "FILE_UNSAFE"
  | "FILE_NOT_REGULAR"
  | "FILE_TOO_LARGE"
  | "FILE_READ_FAILED"
  | "ACTION_INVALID"
  | "ACTION_BUSY"
  | "APPLICATION_SHUTTING_DOWN"
  | "INTERNAL_ERROR";

export interface ApiError extends AppError<ApiErrorCode> {
  readonly status: number;
}

export interface FileMetadataResponse {
  readonly fileId: string;
  readonly relativePath: string;
  readonly filename: string;
  readonly format: string;
  readonly mimeFamily: string;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly readStatus: DiscoveredFile["readStatus"];
}

export interface ApplicationStatus {
  /** Display-safe basename of the configured root; never an absolute local path. */
  readonly sourceRootLabel: string;
  readonly startup: StartupState;
  readonly discovery?: DiscoveryProgress;
  readonly indexing?: IndexingProgress;
  readonly searchAvailable: boolean;
  readonly actionInProgress: boolean;
  readonly shuttingDown: boolean;
  /** Readable only by same-origin clients; required for state-changing actions. */
  readonly csrfToken: string;
}

export interface OpenFileChange {
  readonly fileId: string;
  readonly kind: "changed" | "deleted";
}

export type ApplicationEventData =
  | { readonly type: "snapshot"; readonly status: ApplicationStatus }
  | { readonly type: "startup"; readonly startup: StartupState }
  | { readonly type: "discovery"; readonly progress: DiscoveryProgress }
  | { readonly type: "indexing"; readonly progress: IndexingProgress }
  | { readonly type: "files"; readonly changes: readonly OpenFileChange[] }
  | { readonly type: "issue"; readonly issue: StartupIssue };

export interface SequencedApplicationEvent {
  readonly id: number;
  readonly data: ApplicationEventData;
}

export interface ApplicationServices {
  readonly discovery: {
    readonly manifest: FileManifest;
    readonly scanner: FileScanner;
    readonly watcher: {
      start(options?: { readonly scanInitially?: boolean }): Promise<void>;
      stop(): void;
    };
  };
  readonly embeddings: EmbeddingProvider;
  readonly indexing: IndexingService;
  readonly store: IndexStore;
  readonly search: SearchService;
  readonly closeExtraction: () => Promise<void>;
  readonly closeSearch: () => void;
}

export type ApplicationServicesFactory = (
  config: AppConfig,
  signal: AbortSignal,
) => Promise<Result<ApplicationServices, AppError>>;

export interface SearchExecutor {
  search(request: SearchRequest, signal: AbortSignal): Promise<Result<SearchResponse, ApiError>>;
}
