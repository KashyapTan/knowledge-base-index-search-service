import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ApplicationEventData, ApplicationStatus } from "../server/index.ts";
import "./styles.css";

const API_PREFIX = "/api/v1";

function applyEvent(
  current: ApplicationStatus | undefined,
  event: ApplicationEventData,
): ApplicationStatus | undefined {
  if (event.type === "snapshot") return event.status;
  if (!current) return current;
  if (event.type === "startup") return { ...current, startup: event.startup };
  if (event.type === "discovery") return { ...current, discovery: event.progress };
  if (event.type === "indexing") return { ...current, indexing: event.progress };
  return current;
}

function LifecycleApp() {
  const [status, setStatus] = useState<ApplicationStatus>();
  const [connectionError, setConnectionError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${API_PREFIX}/status`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Status is temporarily unavailable.");
        setStatus((await response.json()) as ApplicationStatus);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setConnectionError(
            error instanceof Error ? error.message : "Status could not be loaded.",
          );
        }
      });

    const events = new EventSource(`${API_PREFIX}/events`);
    const receive = (raw: Event): void => {
      if (!(raw instanceof MessageEvent) || typeof raw.data !== "string") return;
      try {
        const event = JSON.parse(raw.data) as ApplicationEventData;
        setStatus((current) => applyEvent(current, event));
        setConnectionError(undefined);
      } catch {
        setConnectionError("A progress update could not be read.");
      }
    };
    for (const type of ["snapshot", "startup", "discovery", "indexing", "issue"]) {
      events.addEventListener(type, receive);
    }
    events.onerror = () => setConnectionError("Reconnecting to local progress updates…");
    return () => {
      controller.abort();
      events.close();
    };
  }, []);

  const fatal = status?.startup.phase === "error" ? status.startup.error : undefined;
  const phase = status?.startup.phase ?? "starting";
  const indexing = status?.indexing;
  return (
    <main>
      <p className="eyebrow">Local · private · offline</p>
      <h1>Knowledge Base Index Search Service</h1>
      <section className={fatal ? "status status-error" : "status"} aria-live="polite">
        <p className="status-label">
          {fatal ? "Startup needs attention" : "Preparing local search"}
        </p>
        <h2>{fatal ? fatal.message : phase.replaceAll("_", " ")}</h2>
        {indexing ? (
          <p>
            {indexing.processedFiles} of {indexing.totalFiles} files processed ·{" "}
            {indexing.committedChunks} chunks committed
          </p>
        ) : (
          <p>The page is ready while local model and index services start in the background.</p>
        )}
        {status?.startup.issues.length ? (
          <p>{status.startup.issues.length} file issue(s) were isolated; indexing can continue.</p>
        ) : null}
        {connectionError ? <p className="connection-error">{connectionError}</p> : null}
      </section>
      <p className="handoff">
        Search controls arrive in the next implementation phase. This page can stay open to observe
        startup and indexing progress.
      </p>
    </main>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("The UI root element is missing.");

createRoot(rootElement).render(
  <StrictMode>
    <LifecycleApp />
  </StrictMode>,
);
