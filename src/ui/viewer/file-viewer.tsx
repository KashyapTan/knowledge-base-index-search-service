import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { FileMetadataResponse, OpenFileChange } from "../../server/index.ts";
import type { KbissApi } from "../api.ts";
import {
  previewAllowed,
  rendererForFormat,
  type ViewerMode,
  type ViewerSelection,
} from "./contracts.ts";
import {
  GrepCoordinator,
  type GrepOptions,
  type GrepResult,
  matchIndexNearestLine,
  wrappedMatchIndex,
} from "./grep.ts";
import { browserGrepExecutor } from "./grep-executor.ts";

const LazyMarkdownPreview = lazy(async () => {
  const module = await import("./markdown-renderer.tsx");
  return { default: module.MarkdownPreview };
});
const LazyHtmlPreview = lazy(async () => {
  const module = await import("./html-renderer.tsx");
  return { default: module.HtmlPreview };
});
const LazySourceRenderer = lazy(async () => {
  const module = await import("./source-renderer.tsx");
  return { default: module.SourceRenderer };
});

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => !element.hasAttribute("hidden"));
}

interface LoadedFile {
  readonly metadata: FileMetadataResponse;
  readonly content: string;
}

export function changedFileNotice(
  fileId: string,
  changes: readonly OpenFileChange[],
): "changed" | "deleted" | undefined {
  return changes.findLast((change) => change.fileId === fileId)?.kind;
}

export function FileViewer({
  selection,
  api,
  fileChanges,
  onClose,
}: {
  readonly selection: ViewerSelection;
  readonly api: KbissApi;
  readonly fileChanges: readonly OpenFileChange[];
  onClose(): void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  const coordinator = useMemo(() => new GrepCoordinator(browserGrepExecutor), []);
  const [loaded, setLoaded] = useState<LoadedFile>();
  const [loadError, setLoadError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState<"changed" | "deleted">();
  const [copyMessage, setCopyMessage] = useState<string>();
  const renderer = rendererForFormat(loaded?.metadata.format ?? selection.format);
  const [mode, setMode] = useState<ViewerMode>(renderer.supportsPreview ? "preview" : "source");
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [grep, setGrep] = useState<GrepResult>({ matches: [], limited: false });
  const [activeMatch, setActiveMatch] = useState(-1);
  const [grepBusy, setGrepBusy] = useState(false);
  const grepOptions: GrepOptions = useMemo(
    () => ({ query, regex, caseSensitive }),
    [query, regex, caseSensitive],
  );
  const canPreview = loaded
    ? previewAllowed(loaded.metadata.format, loaded.content.length)
    : renderer.supportsPreview;

  useEffect(() => {
    void selection.fileId;
    const nextRenderer = rendererForFormat(selection.format);
    setMode(nextRenderer.supportsPreview ? "preview" : "source");
    setQuery("");
    setRegex(false);
    setCaseSensitive(false);
    setNotice(undefined);
    setCopyMessage(undefined);
  }, [selection.fileId, selection.format]);

  useEffect(() => {
    if (loaded && !previewAllowed(loaded.metadata.format, loaded.content.length)) setMode("source");
  }, [loaded]);

  useEffect(() => {
    priorFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previousOverflow;
      priorFocus.current?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = focusableElements(dialog.current);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const change = changedFileNotice(selection.fileId, fileChanges);
    if (change) setNotice(change);
  }, [fileChanges, selection.fileId]);

  useEffect(() => {
    void reload;
    const controller = new AbortController();
    setLoadError(undefined);
    void Promise.all([
      api.getFileMetadata(selection.fileId, controller.signal),
      api.getFileContent(selection.fileId, controller.signal),
    ])
      .then(([metadata, content]) => {
        setLoaded({ metadata, content });
        setMode(previewAllowed(metadata.format, content.length) ? "preview" : "source");
        setNotice(undefined);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoadError(error instanceof Error ? error.message : "The file could not be loaded.");
        }
      });
    return () => controller.abort();
  }, [api, reload, selection.fileId]);

  useEffect(() => {
    if (!loaded || !query) {
      coordinator.cancel();
      setGrep({ matches: [], limited: false });
      setActiveMatch(-1);
      setGrepBusy(false);
      return;
    }
    let active = true;
    setGrepBusy(true);
    void coordinator.search(loaded.content, grepOptions).then((result) => {
      if (!active || !result) return;
      setGrep(result);
      setActiveMatch(
        result.error
          ? -1
          : selection.line
            ? matchIndexNearestLine(result.matches, selection.line)
            : result.matches.length > 0
              ? 0
              : -1,
      );
      setGrepBusy(false);
    });
    return () => {
      active = false;
      coordinator.cancel();
    };
  }, [coordinator, grepOptions, loaded, query, selection.line]);

  const navigate = (delta: -1 | 1): void => {
    const next = wrappedMatchIndex(activeMatch, grep.matches.length, delta);
    setActiveMatch(next);
    if (renderer.supportsPreview) setMode("source");
  };
  const copyPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(selection.relativePath);
      setCopyMessage("Relative path copied.");
    } catch {
      setCopyMessage("The relative path could not be copied.");
    }
  };

  const currentLine = activeMatch >= 0 ? grep.matches[activeMatch]?.line : selection.line;
  return (
    <div className="viewer-backdrop" role="presentation">
      <div
        ref={dialog}
        className="file-viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="viewer-title"
      >
        <header className="viewer-header">
          <div className="viewer-title-group">
            <p className="viewer-kicker">Full-file viewer</p>
            <h2 id="viewer-title">{loaded?.metadata.filename ?? selection.filename}</h2>
            <p className="viewer-path" title={selection.relativePath}>
              {selection.relativePath}
            </p>
            <p className="viewer-meta">
              {loaded?.metadata.format ?? selection.format}
              {loaded ? ` · ${humanSize(loaded.metadata.size)}` : ""}
              {currentLine ? ` · line ${currentLine}` : ""}
              {` · ${mode === "preview" ? renderer.label : "Source"}`}
            </p>
            {copyMessage ? (
              <p className="copy-message" role="status">
                {copyMessage}
              </p>
            ) : null}
          </div>
          <div className="viewer-header-actions">
            <button type="button" className="quiet-button" onClick={() => void copyPath()}>
              Copy path
            </button>
            <button ref={closeButton} type="button" className="viewer-close" onClick={onClose}>
              Close viewer
            </button>
          </div>
        </header>

        {notice ? (
          <div className={`file-change-notice ${notice}`} role="status">
            <p>
              {notice === "deleted"
                ? "This file was removed while it was open. The loaded copy is unchanged."
                : "This file changed while it was open. Search positions still refer to the loaded copy."}
            </p>
            {notice === "changed" ? (
              <button
                type="button"
                className="quiet-button"
                onClick={() => setReload((value) => value + 1)}
              >
                Refresh file
              </button>
            ) : null}
          </div>
        ) : null}
        {loadError && loaded ? (
          <div className="refresh-error" role="alert">
            Refresh failed; the previously loaded copy is still shown. {loadError}
          </div>
        ) : null}

        <div className="viewer-toolbar">
          <fieldset className="renderer-switch">
            <legend className="sr-only">Renderer mode</legend>
            {canPreview ? (
              <button
                type="button"
                aria-pressed={mode === "preview"}
                onClick={() => setMode("preview")}
              >
                Preview
              </button>
            ) : null}
            {renderer.supportsPreview && !canPreview ? (
              <span className="preview-disabled">Preview disabled for this large file</span>
            ) : null}
            <button
              type="button"
              aria-pressed={mode === "source"}
              onClick={() => setMode("source")}
            >
              Source
            </button>
          </fieldset>
          {/* biome-ignore lint/a11y/useSemanticElements: Happy DOM does not recognize the search element used by browser tests. */}
          <div className="grep-controls" role="search" aria-label="Search within file">
            <label>
              <span className="sr-only">Find in file</span>
              <input
                type="search"
                value={query}
                placeholder="Find in file"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    navigate(event.shiftKey ? -1 : 1);
                  }
                }}
              />
            </label>
            <button
              type="button"
              aria-pressed={regex}
              title="Regular expression"
              onClick={() => setRegex((value) => !value)}
            >
              .*
            </button>
            <button
              type="button"
              aria-pressed={caseSensitive}
              title="Case sensitive"
              onClick={() => setCaseSensitive((value) => !value)}
            >
              Aa
            </button>
            <span className="grep-count" role="status">
              {grepBusy
                ? "Searching…"
                : grep.error
                  ? grep.error
                  : grep.matches.length === 0
                    ? "0 matches"
                    : `${activeMatch + 1} of ${grep.matches.length}${grep.limited ? "+" : ""}`}
            </span>
            <button
              type="button"
              aria-label="Previous match"
              disabled={grep.matches.length === 0}
              onClick={() => navigate(-1)}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label="Next match"
              disabled={grep.matches.length === 0}
              onClick={() => navigate(1)}
            >
              ↓
            </button>
          </div>
        </div>

        <main className="viewer-content" aria-busy={!loaded && !loadError}>
          {loadError && !loaded ? (
            <div className="viewer-error" role="alert">
              <h3>File unavailable</h3>
              <p>{loadError}</p>
            </div>
          ) : !loaded ? (
            <p className="viewer-loading" role="status">
              Loading the complete file…
            </p>
          ) : (
            <Suspense
              fallback={
                <p className="viewer-loading" role="status">
                  Loading renderer…
                </p>
              }
            >
              {mode === "preview" && renderer.kind === "markdown" ? (
                <LazyMarkdownPreview
                  content={loaded.content}
                  grep={grepOptions}
                  {...(selection.line ? { targetLine: selection.line } : {})}
                />
              ) : mode === "preview" && renderer.kind === "html" ? (
                <LazyHtmlPreview content={loaded.content} />
              ) : (
                <LazySourceRenderer
                  content={loaded.content}
                  matches={grep.matches}
                  activeMatch={activeMatch}
                  {...(renderer.language ? { language: renderer.language } : {})}
                  {...(selection.line ? { targetLine: selection.line } : {})}
                />
              )}
            </Suspense>
          )}
        </main>
      </div>
    </div>
  );
}
