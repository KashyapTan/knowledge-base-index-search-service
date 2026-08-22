import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchExcerpt, SearchFileResult } from "../search/index.ts";
import type { KbissApi } from "./api.ts";
import { browserApi } from "./api.ts";
import { ResultCard } from "./result-card.tsx";
import { collectIssues, presentStatus, resultsMayBeIncomplete } from "./status.ts";
import {
  DEFAULT_FILE_COUNT,
  readUrlState,
  selectedFileUrl,
  withoutSelectedFile,
} from "./url-state.ts";
import { useApplicationStatus } from "./use-application-status.ts";
import { useSearch } from "./use-search.ts";
import type { ViewerSelection } from "./viewer/contracts.ts";
import { FileViewer } from "./viewer/file-viewer.tsx";

function selectionFromUrl(results: readonly SearchFileResult[]): ViewerSelection | undefined {
  const url = readUrlState(new URL(window.location.href));
  if (!url.selectedFileId) return undefined;
  const result = results.find((candidate) => candidate.fileId === url.selectedFileId);
  return {
    fileId: url.selectedFileId,
    filename: result?.filename ?? "Selected file",
    relativePath: result?.relativePath ?? "Loading file details…",
    format: result?.format ?? "text",
    ...(url.selectedLine ? { line: url.selectedLine } : {}),
  };
}

function StatusPanel({
  statusState,
}: {
  readonly statusState: ReturnType<typeof useApplicationStatus>;
}) {
  const { status, connectionMessage } = statusState;
  const presentation = presentStatus(status);
  const issues = collectIssues(status);
  const progress = status?.indexing;
  const progressMaximum = Math.max(progress?.totalFiles ?? 0, 1);
  return (
    <section
      className={`status-panel tone-${presentation.tone}`}
      aria-live="polite"
      aria-atomic="true"
      role={presentation.tone === "error" ? "alert" : "status"}
    >
      <div className="status-copy">
        <span className="status-dot" aria-hidden="true" />
        <div>
          <h2>{presentation.label}</h2>
          <p>{presentation.detail}</p>
        </div>
      </div>
      {progress && progress.phase !== "complete" ? (
        <div className="progress-copy">
          <progress value={progress.processedFiles} max={progressMaximum}>
            {progress.processedFiles} of {progress.totalFiles}
          </progress>
          <div className="progress-details">
            <span>
              {progress.processedFiles} of {progress.totalFiles} files · {progress.committedChunks}{" "}
              chunks committed
            </span>
            {progress.currentFile ? (
              <span className="current-file">
                Current file: <code title={progress.currentFile}>{progress.currentFile}</code>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {connectionMessage ? <p className="connection-message">{connectionMessage}</p> : null}
      {issues.length > 0 ? (
        <details className="diagnostics">
          <summary>
            {issues.length} isolated {issues.length === 1 ? "issue" : "issues"}
          </summary>
          <ul>
            {issues.map((issue) => (
              <li key={issue.key}>
                {issue.relativePath ? <span>{issue.relativePath}: </span> : null}
                {issue.message} <code>{issue.code}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

const RESULT_COUNTS = [5, DEFAULT_FILE_COUNT, 20, 30, 50] as const;

export function App({
  api = browserApi,
  debounceMs,
}: {
  readonly api?: KbissApi;
  debounceMs?: number;
}) {
  const statusState = useApplicationStatus(api);
  const status = statusState.status;
  const search = useSearch({
    api,
    enabled: status?.searchAvailable === true,
    ...(debounceMs === undefined ? {} : { debounceMs }),
  });
  const searchInput = useRef<HTMLInputElement>(null);
  const results = search.response?.results ?? [];
  const [selection, setSelection] = useState<ViewerSelection | undefined>(() =>
    selectionFromUrl([]),
  );
  const counts = useMemo(
    () => [...new Set([...RESULT_COUNTS, search.fileCount])].sort((left, right) => left - right),
    [search.fileCount],
  );

  useEffect(() => searchInput.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      if (selection) return;
      const target = event.target;
      const isEditing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      if (event.key === "/" && !isEditing) {
        event.preventDefault();
        searchInput.current?.focus();
      } else if (event.key.toLocaleLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [selection]);
  useEffect(() => {
    const onPopState = (): void => setSelection(selectionFromUrl(results));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [results]);
  useEffect(() => {
    if (selection?.relativePath !== "Loading file details…") return;
    const result = results.find((candidate) => candidate.fileId === selection.fileId);
    if (result) {
      setSelection((current) =>
        current
          ? {
              ...current,
              filename: result.filename,
              relativePath: result.relativePath,
              format: result.format,
            }
          : current,
      );
      return;
    }
    const controller = new AbortController();
    void api
      .getFileMetadata(selection.fileId, controller.signal)
      .then((metadata) =>
        setSelection((current) =>
          current?.fileId === metadata.fileId
            ? {
                ...current,
                filename: metadata.filename,
                relativePath: metadata.relativePath,
                format: metadata.format,
              }
            : current,
        ),
      )
      .catch(() => {
        if (!controller.signal.aborted) {
          setSelection((current) =>
            current ? { ...current, relativePath: "File details are unavailable." } : current,
          );
        }
      });
    return () => controller.abort();
  }, [api, results, selection]);

  const openFile = (result: SearchFileResult, excerpt?: SearchExcerpt): void => {
    const line = excerpt?.startLine;
    const next = selectedFileUrl(new URL(window.location.href), result.fileId, line);
    window.history.pushState({ ...window.history.state, kbissViewer: true }, "", next);
    setSelection({
      fileId: result.fileId,
      filename: result.filename,
      relativePath: result.relativePath,
      format: result.format,
      ...(line === undefined ? {} : { line }),
    });
  };
  const closeFile = (): void => {
    const next = withoutSelectedFile(new URL(window.location.href));
    window.history.replaceState(window.history.state, "", next);
    setSelection(undefined);
  };
  const focusResult = (index: number): void => {
    document.querySelector<HTMLElement>(`[data-result-index="${index}"]`)?.focus();
  };
  const onResultsKeyDown = (event: React.KeyboardEvent<HTMLOListElement>): void => {
    const active = (event.target as HTMLElement).closest<HTMLElement>("[data-result-index]");
    if (!active) return;
    const index = Number(active.dataset.resultIndex);
    let next: number | undefined;
    if (event.key === "ArrowDown") next = Math.min(results.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = results.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      focusResult(next);
    }
  };

  const partial = resultsMayBeIncomplete(status);
  const hasPreviousResults = results.length > 0;
  return (
    <div className="app-shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">Local · private · offline</p>
          <h1>KBISS</h1>
          <p className="product-description">
            Find the right artifact without sending it anywhere.
          </p>
        </div>
        <p className="source-root" title={status?.sourceRootLabel ?? "Connecting"}>
          <span>Source</span>
          {status?.sourceRootLabel ?? "Connecting…"}
        </p>
      </header>

      <StatusPanel statusState={statusState} />

      <main>
        {/* biome-ignore lint/a11y/useSemanticElements: React test DOMs do not consistently recognize the newer search element. */}
        <form
          className="search-form"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            search.submitNow();
          }}
        >
          <label className="search-label" htmlFor="knowledge-search">
            Search the knowledge base
          </label>
          <div className="search-row">
            <div className="search-input-wrap">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" />
              </svg>
              <input
                ref={searchInput}
                id="knowledge-search"
                type="search"
                value={search.draft}
                maxLength={4096}
                autoComplete="off"
                spellCheck={false}
                placeholder="Try a filename, error message, path, or concept"
                aria-describedby="search-help"
                onChange={(event) => search.setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    search.submitNow();
                  } else if (event.key === "ArrowDown" && results.length > 0) {
                    event.preventDefault();
                    focusResult(0);
                  }
                }}
              />
              <kbd>⌘ K</kbd>
            </div>
            <button
              className="search-button"
              type="submit"
              disabled={!status?.searchAvailable || search.draft.trim().length === 0}
            >
              Search
            </button>
          </div>
          <div className="search-options">
            <p id="search-help">
              Exact punctuation is preserved. Press <kbd>/</kbd> anywhere to refocus.
            </p>
            <label htmlFor="result-count">
              Show
              <select
                id="result-count"
                value={search.fileCount}
                onChange={(event) => search.setFileCount(Number(event.target.value))}
              >
                {counts.map((count) => (
                  <option key={count} value={count}>
                    {count} files
                  </option>
                ))}
              </select>
            </label>
          </div>
        </form>

        {partial ? (
          <p className="partial-notice" role="status">
            Results may be incomplete while the local index is updating.
          </p>
        ) : null}

        <section
          className="results-region"
          aria-labelledby="results-heading"
          aria-busy={search.phase === "loading"}
        >
          <div className="results-heading-row">
            <div>
              <p className="section-kicker">Distinct files</p>
              <h2 id="results-heading">
                {search.response
                  ? `${results.length} ${results.length === 1 ? "result" : "results"}`
                  : "Search results"}
              </h2>
            </div>
            {search.response ? (
              <span>{Math.round(search.response.timing.totalMs)} ms locally</span>
            ) : null}
          </div>

          {search.phase === "loading" ? (
            <p className="search-state" role="status">
              {hasPreviousResults ? "Refreshing results…" : "Searching the local index…"}
            </p>
          ) : null}
          {search.phase === "error" ? (
            <div className="search-error" role="alert">
              <h3>Search could not be completed</h3>
              <p>{search.error}</p>
              <button type="button" className="quiet-button" onClick={search.submitNow}>
                Try again
              </button>
            </div>
          ) : null}
          {search.phase === "idle" ? (
            <div className="empty-state">
              <span aria-hidden="true">⌕</span>
              <h3>Search by what you remember</h3>
              <p>
                Identifiers, paths, filenames, quoted phrases, and natural-language questions all
                work.
              </p>
            </div>
          ) : null}
          {search.phase === "success" && results.length === 0 ? (
            <div className="empty-state">
              <span aria-hidden="true">0</span>
              <h3>No matching files</h3>
              <p>Try a shorter phrase, a filename fragment, or different punctuation.</p>
            </div>
          ) : null}
          {hasPreviousResults ? (
            <ol className="result-list" onKeyDown={onResultsKeyDown}>
              {results.map((result, index) => (
                <li key={result.fileId}>
                  <ResultCard result={result} index={index} onOpen={openFile} />
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      </main>

      {selection ? (
        <FileViewer
          key={selection.fileId}
          selection={selection}
          api={api}
          fileChanges={statusState.fileChanges}
          onClose={closeFile}
        />
      ) : null}
      <footer className="privacy-footer">
        Searches stay on this machine. Submitted query and result-count state are reflected in the
        localhost URL for sharing and refresh.
      </footer>
    </div>
  );
}
