import { type GrepOptions, runGrep } from "./grep.ts";

interface GrepWorkerRequest {
  readonly content: string;
  readonly options: GrepOptions;
}

self.onmessage = (event: MessageEvent<GrepWorkerRequest>) => {
  self.postMessage(runGrep(event.data.content, event.data.options));
};
