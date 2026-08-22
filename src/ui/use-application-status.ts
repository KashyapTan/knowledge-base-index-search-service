import { useEffect, useState } from "react";
import type { ApplicationStatus, OpenFileChange } from "../server/index.ts";
import type { KbissApi } from "./api.ts";
import { applyApplicationEvent } from "./status.ts";

export interface ApplicationStatusState {
  readonly status?: ApplicationStatus;
  readonly connectionMessage?: string;
  readonly fileChanges: readonly OpenFileChange[];
}

function withoutConnectionMessage(state: ApplicationStatusState): ApplicationStatusState {
  const { connectionMessage: _connectionMessage, ...connected } = state;
  return connected;
}

export function useApplicationStatus(api: KbissApi): ApplicationStatusState {
  const [state, setState] = useState<ApplicationStatusState>({ fileChanges: [] });

  useEffect(() => {
    const controller = new AbortController();
    void api
      .getStatus(controller.signal)
      .then((status) => setState((current) => (current.status ? current : { ...current, status })))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          fileChanges: [],
          connectionMessage: error instanceof Error ? error.message : "Status could not be loaded.",
        });
      });
    const events = api.subscribe(
      (event) =>
        setState((current) => {
          if (event.type === "files") {
            return { ...withoutConnectionMessage(current), fileChanges: event.changes };
          }
          const status = applyApplicationEvent(current.status, event);
          return status ? { ...withoutConnectionMessage(current), status } : current;
        }),
      (connectionMessage) => setState((current) => ({ ...current, connectionMessage })),
      () => setState(withoutConnectionMessage),
    );
    return () => {
      controller.abort();
      events.close();
    };
  }, [api]);

  return state;
}
