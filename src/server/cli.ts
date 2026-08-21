import { startApplication } from "./index.ts";

async function openSystemBrowser(url: URL): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url.href]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url.href]
        : ["xdg-open", url.href];
  try {
    Bun.spawn(command, { stderr: "ignore", stdout: "ignore" }).unref();
  } catch {
    // The listening URL remains visible when no desktop opener is available.
  }
}

const launch = await startApplication({
  argv: Bun.argv.slice(2),
  openBrowser: openSystemBrowser,
});
if (!launch.ok) {
  console.error(`[${launch.error.code}] ${launch.error.message}`);
  process.exitCode = 1;
} else if (launch.value.kind === "existing") {
  console.info(`KBISS is already running at ${launch.value.url}`);
} else {
  const started = launch.value;
  console.info(`KBISS listening at ${started.url}`);
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void started.shutdown();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
