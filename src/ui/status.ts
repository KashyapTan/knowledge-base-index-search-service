import type { StartupIssue } from "../config/index.ts";
import type { IndexingFileError } from "../indexing/index.ts";
import type { ApplicationEventData, ApplicationStatus } from "../server/index.ts";

export function applyApplicationEvent(
  current: ApplicationStatus | undefined,
  event: ApplicationEventData,
): ApplicationStatus | undefined {
  if (event.type === "snapshot") return event.status;
  if (!current) return current;
  if (event.type === "startup") return { ...current, startup: event.startup };
  if (event.type === "discovery") return { ...current, discovery: event.progress };
  if (event.type === "indexing") return { ...current, indexing: event.progress };
  const exists = current.startup.issues.some(
    (issue) => issue.code === event.issue.code && issue.fileId === event.issue.fileId,
  );
  return exists
    ? current
    : {
        ...current,
        startup: { ...current.startup, issues: [...current.startup.issues, event.issue] },
      };
}

export interface StatusPresentation {
  readonly label: string;
  readonly detail: string;
  readonly tone: "neutral" | "working" | "ready" | "warning" | "error";
}

function indexingIsActive(status: ApplicationStatus): boolean {
  return (
    status.indexing !== undefined &&
    status.indexing.phase !== "complete" &&
    status.indexing.phase !== "cancelled"
  );
}

export function resultsMayBeIncomplete(status: ApplicationStatus | undefined): boolean {
  if (!status?.searchAvailable) return false;
  if (indexingIsActive(status)) return true;
  if (status.startup.phase === "degraded") return status.startup.resumePhase !== "ready";
  return status.startup.phase !== "ready" && status.startup.phase !== "error";
}

export function presentStatus(status: ApplicationStatus | undefined): StatusPresentation {
  if (!status) {
    return {
      label: "Connecting to local search",
      detail: "Reading startup and indexing state…",
      tone: "neutral",
    };
  }
  if (status.shuttingDown) {
    return {
      label: "Local search is shutting down",
      detail: "New searches are no longer being accepted.",
      tone: "warning",
    };
  }
  if (status.startup.phase === "error") {
    return { label: "Search needs attention", detail: status.startup.error.message, tone: "error" };
  }
  if (status.startup.phase === "degraded") {
    return {
      label: "Search is available with isolated issues",
      detail: "Files that indexed successfully remain searchable.",
      tone: "warning",
    };
  }
  if (indexingIsActive(status)) {
    return {
      label:
        status.startup.phase === "ready" ? "Updating the local index" : "Building the local index",
      detail: "Committed content is searchable while this update continues.",
      tone: "working",
    };
  }
  switch (status.startup.phase) {
    case "starting":
    case "validating":
      return {
        label: "Starting local search",
        detail: "Validating the private local configuration…",
        tone: "neutral",
      };
    case "loading_model":
      return {
        label: "Loading the search model",
        detail: "The local embedding model is warming up.",
        tone: "working",
      };
    case "scanning":
      return {
        label: "Scanning source files",
        detail: "Search becomes available as committed content is loaded.",
        tone: "working",
      };
    case "indexing":
      return {
        label: "Building the local index",
        detail: "Committed content is searchable while indexing continues.",
        tone: "working",
      };
    case "ready":
      return {
        label: "Search is ready",
        detail: "Results reflect the latest completed local index.",
        tone: "ready",
      };
  }
}

export interface DisplayIssue {
  readonly key: string;
  readonly code: string;
  readonly message: string;
  readonly relativePath?: string;
}

export function collectIssues(status: ApplicationStatus | undefined): readonly DisplayIssue[] {
  if (!status) return [];
  const found = new Map<string, DisplayIssue>();
  const addStartup = (issue: StartupIssue): void => {
    const key = `${issue.code}:${issue.fileId ?? ""}:${issue.message}`;
    found.set(key, {
      key,
      code: issue.code,
      message: issue.message,
      ...(issue.fileId ? { relativePath: `File ${issue.fileId.slice(0, 8)}…` } : {}),
    });
  };
  const addIndexing = (issue: IndexingFileError): void => {
    const key = `${issue.code}:${issue.fileId}:${issue.message}`;
    found.set(key, {
      key,
      code: issue.code,
      message: issue.message,
      relativePath: issue.relativePath,
    });
  };
  for (const issue of status.startup.issues) addStartup(issue);
  for (const issue of status.indexing?.errors ?? []) addIndexing(issue);
  return [...found.values()];
}
