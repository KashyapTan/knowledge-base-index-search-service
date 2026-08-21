import { describe, expect, test } from "bun:test";
import { initialStartupState, StartupStateStore, transitionStartupState } from "./startup-state.ts";

describe("startup state machine", () => {
  test("follows the successful startup sequence", () => {
    const store = new StartupStateStore(initialStartupState(0));
    const phases: string[] = [];
    store.subscribe((state) => phases.push(state.phase));
    for (const [index, type] of [
      "begin_validation",
      "configuration_validated",
      "model_loaded",
      "scan_completed",
      "index_committed",
    ].entries()) {
      const result = store.dispatch({ type } as never, index + 1);
      expect(result.ok).toBe(true);
    }
    expect(phases).toEqual(["validating", "loading_model", "scanning", "indexing", "ready"]);
    expect(store.getSnapshot()).toEqual({ phase: "ready", changedAt: 5, issues: [] });
  });

  test("keeps per-file failures recoverable and separate from fatal errors", () => {
    const store = new StartupStateStore({ phase: "scanning", changedAt: 1, issues: [] });
    const issue = { code: "FILE_UNREADABLE", message: "One file was skipped.", fileId: "file-1" };
    expect(store.dispatch({ type: "file_error", issue }, 2)).toEqual({
      ok: true,
      value: { phase: "degraded", changedAt: 2, issues: [issue], resumePhase: "scanning" },
    });
    expect(store.dispatch({ type: "continue_degraded" }, 3)).toEqual({
      ok: true,
      value: { phase: "scanning", changedAt: 3, issues: [issue] },
    });
    const fatal = { code: "CONFIG_FATAL", message: "Startup cannot continue." };
    expect(store.dispatch({ type: "fatal_error", error: fatal }, 4)).toEqual({
      ok: true,
      value: { phase: "error", changedAt: 4, issues: [issue], error: fatal },
    });
  });

  test("rejects out-of-order and unsupported recovery transitions", () => {
    const invalid = transitionStartupState(initialStartupState(0), { type: "model_loaded" }, 1);
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "INVALID_STARTUP_TRANSITION" },
    });
    const fromError = transitionStartupState(
      {
        phase: "error",
        changedAt: 1,
        issues: [],
        error: { code: "FATAL", message: "Stopped." },
      },
      { type: "continue_degraded" },
      2,
    );
    expect(fromError.ok).toBe(false);
    expect(
      transitionStartupState(
        {
          phase: "error",
          changedAt: 1,
          issues: [],
          error: { code: "FATAL", message: "Stopped." },
        },
        { type: "fatal_error", error: { code: "SECOND", message: "Still stopped." } },
        2,
      ).ok,
    ).toBe(false);
  });

  test("notifies current subscribers only after successful transitions", () => {
    const store = new StartupStateStore(initialStartupState(0));
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.dispatch({ type: "model_loaded" }, 1);
    expect(calls).toBe(0);
    store.dispatch({ type: "begin_validation" }, 2);
    expect(calls).toBe(1);
    unsubscribe();
    store.dispatch({ type: "configuration_validated" }, 3);
    expect(calls).toBe(1);
  });
});
