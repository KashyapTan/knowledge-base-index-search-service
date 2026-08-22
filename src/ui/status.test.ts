import { describe, expect, test } from "bun:test";
import type { ApplicationStatus } from "../server/index.ts";
import {
  applyApplicationEvent,
  collectIssues,
  presentStatus,
  resultsMayBeIncomplete,
} from "./status.ts";

function status(overrides: Partial<ApplicationStatus> = {}): ApplicationStatus {
  return {
    sourceRootLabel: "artifacts",
    startup: { phase: "ready", changedAt: 1, issues: [] },
    searchAvailable: true,
    actionInProgress: false,
    shuttingDown: false,
    csrfToken: "fixture",
    ...overrides,
  };
}

describe("UI application status", () => {
  test("applies snapshots and each progress event without fabricating initial state", () => {
    const ready = status();
    expect(
      applyApplicationEvent(undefined, { type: "startup", startup: ready.startup }),
    ).toBeUndefined();
    expect(applyApplicationEvent(undefined, { type: "snapshot", status: ready })).toBe(ready);
    expect(
      applyApplicationEvent(ready, {
        type: "files",
        changes: [{ fileId: "a".repeat(64), kind: "changed" }],
      }),
    ).toBe(ready);

    const loading = { phase: "loading_model", changedAt: 2, issues: [] } as const;
    expect(applyApplicationEvent(ready, { type: "startup", startup: loading })?.startup).toBe(
      loading,
    );
    const discovery = {
      phase: "scanning",
      discovered: 2,
      unchanged: 1,
      pending: 1,
      failed: 0,
      removed: 0,
    } as const;
    expect(
      applyApplicationEvent(ready, { type: "discovery", progress: discovery })?.discovery,
    ).toBe(discovery);
    const indexing = {
      phase: "embedding",
      totalFiles: 2,
      processedFiles: 1,
      unchangedFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      deletedFiles: 0,
      totalChunks: 4,
      embeddedChunks: 2,
      reusedChunks: 0,
      committedChunks: 2,
      batchesCompleted: 1,
      errors: [],
    } as const;
    expect(applyApplicationEvent(ready, { type: "indexing", progress: indexing })?.indexing).toBe(
      indexing,
    );
  });

  test("deduplicates issue events and combines display-safe indexing diagnostics", () => {
    const base = status({
      startup: {
        phase: "ready",
        changedAt: 1,
        issues: [{ code: "READ_FAILED", message: "Could not read file.", fileId: "a".repeat(64) }],
      },
      indexing: {
        phase: "complete",
        totalFiles: 1,
        processedFiles: 1,
        unchangedFiles: 0,
        skippedFiles: 0,
        failedFiles: 1,
        deletedFiles: 0,
        totalChunks: 0,
        embeddedChunks: 0,
        reusedChunks: 0,
        committedChunks: 0,
        batchesCompleted: 0,
        errors: [
          {
            fileId: "b".repeat(64),
            relativePath: "guides/broken.md",
            code: "EXTRACT_FAILED",
            message: "Extraction failed.",
          },
        ],
      },
    });
    const existingIssue = base.startup.issues[0];
    if (!existingIssue) throw new Error("Expected fixture issue.");
    const duplicate = applyApplicationEvent(base, {
      type: "issue",
      issue: existingIssue,
    });
    expect(duplicate?.startup.issues).toHaveLength(1);
    const added = applyApplicationEvent(base, {
      type: "issue",
      issue: { code: "WATCH_FAILED", message: "Watcher stopped." },
    });
    expect(added?.startup.issues).toHaveLength(2);
    expect(collectIssues(base)).toEqual([
      expect.objectContaining({ relativePath: "File aaaaaaaa…", code: "READ_FAILED" }),
      expect.objectContaining({ relativePath: "guides/broken.md", code: "EXTRACT_FAILED" }),
    ]);
  });

  test("distinguishes startup, ready, partial, degraded, fatal, and shutdown states", () => {
    expect(presentStatus(undefined).label).toBe("Connecting to local search");
    for (const phase of ["starting", "validating"] as const) {
      expect(presentStatus(status({ startup: { phase, changedAt: 1, issues: [] } })).label).toBe(
        "Starting local search",
      );
    }
    expect(
      presentStatus(status({ startup: { phase: "loading_model", changedAt: 1, issues: [] } }))
        .label,
    ).toBe("Loading the search model");
    expect(
      presentStatus(status({ startup: { phase: "scanning", changedAt: 1, issues: [] } })).label,
    ).toBe("Scanning source files");
    expect(
      presentStatus(status({ startup: { phase: "indexing", changedAt: 1, issues: [] } })).label,
    ).toBe("Building the local index");
    expect(presentStatus(status()).tone).toBe("ready");
    expect(presentStatus(status({ shuttingDown: true })).tone).toBe("warning");
    expect(
      presentStatus(
        status({
          startup: { phase: "degraded", resumePhase: "ready", changedAt: 1, issues: [] },
        }),
      ).tone,
    ).toBe("warning");
    expect(
      presentStatus(
        status({
          startup: {
            phase: "error",
            changedAt: 1,
            issues: [],
            error: { code: "MODEL", message: "Model unavailable." },
          },
        }),
      ),
    ).toMatchObject({ tone: "error", detail: "Model unavailable." });

    const active = status({
      indexing: {
        phase: "committing",
        totalFiles: 1,
        processedFiles: 0,
        unchangedFiles: 0,
        skippedFiles: 0,
        failedFiles: 0,
        deletedFiles: 0,
        totalChunks: 1,
        embeddedChunks: 1,
        reusedChunks: 0,
        committedChunks: 0,
        batchesCompleted: 1,
        errors: [],
      },
    });
    expect(presentStatus(active).label).toBe("Updating the local index");
    expect(resultsMayBeIncomplete(active)).toBe(true);
    expect(resultsMayBeIncomplete(status())).toBe(false);
    expect(resultsMayBeIncomplete(status({ searchAvailable: false }))).toBe(false);
    expect(
      resultsMayBeIncomplete(
        status({
          startup: { phase: "degraded", resumePhase: "indexing", changedAt: 1, issues: [] },
        }),
      ),
    ).toBe(true);
  });
});
