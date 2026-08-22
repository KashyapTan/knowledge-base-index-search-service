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
  fileContent = "# Gateway\nSet timeout_ms before retrying.\n";
  contentError: Error | undefined;
  contentCalls = 0;
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
    return (
      this.fileMetadata ?? {
        fileId: _fileId,
        relativePath: "fixture.md",
        filename: "fixture.md",
        format: "markdown",
        mimeFamily: "text/markdown",
        size: this.fileContent.length,
        modifiedAtMs: 1,
        readStatus: "ready",
      }
    );
  }

  async getFileContent(_fileId: string, _signal: AbortSignal): Promise<string> {
    this.contentCalls += 1;
    if (this.contentError) throw this.contentError;
    return this.fileContent;
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
        currentFile: "src/workers/very-long-indexing-file.ts",
        totalFiles: 8,
        processedFiles: 3,
        unchangedFiles: 1,
        skippedFiles: 0,
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
    const currentFile = screen.getByText("src/workers/very-long-indexing-file.ts");
    expect(currentFile.getAttribute("title")).toBe("src/workers/very-long-indexing-file.ts");
    expect(screen.getByText(/Results may be incomplete/)).toBeTruthy();
    fireEvent.click(screen.getByText("1 isolated issue"));
    expect(screen.getByText(/broken\/really-long-file.md/)).toBeTruthy();

    act(() => api.connectionListener?.("Reconnecting to local progress updates…"));
    expect(screen.getByText("Reconnecting to local progress updates…")).toBeTruthy();
    const initialProgress = api.status.indexing;
    if (!initialProgress) throw new Error("Expected fixture indexing progress.");
    act(() =>
      api.emit({
        type: "indexing",
        progress: {
          ...initialProgress,
          phase: "committing",
          currentFile: "docs/next-file.md",
          processedFiles: 4,
        },
      }),
    );
    expect(screen.getByText("docs/next-file.md")).toBeTruthy();
    expect(screen.queryByText("src/workers/very-long-indexing-file.ts")).toBeNull();
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
    const routedViewer = screen.getByRole("dialog", { name: "client.ts" });
    expect(within(routedViewer).getByText("client.ts")).toBeTruthy();
    fireEvent.click(within(routedViewer).getByRole("button", { name: "Close viewer" }));

    fireEvent.click(firstOpen);
    const viewer = screen.getByRole("dialog", { name: "gateway.md" });
    expect(within(viewer).getByText("gateway.md")).toBeTruthy();
    expect(within(viewer).getByText(/line 4/)).toBeTruthy();
    expect(new URL(window.location.href).searchParams.get("file")).toBe("a".repeat(64));
    fireEvent.click(within(viewer).getByRole("button", { name: "Close viewer" }));
    expect(screen.queryByRole("dialog", { name: "gateway.md" })).toBeNull();
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
    const viewer = screen.getByRole("dialog", { name: "guide.md" });
    expect(await within(viewer).findByText("guide.md")).toBeTruthy();
    expect(within(viewer).getByText("deep/linked/guide.md")).toBeTruthy();
    expect(within(viewer).getByText(/line 17/)).toBeTruthy();
    expect(new URL(window.location.href).searchParams.get("file")).toBe(fileId);
  });

  test("traps and restores focus, closes on Escape, and copies only the relative path", async () => {
    const api = new FakeApi();
    const item = result("d".repeat(64), "guide.md", "safe/guide.md");
    api.searchHandlers.push(async () => response("guide", [item]));
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => writes.push(value) },
    });
    const { input } = await renderReady(api);
    fireEvent.change(input, { target: { value: "guide" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const open = await screen.findByRole("button", { name: "Open full file" });
    fireEvent.click(open);
    const dialog = screen.getByRole("dialog", { name: "guide.md" });
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Close viewer" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy path" }));
    await waitFor(() => expect(writes).toEqual(["safe/guide.md"]));

    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled])"),
    ];
    const last = focusable.at(-1);
    if (!last) throw new Error("Expected viewer controls.");
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Copy path" }));
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "guide.md" })).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  test("searches complete source, supports toggles and shortcuts, and highlights the active match", async () => {
    const api = new FakeApi();
    api.fileContent = "# Search\ntimeout_ms first\nTIMEOUT_MS second\nend\n";
    const item = result("e".repeat(64), "search.md", "docs/search.md");
    api.searchHandlers.push(async () => response("search", [item]));
    const { input } = await renderReady(api);
    fireEvent.change(input, { target: { value: "search" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Open full file" }));
    const dialog = screen.getByRole("dialog", { name: "search.md" });
    const find = within(dialog).getByRole("searchbox", { name: "Find in file" });
    fireEvent.change(find, { target: { value: "timeout_ms" } });
    await within(dialog).findByText("2 of 2");
    expect(dialog.querySelectorAll(".markdown-preview mark")).toHaveLength(2);

    fireEvent.keyDown(find, { key: "Enter" });
    expect(
      within(dialog).getByRole("button", { name: "Source" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await waitFor(() => expect(dialog.querySelectorAll("mark.active-match")).toHaveLength(1));
    expect(within(dialog).getByText("1 of 2")).toBeTruthy();
    fireEvent.keyDown(find, { key: "Enter", shiftKey: true });
    expect(within(dialog).getByText("2 of 2")).toBeTruthy();

    fireEvent.click(within(dialog).getByTitle("Case sensitive"));
    await within(dialog).findByText("1 of 1");
    fireEvent.click(within(dialog).getByTitle("Regular expression"));
    fireEvent.change(find, { target: { value: "[" } });
    await within(dialog).findByText("The regular expression is invalid.");
  });

  test("switches HTML preview/source with an inert iframe and reports changed or deleted files", async () => {
    const api = new FakeApi();
    api.fileContent = `<h1>Safe</h1><script>parent.pwned=true</script><img src="https://bad/pixel"><a href="javascript:alert(1)">bad</a><a href="https://example.com/guide">safe guide</a>`;
    const item = {
      ...result("f".repeat(64), "unsafe.html", "fixtures/unsafe.html"),
      format: "html",
    };
    api.fileMetadata = {
      fileId: item.fileId,
      relativePath: item.relativePath,
      filename: item.filename,
      format: "html",
      mimeFamily: "text/html",
      size: api.fileContent.length,
      modifiedAtMs: 1,
      readStatus: "ready",
    };
    api.searchHandlers.push(async () => response("unsafe", [item]));
    const { input } = await renderReady(api);
    fireEvent.change(input, { target: { value: "unsafe" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Open full file" }));
    const dialog = screen.getByRole("dialog", { name: "unsafe.html" });
    const frame = await within(dialog).findByTitle("Sandboxed HTML preview");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(frame.getAttribute("srcdoc")).not.toContain("<script");
    expect(frame.getAttribute("srcdoc")).not.toContain("https://bad");
    expect(within(dialog).getByRole("link", { name: "safe guide" }).getAttribute("target")).toBe(
      "_blank",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Source" }));
    expect(await within(dialog).findByTestId("source-scroller")).toBeTruthy();

    act(() => api.emit({ type: "files", changes: [{ fileId: item.fileId, kind: "changed" }] }));
    expect(await within(dialog).findByText(/changed while it was open/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh file" }));
    await waitFor(() => expect(api.contentCalls).toBe(2));
    api.contentError = new Error("Refresh could not read the file.");
    act(() => api.emit({ type: "files", changes: [{ fileId: item.fileId, kind: "changed" }] }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Refresh file" }));
    expect(await within(dialog).findByText(/previously loaded copy is still shown/)).toBeTruthy();
    expect(within(dialog).getByTitle("Sandboxed HTML preview")).toBeTruthy();
    act(() => api.emit({ type: "files", changes: [{ fileId: item.fileId, kind: "deleted" }] }));
    expect(await within(dialog).findByText(/removed while it was open/)).toBeTruthy();
  });

  test("bounds the rendered DOM for very large text files", async () => {
    const api = new FakeApi();
    api.fileContent = Array.from({ length: 20_000 }, (_, index) => `line ${index + 1}`).join("\n");
    const item = { ...result("9".repeat(64), "huge.log", "logs/huge.log"), format: "text" };
    api.fileMetadata = {
      fileId: item.fileId,
      relativePath: item.relativePath,
      filename: item.filename,
      format: "text",
      mimeFamily: "text/plain",
      size: api.fileContent.length,
      modifiedAtMs: 1,
      readStatus: "ready",
    };
    api.searchHandlers.push(async () => response("huge", [item]));
    const { input } = await renderReady(api);
    fireEvent.change(input, { target: { value: "huge" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Open full file" }));
    const scroller = await screen.findByTestId("source-scroller");
    expect(scroller.querySelectorAll("li").length).toBeLessThan(150);
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 800 });
    scroller.scrollTop = 2_400;
    fireEvent.scroll(scroller);
    await waitFor(() =>
      expect(Number(scroller.querySelector("li")?.dataset.line ?? 0)).toBeGreaterThan(1),
    );
  });

  test("shows display-safe file and clipboard failures", async () => {
    const api = new FakeApi();
    const item = result("8".repeat(64), "failure.md", "safe/failure.md");
    api.contentError = new Error("The requested file no longer exists.");
    api.searchHandlers.push(async () => response("failure", [item]));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => Promise.reject(new Error("denied")) },
    });
    const { input } = await renderReady(api);
    fireEvent.change(input, { target: { value: "failure" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Open full file" }));
    const dialog = screen.getByRole("dialog", { name: "failure.md" });
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "The requested file no longer exists.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy path" }));
    expect(await within(dialog).findByText("The relative path could not be copied.")).toBeTruthy();
  });

  test("shows a display-safe status failure while retaining an operable search field", async () => {
    const api = new FakeApi();
    api.statusError = new Error("Status is temporarily unavailable.");
    render(<App api={api} debounceMs={1} />);
    expect(await screen.findByText("Status is temporarily unavailable.")).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search the knowledge base" })).toBeTruthy();
  });
});
