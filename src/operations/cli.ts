import {
  APPLICATION_VERSION,
  type AppConfig,
  type LoadAppConfigOptions,
  loadAppConfig,
} from "../config/index.ts";
import { createTransformersEmbeddingProvider, type EmbeddingProvider } from "../indexing/index.ts";
import {
  collectDiagnostics,
  importModelAssetSource,
  pinnedDependencyVersions,
  type ResetScope,
  resetLocalState,
  resetTargets,
  resolvedConfiguration,
  selectConfiguredRoot,
  stageIndexRebuild,
  triggerRunningAction,
} from "./index.ts";

const HELP = `KBISS operational commands

  bun run serve [configuration options]       Build, start, and open the local app
  bun run config [configuration options]      Print resolved configuration and state paths
  bun run doctor [configuration options]      Check Bun, platform, model, and index state
  bun run reconcile [configuration options]   Reconcile a currently running root
  bun run reindex [configuration options]     Reindex committed files in a running root
  bun run rebuild [--yes] [options]            Preserve and replace the selected index
  bun run reset [--yes] [scope flags]          Remove only exact selected application data
  bun run root <directory> [--config file]     Save a different default source root
  bun run model:setup [--asset-source dir]     Prepare and verify local model assets
  bun run version                              Print application/runtime versions

Configuration options: --root, --port, --config, --state-dir, --cache-dir, --model,
--quantization, --vector-dimension, --normalization, and --offline.

Reset scope flags: --all-index-versions and --include-model. The default is only the current
root/model/schema index. Destructive commands prompt on a TTY; automation must pass --yes.`;

export interface OperationsCliIo {
  readonly confirm?: (message: string) => boolean | Promise<boolean>;
  readonly error?: (message: string) => void;
  readonly info?: (message: string) => void;
}

export interface OperationsCliOptions extends LoadAppConfigOptions {
  readonly createEmbeddingProvider?: (config: AppConfig) => EmbeddingProvider;
  readonly io?: OperationsCliIo;
}

function stripFlag(
  argv: readonly string[],
  flag: string,
): { readonly found: boolean; readonly argv: string[] } {
  return { found: argv.includes(flag), argv: argv.filter((argument) => argument !== flag) };
}

function takeOption(
  argv: readonly string[],
  option: string,
): { readonly argv: string[]; readonly value?: string; readonly invalid: boolean } {
  const remaining: string[] = [];
  let value: string | undefined;
  let invalid = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === option) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) invalid = true;
      else {
        value = next;
        index += 1;
      }
    } else if (argument?.startsWith(`${option}=`)) {
      value = argument.slice(option.length + 1);
      if (!value) invalid = true;
    } else if (argument) remaining.push(argument);
  }
  return { argv: remaining, ...(value ? { value } : {}), invalid };
}

async function defaultConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  return globalThis.prompt(`${message} Type yes to continue:`)?.trim().toLowerCase() === "yes";
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export async function runOperationsCli(
  inputArgv: readonly string[],
  options: OperationsCliOptions = {},
): Promise<number> {
  const argv = inputArgv[0] === "--" ? inputArgv.slice(1) : [...inputArgv];
  const command = argv[0] ?? "help";
  const commandArgs = argv.slice(1);
  const info = options.io?.info ?? console.info;
  const printError = options.io?.error ?? console.error;
  const confirm = options.io?.confirm ?? defaultConfirm;
  if (command === "help" || command === "--help" || command === "-h") {
    info(HELP);
    return 0;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    const dependencies = await pinnedDependencyVersions();
    info(
      `KBISS ${APPLICATION_VERSION}\nBun ${Bun.version}\n${process.platform} ${
        process.arch
      }\n${Object.entries(dependencies)
        .map(([name, version]) => `${name} ${version}`)
        .join("\n")}`,
    );
    return 0;
  }
  if (command === "root") {
    const selectedConfig = takeOption(commandArgs, "--config");
    const root = selectedConfig.argv.find((argument) => argument !== "--");
    if (
      selectedConfig.invalid ||
      !root ||
      selectedConfig.argv.filter((value) => value !== "--").length !== 1
    ) {
      printError("[OPERATION_ARGUMENT_INVALID] Usage: bun run root <directory> [--config file]");
      return 1;
    }
    const selected = await selectConfiguredRoot(root, {
      ...(selectedConfig.value ? { configFile: selectedConfig.value } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
    });
    if (!selected.ok) {
      printError(`[${selected.error.code}] ${selected.error.message}`);
      return 1;
    }
    info(
      `Selected source root: ${selected.value.root}\nConfiguration: ${selected.value.configFile}`,
    );
    return 0;
  }

  let configArgs = [...commandArgs];
  let yes = false;
  let includeModel = false;
  let allIndexVersions = false;
  let assetSource: string | undefined;
  for (const flag of ["--yes", "--include-model", "--all-index-versions"] as const) {
    const stripped = stripFlag(configArgs, flag);
    configArgs = stripped.argv;
    if (flag === "--yes") yes = stripped.found;
    if (flag === "--include-model") includeModel = stripped.found;
    if (flag === "--all-index-versions") allIndexVersions = stripped.found;
  }
  const asset = takeOption(configArgs, "--asset-source");
  if (asset.invalid) {
    printError("[OPERATION_ARGUMENT_INVALID] --asset-source requires a directory.");
    return 1;
  }
  configArgs = asset.argv;
  assetSource = asset.value;
  const loaded = await loadAppConfig({ ...options, argv: configArgs });
  if (!loaded.ok) {
    printError(`[${loaded.error.code}] ${loaded.error.message}`);
    return 1;
  }
  const config = loaded.value;

  if (command === "config") {
    info(json(resolvedConfiguration(config)));
    return 0;
  }
  if (command === "doctor") {
    const report = await collectDiagnostics(config);
    info(json(report));
    return report.bun.compatible && report.platform.support.level !== "unsupported" ? 0 : 1;
  }
  if (command === "reconcile" || command === "reindex") {
    const result = await triggerRunningAction(config, command);
    if (!result.ok) {
      printError(`[${result.error.code}] ${result.error.message}`);
      return 1;
    }
    info(`${command === "reconcile" ? "Reconciliation" : "Reindex"} completed at ${result.value}`);
    return 0;
  }
  if (command === "rebuild") {
    const targets = [config.paths.indexDir];
    info(
      `Rebuild target: ${targets[0]}\nThe previous index will be preserved in the rebuild-backups directory.`,
    );
    const approved = yes || (await confirm("Preserve and rebuild this exact index?"));
    const result = await stageIndexRebuild(config, { confirmed: approved });
    if (!result.ok) {
      printError(`[${result.error.code}] ${result.error.message}`);
      return 1;
    }
    info(
      `Fresh index staged at ${result.value.target}${
        result.value.backup ? `\nPrevious index preserved at ${result.value.backup}` : ""
      }\nRun bun run serve to populate it.`,
    );
    return 0;
  }
  if (command === "reset") {
    const scopes: ResetScope[] = [allIndexVersions ? "root-indexes" : "current-index"];
    if (includeModel) scopes.push("model-cache");
    const targets = resetTargets(config, scopes);
    info(`Reset will remove only:\n${targets.map((target) => `  - ${target}`).join("\n")}`);
    const approved = yes || (await confirm("Remove these exact KBISS targets?"));
    const result = await resetLocalState(config, scopes, { confirmed: approved });
    if (!result.ok) {
      printError(`[${result.error.code}] ${result.error.message}`);
      return 1;
    }
    info(`Removed ${result.value.length} selected KBISS target(s).`);
    return 0;
  }
  if (command === "model-setup") {
    if (assetSource) {
      const imported = await importModelAssetSource(config, assetSource);
      if (!imported.ok) {
        printError(`[${imported.error.code}] ${imported.error.message}`);
        return 1;
      }
      info(`Imported verified model assets from ${imported.value.source}.`);
    }
    const provider = (options.createEmbeddingProvider ?? createTransformersEmbeddingProvider)(
      config,
    );
    try {
      const prepared = await provider.warmUp({
        allowDownload: !config.offline && !assetSource,
        downloadRetries: 3,
        recoverCorruptAssets: !config.offline && !assetSource,
        onProgress: (_phase, message) => info(message),
      });
      if (!prepared.ok) {
        printError(`[${prepared.error.code}] ${prepared.error.message}`);
        return 1;
      }
      return 0;
    } finally {
      await provider.shutdown();
    }
  }
  printError(`[OPERATION_ARGUMENT_INVALID] Unknown command: ${command}\n\n${HELP}`);
  return 1;
}
