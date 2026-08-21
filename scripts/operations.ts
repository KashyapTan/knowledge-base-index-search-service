import { runOperationsCli } from "../src/operations/cli.ts";

process.exitCode = await runOperationsCli(Bun.argv.slice(2));
