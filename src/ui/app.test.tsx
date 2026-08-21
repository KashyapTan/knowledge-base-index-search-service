import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SearchFileResult, SearchRequest, SearchResponse } from "../search/index.ts";
import type {
  ApplicationEventData,
  ApplicationStatus,
  FileMetadataResponse,
} from "../server/index.ts";
import type { EventSubscription, KbissApi } from "./api.ts";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import(
  "@testing-library/react"
);
const { App } = await import("./app.tsx");

function readyStatus(overrides: Partial<ApplicationStatus> = {}): ApplicationStatus {
  return {
    sourceRootLabel: "card-gateway-artifacts",
    startup: { phase: "ready", changedAt: 1, issues: [] },
    searchAvailable: true,
    actionInProgress: false,
    shuttingDown: false,
    csrfToken: "fixture",
    ...overrides,
  };
}

function excerpt(id: string, text: string, startLine = 4) {
  return {
    chunkId: id,
    text,
    startLine,
    endLine: startLine + 2,
    startOffset: 10,
    endOffset: 30,
    headingTrail: ["Operations", "Timeout handling"],
    symbols: ["retryGateway"],
    score: 0.1,
    matchSources: ["bm25" as const],
    highlightTerms: ["timeout_ms"],
  };
}

function result(
  fileId: string,
  filename: string,
  relativePath: string,
  excerpts = [excerpt(`${fileId}-chunk`, "Set timeout_ms before retrying the gateway.")],
): SearchFileResult {
  return {
    fileId,
    filename,
    relativePath,
    format: filename.endsWith(".md") ? "markdown" : "typescript",
    score: 0.2,
    matchSources: ["metadata", "bm25"],
    excerpts,
  };
}

function response(query: string, results: readonly SearchFileResult[] = []): SearchResponse {
  return {
    query,
    requestedFileCount: 10,
    formats: [],
    timing: {
      totalMs: 7.6,
      embeddingMs: 1,
      retrievalMs: 2,
      vectorMs: 1,
      bm25Ms: 1,
      metadataMs: 1,
      fusionMs: 1,
      aggregationMs: 1,
    },
    results,
  };
}

interface SearchCall {
  readonly request: SearchRequest;
  readonly signal: AbortSignal;
}

class FakeApi implements KbissApi {
  status: ApplicationStatus = readyStatus();
  statusError: Error | undefined;
  readonly searchCalls: SearchCall[] = [];
  readonly searchHandlers: Array<
    (request: SearchRequest, signal: AbortSignal) => Promise<SearchResponse>
  > = [];
  fileMetadata: FileMetadataResponse | undefined;
  eventListener: ((event: ApplicationEventData) => void) | undefined;
  connectionListener: ((message: string) => void) | undefined;
  closed = false;

  async getStatus(_signal: AbortSignal): Promise<ApplicationStatus> {
    if (this.statusError) throw this.statusError;
    return this.status;
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResponse> {
    this.searchCalls.push({ request, signal });
    const handler = this.searchHandlers.shift();
    return handler ? handler(request, signal) : response(request.query);
  }

  async getFileMetadata(_fileId: string, _signal: AbortSignal): Promise<FileMetadataResponse> {
    if (!this.fileMetadata) throw new Error("File metadata is unavailable.");
    return this.fileMetadata;
  }

  subscribe(
    onEvent: (event: ApplicationEventData) => void,
    onConnectionError: (message: string) => void,
  ): EventSubscription {
    this.eventListener = onEvent;
    this.connectionListener = onConnectionError;
    return { close: () => (this.closed = true) };
  }

  emit(event: ApplicationEventData): void {
    this.eventListener?.(event);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function renderReady(api = new FakeApi(), debounceMs = 20) {
  const view = render(<App api={api} debounceMs={debounceMs} />);
  await screen.findByText("card-gateway-artifacts");
  return { api, view, input: screen.getByRole("searchbox", { name: "Search the knowledge base" }) };
}

beforeEach(() => {
  window.history.replaceState({}, "", "http://localhost/");
});

afterEach(() => {
  jest.useRealTimers();
  cleanup();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("Plan 08 React search experience", () => {
  test("loads status, exposes the safe root label, focuses search, and supports refocus shortcuts", async () => {
    const { input } = await renderReady();
    expect(document.activeElement).toBe(input);
    expect(screen.getByText("card-gateway-artifacts")).toBeTruthy();
    expect(screen.getByText("Search by what you remember")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search" }).hasAttribute("disabled")).toBe(true);

    const count = screen.getByRole("combobox", { name: "Show" });
    (count as HTMLElement).focus();
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(input);
    (count as HTMLElement).focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(input);
  });

  test("represents progress, partial results, diagnostics, reconnection, degraded, and fatal states", async () => {
    const api = new FakeApi();
    api.status = readyStatus({
      startup: { phase: "indexing", changedAt: 1, issues: [] },
      indexing: {
        phase: "embedding",
        totalFiles: 8,
        processedFiles: 3,
        unchangedFiles: 1,
        failedFiles: 1,
        deletedFiles: 0,
        totalChunks: 20,
        embeddedChunks: 9,
        reusedChunks: 1,
        committedChunks: 7,
        batchesCompleted: 2,
        errors: [
          {
            fileId: "f".repeat(64),
            relativePath: "broken/really-long-file.md",
            code: "EXTRACT_FAILED",
            message: "Could not extract this file.",
          },
        ],
      },
    });
    await renderReady(api);
    expect(screen.getByText("Building the local index")).toBeTruthy();
    expect(screen.getByText(/3 of 8 files · 7 chunks committed/)).toBeTruthy();
    expect(screen.getByText(/Results may be incomplete/)).toBeTruthy();
    fireEvent.click(screen.getByText("1 isolated issue"));
    expect(screen.getByText(/broken\/really-long-file.md/)).toBeTruthy();

    act(() => api.connectionListener?.("Reconnecting to local progress updates…"));
    expect(screen.getByText("Reconnecting to local progress updates…")).toBeTruthy();
    act(() =>
      api.emit({
        type: "startup",
        startup: {
          phase: "degraded",
          resumePhase: "ready",
          changedAt: 2,
          issues: [{ code: "WATCH", message: "Watching paused." }],
        },
      }),
    );
    expect(screen.getByText("Search is available with isolated issues")).toBeTruthy();
    act(() =>
      api.emit({
        type: "startup",
        startup: {
          phase: "error",
          changedAt: 3,
          issues: [],
          error: { code: "MODEL", message: "The model could not load." },
        },
      }),
    );
    expect(screen.getByRole("alert").textContent).toContain("The model could not load.");
  });

  test("debounces typing, submits Enter immediately, preserves punctuation, and refreshes for top-X", async () => {
    const { api, input } = await renderReady(new FakeApi(), 100);
    jest.useFakeTimers();
    fireEvent.change(input, { target: { value: `  timeout_ms("A/B")  ` } });
    act(() => jest.advanceTimersByTime(99));
    expect(api.searchCalls).toHaveLength(0);
    act(() => jest.advanceTimersByTime(1));
    await act(async () => Promise.resolve());
    expect(api.searchCalls[0]?.request).toEqual({ query: `  timeout_ms("A/B")  `, fileCount: 10 });
    expect(new URL(window.location.href).searchParams.get("q")).toBe(`  timeout_ms("A/B")  `);

    fireEvent.change(input, { target: { value: "retry_now!" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(api.searchCalls.at(-1)?.request.query).toBe("retry_now!");
    fireEvent.change(screen.getByRole("combobox", { name: "Show" }), { target: { value: "20" } });
    act(() => jest.advanceTimersByTime(100));
    await act(async () => Promise.resolve());
    expect(api.searchCalls.at(-1)?.request).toEqual({ query: "retry_now!", fileCount: 20 });
    expect(new URL(window.location.href).searchParams.get("n")).toBe("20");

    fireEvent.change(input, { target: { value: "submit button query" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Search" }));
      await Promise.resolve();
    });
    expect(api.searchCalls.at(-1)?.request.query).toBe("submit button query");
  });

  test("aborts stale requests and prevents their late responses from replacing newer results", async () => {
    const api = new FakeApi();
    const first = deferred<SearchResponse>();
    const second = deferred<SearchResponse>();
    api.searchHandlers.push(
      () => first.promise,
      () => second.promise,
    );
    const { input } = await renderReady(api);

    fireEvent.change(input, { target: { value: "old query" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "new query" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.searchCalls[0]?.signal.aborted).toBe(true);

    second.resolve(response("new query", [result("b".repeat(64), "new.md", "new/new.md")]));
    await screen.findByText("new.md");
    first.resolve(response("old query", [result("a".repeat(64), "old.md", "old/old.md")]));
    await act(async () => Promise.resolve());
    expect(screen.queryByText("old.md")).toBeNull();
    expect(screen.getByText("new.md")).toBeTruthy();
  });

  test("groups excerpts by file, expands sections, navigates result actions, and opens the viewer host", async () => {
    const api = new FakeApi();
    const first = result("a".repeat(64), "gateway.md", "docs/gateway.md", [
      excerpt("one", "Primary timeout_ms setting."),
      excerpt("two", "Secondary timeout_ms fallback.", 22),
    ]);
    const second = result("b".repeat(64), "client.ts", `packages/${"deep/".repeat(30)}client.ts`, [
      excerpt("three", `${"large excerpt ".repeat(300)}timeout_ms`, 80),
    ]);
    api.searchHandlers.push(async () => response("timeout_ms", [first, second]));
    const { input } = await renderReady(api);
    fireEvent.change(input, { target: { value: "timeout_ms" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("gateway.md");
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getAllByText("timeout_ms", { selector: "mark" }).length).toBeGreaterThan(0);

    const showMore = screen.getByRole("button", { name: "Show 1 more matched section" });
    expect(showMore.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(showMore);
    expect(screen.getByText(/Secondary/)).toBeTruthy();
    expect(showMore.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    const openButtons = screen.getAllByRole("button", { name: "Open full file" });
    const firstOpen = openButtons[0];
    const secondOpen = openButtons[1];
    if (!firstOpen || !secondOpen) throw new Error("Expected two file actions.");
    expect(document.activeElement).toBe(firstOpen);
    fireEvent.keyDown(firstOpen, { key: "ArrowDown" });
    expect(document.activeElement).toBe(secondOpen);
    fireEvent.keyDown(secondOpen, { key: "Home" });
    expect(document.activeElement).toBe(firstOpen);

    const routed = new URL(window.location.href);
    routed.searchParams.set("file", "b".repeat(64));
    routed.searchParams.set("line", "80");
    window.history.replaceState({}, "", routed);
    fireEvent.popState(window);
    const routedViewer = screen.getByRole("complementary", { name: "Selected file" });
    expect(within(routedViewer).getByText("client.ts")).toBeTruthy();
    fireEvent.click(within(routedViewer).getByRole("button", { name: "Close selection" }));

    fireEvent.click(firstOpen);
    const viewer = screen.getByRole("complementary", { name: "Selected file" });
    expect(within(viewer).getByText("gateway.md")).toBeTruthy();
    expect(within(viewer).getByText(/opening near line 4/)).toBeTruthy();
    expect(new URL(window.location.href).searchParams.get("file")).toBe("a".repeat(64));
    fireEvent.click(within(viewer).getByRole("button", { name: "Close selection" }));
    expect(screen.queryByRole("complementary", { name: "Selected file" })).toBeNull();
  });

  test("keeps useful results during refresh and distinguishes no-results and error states", async () => {
    const api = new FakeApi();
    const refresh = deferred<SearchResponse>();
    api.searchHandlers.push(
      async () => response("first", [result("a".repeat(64), "first.md", "first.md")]),
      () => refresh.promise,
      async () => response("none", []),
      async () => {
        throw new Error("Index is temporarily unavailable.");
      },
      async () => response("retry", []),
    );
    const { input } = await renderReady(api);
    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findAllByText("first.md");
    fireEvent.change(input, { target: { value: "refresh" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("Refreshing results…")).toBeTruthy();
    expect(screen.getAllByText("first.md")).toHaveLength(2);
    refresh.resolve(response("refresh", []));
    await screen.findByText("No matching files");

    fireEvent.change(input, { target: { value: "none" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("No matching files");
    fireEvent.change(input, { target: { value: "error" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("Search could not be completed");
    expect(screen.getByRole("alert").textContent).toContain("Index is temporarily unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.searchCalls.at(-1)?.request.query).toBe("error"));
  });

  test("restores query/count from the URL, reacts to Back state, and cleans up subscriptions", async () => {
    window.history.replaceState({}, "", "http://localhost/?q=quoted%20%22error%22&n=30");
    const api = new FakeApi();
    const { view, input } = await renderReady(api, 1);
    expect((input as HTMLInputElement).value).toBe('quoted "error"');
    expect((screen.getByRole("combobox", { name: "Show" }) as HTMLSelectElement).value).toBe("30");
    await waitFor(() => expect(api.searchCalls).toHaveLength(1));

    window.history.replaceState({}, "", "http://localhost/?q=back-state&n=5");
    fireEvent.popState(window);
    expect((input as HTMLInputElement).value).toBe("back-state");
    expect((screen.getByRole("combobox", { name: "Show" }) as HTMLSelectElement).value).toBe("5");
    view.unmount();
    expect(api.closed).toBe(true);
  });

  test("restores a deep-linked file selection through the opaque metadata route", async () => {
    const fileId = "c".repeat(64);
    window.history.replaceState({}, "", `http://localhost/?file=${fileId}&line=17`);
    const api = new FakeApi();
    api.fileMetadata = {
      fileId,
      relativePath: "deep/linked/guide.md",
      filename: "guide.md",
      format: "markdown",
      mimeFamily: "text/markdown",
      size: 42,
      modifiedAtMs: 1,
      readStatus: "ready",
    };
    await renderReady(api);
    const viewer = screen.getByRole("complementary", { name: "Selected file" });
    expect(await within(viewer).findByText("guide.md")).toBeTruthy();
    expect(within(viewer).getByText("deep/linked/guide.md")).toBeTruthy();
    expect(within(viewer).getByText(/opening near line 17/)).toBeTruthy();
    expect(new URL(window.location.href).searchParams.get("file")).toBe(fileId);
  });

  test("shows a display-safe status failure while retaining an operable search field", async () => {
    const api = new FakeApi();
    api.statusError = new Error("Status is temporarily unavailable.");
    render(<App api={api} debounceMs={1} />);
    expect(await screen.findByText("Status is temporarily unavailable.")).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search the knowledge base" })).toBeTruthy();
  });
});
