import { useEffect, useState } from "react";
import type { ApplicationStatus } from "../server/index.ts";
import type { KbissApi } from "./api.ts";
import { applyApplicationEvent } from "./status.ts";

export interface ApplicationStatusState {
  readonly status?: ApplicationStatus;
  readonly connectionMessage?: string;
}

export function useApplicationStatus(api: KbissApi): ApplicationStatusState {
  const [state, setState] = useState<ApplicationStatusState>({});

  useEffect(() => {
    const controller = new AbortController();
    void api
      .getStatus(controller.signal)
      .then((status) => setState((current) => (current.status ? current : { status })))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          connectionMessage: error instanceof Error ? error.message : "Status could not be loaded.",
        });
      });
    const events = api.subscribe(
      (event) =>
        setState((current) => {
          const status = applyApplicationEvent(current.status, event);
          return status ? { status } : current;
        }),
      (connectionMessage) => setState((current) => ({ ...current, connectionMessage })),
    );
    return () => {
      controller.abort();
      events.close();
    };
  }, [api]);

  return state;
}
