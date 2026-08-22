import { type GrepExecutor, type GrepOptions, type GrepResult, runGrep } from "./grep.ts";

export const LARGE_FILE_GREP_THRESHOLD = 256 * 1024;
export const DEFAULT_GREP_DEADLINE_MS = 1_000;

function abortError(): DOMException {
  return new DOMException("The grep operation was cancelled.", "AbortError");
}

export function createBrowserGrepExecutor(deadlineMs = DEFAULT_GREP_DEADLINE_MS): GrepExecutor {
  return async (
    content: string,
    options: GrepOptions,
    signal: AbortSignal,
  ): Promise<GrepResult> => {
    if (signal.aborted) throw abortError();
    const requiresIsolation = options.regex || content.length >= LARGE_FILE_GREP_THRESHOLD;
    if (!requiresIsolation || typeof Worker === "undefined") {
      await Promise.resolve();
      if (signal.aborted) throw abortError();
      return runGrep(content, options);
    }
    const worker = new Worker(new URL("./grep.worker.ts", import.meta.url), { type: "module" });
    return new Promise<GrepResult>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal.removeEventListener("abort", abort);
        worker.terminate();
        operation();
      };
      const abort = (): void => finish(() => reject(abortError()));
      const deadline = setTimeout(
        () =>
          finish(() =>
            resolve({
              matches: [],
              error: "The regular expression exceeded the safe execution deadline.",
              limited: false,
            }),
          ),
        Math.max(1, deadlineMs),
      );
      signal.addEventListener("abort", abort, { once: true });
      worker.onerror = () => finish(() => reject(new Error("The in-file search worker failed.")));
      worker.onmessage = (event: MessageEvent<GrepResult>) => finish(() => resolve(event.data));
      worker.postMessage({ content, options });
    });
  };
}

export const browserGrepExecutor = createBrowserGrepExecutor();
