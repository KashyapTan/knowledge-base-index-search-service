import type { SearchRequest, SearchResponse } from "../search/index.ts";
import type {
  ApplicationEventData,
  ApplicationStatus,
  FileMetadataResponse,
} from "../server/index.ts";

const API_PREFIX = "/api/v1";
const EVENT_TYPES = ["snapshot", "startup", "discovery", "indexing", "files", "issue"] as const;

interface ErrorEnvelope {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
  };
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
  }
}

export interface EventSubscription {
  close(): void;
}

export interface KbissApi {
  getStatus(signal: AbortSignal): Promise<ApplicationStatus>;
  search(request: SearchRequest, signal: AbortSignal): Promise<SearchResponse>;
  getFileMetadata(fileId: string, signal: AbortSignal): Promise<FileMetadataResponse>;
  getFileContent(fileId: string, signal: AbortSignal): Promise<string>;
  subscribe(
    onEvent: (event: ApplicationEventData) => void,
    onConnectionError: (message: string) => void,
  ): EventSubscription;
}

async function readResponse<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  let envelope: ErrorEnvelope = {};
  try {
    envelope = (await response.json()) as ErrorEnvelope;
  } catch {
    // The display-safe fallback below also covers invalid proxy/server responses.
  }
  const code = typeof envelope.error?.code === "string" ? envelope.error.code : "REQUEST_FAILED";
  const message =
    typeof envelope.error?.message === "string"
      ? envelope.error.message
      : "The local service could not complete the request.";
  throw new ApiClientError(code, message, response.status);
}

export class BrowserKbissApi implements KbissApi {
  async getStatus(signal: AbortSignal): Promise<ApplicationStatus> {
    return readResponse<ApplicationStatus>(
      await fetch(`${API_PREFIX}/status`, { signal, headers: { Accept: "application/json" } }),
    );
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResponse> {
    return readResponse<SearchResponse>(
      await fetch(`${API_PREFIX}/search`, {
        method: "POST",
        signal,
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
  }

  async getFileMetadata(fileId: string, signal: AbortSignal): Promise<FileMetadataResponse> {
    return readResponse<FileMetadataResponse>(
      await fetch(`${API_PREFIX}/files/${encodeURIComponent(fileId)}`, {
        signal,
        headers: { Accept: "application/json" },
      }),
    );
  }

  async getFileContent(fileId: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(`${API_PREFIX}/files/${encodeURIComponent(fileId)}/content`, {
      signal,
      headers: { Accept: "text/plain" },
    });
    if (response.ok) return response.text();
    return readResponse<never>(response);
  }

  subscribe(
    onEvent: (event: ApplicationEventData) => void,
    onConnectionError: (message: string) => void,
  ): EventSubscription {
    const source = new EventSource(`${API_PREFIX}/events`);
    const receive = (raw: Event): void => {
      if (!(raw instanceof MessageEvent) || typeof raw.data !== "string") return;
      try {
        onEvent(JSON.parse(raw.data) as ApplicationEventData);
      } catch {
        onConnectionError("A progress update could not be read.");
      }
    };
    for (const type of EVENT_TYPES) source.addEventListener(type, receive);
    source.onerror = () => onConnectionError("Reconnecting to local progress updates…");
    return source;
  }
}

export const browserApi = new BrowserKbissApi();
