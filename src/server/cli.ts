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
  console.info(`Source root: ${started.config.sourceRoots[0].path}`);
  console.info(
    started.config.offline
      ? "Offline mode is enabled; only verified cached model assets will be used."
      : "Model assets will be verified locally and acquired once if they are missing.",
  );
  void started.ready.then(() => {
    const startup = started.runtime.status().startup;
    if (startup.phase === "error") {
      console.error(`[${startup.error.code}] ${startup.error.message}`);
      console.error("Run `bun run doctor` for resolved paths and recovery guidance.");
    } else {
      console.info("KBISS is ready. Press Ctrl-C to stop it safely.");
    }
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    console.info("Stopping KBISS and checkpointing local work...");
    void started.shutdown().then(() => console.info("KBISS stopped."));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
