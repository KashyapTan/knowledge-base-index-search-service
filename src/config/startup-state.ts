import { err, ok, type Result } from "../shared/result.ts";
import type { StartupEvent, StartupState, StartupTransitionError } from "./contracts.ts";

const expectedEvents: Partial<Record<StartupState["phase"], StartupEvent["type"]>> = {
  starting: "begin_validation",
  validating: "configuration_validated",
  loading_model: "model_loaded",
  scanning: "scan_completed",
  indexing: "index_committed",
  degraded: "continue_degraded",
};

export function initialStartupState(now = Date.now()): StartupState {
  return { phase: "starting", changedAt: now, issues: [] };
}

export function transitionStartupState(
  current: StartupState,
  event: StartupEvent,
  now = Date.now(),
): Result<StartupState, StartupTransitionError> {
  if (event.type === "fatal_error" && current.phase !== "error") {
    return ok({ phase: "error", changedAt: now, issues: current.issues, error: event.error });
  }

  if (event.type === "file_error") {
    if (current.phase === "scanning" || current.phase === "indexing" || current.phase === "ready") {
      return ok({
        phase: "degraded",
        changedAt: now,
        issues: [...current.issues, event.issue],
        resumePhase: current.phase,
      });
    }
  } else if (current.phase === "degraded" && event.type === "continue_degraded") {
    return ok({
      phase: current.resumePhase,
      changedAt: now,
      issues: current.issues,
    });
  } else if (expectedEvents[current.phase] === event.type) {
    switch (event.type) {
      case "begin_validation":
        return ok({ phase: "validating", changedAt: now, issues: current.issues });
      case "configuration_validated":
        return ok({ phase: "loading_model", changedAt: now, issues: current.issues });
      case "model_loaded":
        return ok({ phase: "scanning", changedAt: now, issues: current.issues });
      case "scan_completed":
        return ok({ phase: "indexing", changedAt: now, issues: current.issues });
      case "index_committed":
        return ok({ phase: "ready", changedAt: now, issues: current.issues });
      default:
        break;
    }
  }

  return err({
    code: "INVALID_STARTUP_TRANSITION",
    message: `Cannot apply ${event.type} while startup is ${current.phase}.`,
    details: { event: event.type, phase: current.phase },
  });
}

type StartupListener = (state: StartupState) => void;

export class StartupStateStore {
  readonly #listeners = new Set<StartupListener>();
  #state: StartupState;

  constructor(initial = initialStartupState()) {
    this.#state = initial;
  }

  getSnapshot(): StartupState {
    return this.#state;
  }

  dispatch(event: StartupEvent, now = Date.now()): Result<StartupState, StartupTransitionError> {
    const transition = transitionStartupState(this.#state, event, now);
    if (!transition.ok) return transition;
    this.#state = transition.value;
    for (const listener of this.#listeners) listener(this.#state);
    return transition;
  }

  subscribe(listener: StartupListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
