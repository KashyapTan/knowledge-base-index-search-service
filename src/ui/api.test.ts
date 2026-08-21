import { afterEach, describe, expect, test } from "bun:test";
import type { ApplicationStatus } from "../server/index.ts";
import { BrowserKbissApi } from "./api.ts";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

function replaceFetch(
  implementation: (...arguments_: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void {
  globalThis.fetch = Object.assign(implementation, { preconnect: () => undefined });
}

class FixtureEventSource {
  static latest: FixtureEventSource | undefined;
  readonly listeners = new Map<string, (event: Event) => void>();
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string | URL) {
    FixtureEventSource.latest = this;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(type, (event) => {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    });
  }

  emit(type: string, event: Event): void {
    this.listeners.get(type)?.(event);
  }

  close(): void {
    this.closed = true;
  }
}

function status(): ApplicationStatus {
  return {
    sourceRootLabel: "artifacts",
    startup: { phase: "ready", changedAt: 1, issues: [] },
    searchAvailable: true,
    actionInProgress: false,
    shuttingDown: false,
    csrfToken: "fixture",
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    writable: true,
    value: originalEventSource,
  });
  FixtureEventSource.latest = undefined;
});

describe("browser API adapter", () => {
  test("uses the versioned typed status, search, and file metadata routes", async () => {
    const requests: Request[] = [];
    replaceFetch(async (input, init) => {
      const request = new Request(new URL(String(input), "http://localhost"), init);
      requests.push(request);
      if (request.url.endsWith("/status")) return Response.json(status());
      if (request.url.endsWith("/content")) {
        return new Response("# Guide\nComplete content.\n", {
          headers: { "Content-Type": "text/plain" },
        });
      }
      if (request.url.includes("/files/")) {
        return Response.json({
          fileId: "a".repeat(64),
          relativePath: "guide.md",
          filename: "guide.md",
          format: "markdown",
          mimeFamily: "text/markdown",
          size: 10,
          modifiedAtMs: 1,
          readStatus: "ready",
        });
      }
      return Response.json({
        query: "timeout_ms",
        requestedFileCount: 5,
        formats: [],
        timing: {
          totalMs: 1,
          embeddingMs: 0,
          retrievalMs: 0,
          vectorMs: 0,
          bm25Ms: 0,
          metadataMs: 0,
          fusionMs: 0,
          aggregationMs: 0,
        },
        results: [],
      });
    });
    const api = new BrowserKbissApi();
    const signal = new AbortController().signal;
    expect((await api.getStatus(signal)).sourceRootLabel).toBe("artifacts");
    expect((await api.search({ query: "timeout_ms", fileCount: 5 }, signal)).query).toBe(
      "timeout_ms",
    );
    expect((await api.getFileMetadata("a".repeat(64), signal)).filename).toBe("guide.md");
    expect(await api.getFileContent("a".repeat(64), signal)).toContain("Complete content");
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/v1/status",
      "/api/v1/search",
      `/api/v1/files/${"a".repeat(64)}`,
      `/api/v1/files/${"a".repeat(64)}/content`,
    ]);
    expect(requests[1]?.method).toBe("POST");
    expect(await requests[1]?.json()).toEqual({ query: "timeout_ms", fileCount: 5 });
  });

  test("maps structured and malformed failures to display-safe client errors", async () => {
    const api = new BrowserKbissApi();
    replaceFetch(async () =>
      Response.json(
        { error: { code: "SEARCH_BUSY", message: "Try again shortly." } },
        { status: 429 },
      ),
    );
    const structured = api.search({ query: "x" }, new AbortController().signal);
    await expect(structured).rejects.toEqual(
      expect.objectContaining({
        name: "ApiClientError",
        code: "SEARCH_BUSY",
        status: 429,
        message: "Try again shortly.",
      }),
    );

    replaceFetch(async () => new Response("not json", { status: 502 }));
    await expect(api.getStatus(new AbortController().signal)).rejects.toMatchObject({
      code: "REQUEST_FAILED",
      status: 502,
      message: "The local service could not complete the request.",
    });
  });

  test("parses named SSE updates, reports malformed data and connection errors, and closes", () => {
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      writable: true,
      value: FixtureEventSource,
    });
    const api = new BrowserKbissApi();
    const events: string[] = [];
    const errors: string[] = [];
    const subscription = api.subscribe(
      (event) => events.push(event.type),
      (message) => errors.push(message),
    );
    const source = FixtureEventSource.latest;
    if (!source) throw new Error("Expected EventSource fixture.");
    expect(source.url).toBe("/api/v1/events");
    source.emit(
      "snapshot",
      new MessageEvent("snapshot", {
        data: JSON.stringify({ type: "snapshot", status: status() }),
      }),
    );
    source.emit(
      "files",
      new MessageEvent("files", {
        data: JSON.stringify({
          type: "files",
          changes: [{ fileId: "a".repeat(64), kind: "changed" }],
        }),
      }),
    );
    source.emit("issue", new MessageEvent("issue", { data: "{" }));
    source.emit("startup", new Event("startup"));
    source.onerror?.(new Event("error"));
    expect(events).toEqual(["snapshot", "files"]);
    expect(errors).toEqual([
      "A progress update could not be read.",
      "Reconnecting to local progress updates…",
    ]);
    subscription.close();
    expect(source.closed).toBe(true);
  });
});
