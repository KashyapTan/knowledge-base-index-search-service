import { type GrepExecutor, type GrepOptions, type GrepResult, runGrep } from "./grep.ts";

export const LARGE_FILE_GREP_THRESHOLD = 256 * 1024;

function abortError(): DOMException {
  return new DOMException("The grep operation was cancelled.", "AbortError");
}

export const browserGrepExecutor: GrepExecutor = async (
  content: string,
  options: GrepOptions,
  signal: AbortSignal,
): Promise<GrepResult> => {
  if (signal.aborted) throw abortError();
  if (content.length < LARGE_FILE_GREP_THRESHOLD || typeof Worker === "undefined") {
    await Promise.resolve();
    if (signal.aborted) throw abortError();
    return runGrep(content, options);
  }
  const worker = new Worker(new URL("./grep.worker.ts", import.meta.url), { type: "module" });
  return new Promise<GrepResult>((resolve, reject) => {
    const close = (): void => worker.terminate();
    const abort = (): void => {
      close();
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () => {
      signal.removeEventListener("abort", abort);
      close();
      reject(new Error("The in-file search worker failed."));
    };
    worker.onmessage = (event: MessageEvent<GrepResult>) => {
      signal.removeEventListener("abort", abort);
      close();
      resolve(event.data);
    };
    worker.postMessage({ content, options });
  });
};
