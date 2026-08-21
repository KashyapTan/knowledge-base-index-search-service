import { runOperationsCli } from "../src/operations/cli.ts";

process.exitCode = await runOperationsCli(["model-setup", ...Bun.argv.slice(2)]);
