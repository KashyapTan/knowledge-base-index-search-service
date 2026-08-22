import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { DataType } from "@huggingface/transformers";
import { err, ok, type Result } from "../shared/result.ts";
import { createIndexCompatibility } from "./compatibility.ts";
import type {
  AppConfig,
  ConfigurationError,
  EmbeddingConfig,
  IndexCompatibility,
} from "./contracts.ts";
import { LOOPBACK_HOST } from "./contracts.ts";
import {
  DEFAULT_EMBEDDING_CONFIG,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_INDEX_CONFIG,
  DEFAULT_PORT,
  DEFAULT_SOURCE_ROOT,
  SUPPORTED_QUANTIZATIONS,
} from "./defaults.ts";
import {
  canonicalizeSourceRoot,
  createRootIdentity,
  expandHomePath,
  resolveLocalPaths,
  resolvePlatformDirectories,
} from "./paths.ts";

interface RawConfig {
  readonly cacheDir?: string;
  readonly ignorePatterns?: readonly string[];
  readonly modelId?: string;
  readonly normalization?: string;
  readonly offline?: string | boolean;
  readonly port?: string | number;
  readonly quantization?: string;
  readonly root?: string;
  readonly stateDir?: string;
  readonly vectorDimension?: string | number;
}

interface CliConfig extends RawConfig {
  readonly configFile?: string;
}

export interface LoadAppConfigOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly projectDir?: string;
}

const cliOptions = {
  "--cache-dir": "cacheDir",
  "--config": "configFile",
  "--model": "modelId",
  "--normalization": "normalization",
  "--offline": "offline",
  "--port": "port",
  "--quantization": "quantization",
  "--root": "root",
  "--state-dir": "stateDir",
  "--vector-dimension": "vectorDimension",
} as const;

type CliOption = keyof typeof cliOptions;

function isCliOption(value: string): value is CliOption {
  return Object.hasOwn(cliOptions, value);
}

export function parseCliOptions(argv: readonly string[]): Result<CliConfig, ConfigurationError> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument) continue;
    if (argument === "--offline") {
      parsed.offline = "true";
      continue;
    }
    const equalsAt = argument.indexOf("=");
    const option = equalsAt === -1 ? argument : argument.slice(0, equalsAt);
    if (!isCliOption(option)) {
      return err({
        code: "CLI_ARGUMENT_INVALID",
        message: `Unknown command-line option: ${option}`,
        details: { option },
      });
    }
    const value = equalsAt === -1 ? argv[index + 1] : argument.slice(equalsAt + 1);
    if (!value || (equalsAt === -1 && value.startsWith("--"))) {
      return err({
        code: "CLI_ARGUMENT_INVALID",
        message: `Command-line option ${option} requires a value.`,
        details: { option },
      });
    }
    parsed[cliOptions[option]] = value;
    if (equalsAt === -1) index += 1;
  }
  return ok(parsed);
}

function environmentConfig(env: Readonly<Record<string, string | undefined>>): CliConfig {
  return {
    ...(env.KBISS_CACHE_DIR ? { cacheDir: env.KBISS_CACHE_DIR } : {}),
    ...(env.KBISS_CONFIG_FILE ? { configFile: env.KBISS_CONFIG_FILE } : {}),
    ...(env.KBISS_MODEL_ID ? { modelId: env.KBISS_MODEL_ID } : {}),
    ...(env.KBISS_NORMALIZATION ? { normalization: env.KBISS_NORMALIZATION } : {}),
    ...(env.KBISS_OFFLINE ? { offline: env.KBISS_OFFLINE } : {}),
    ...(env.KBISS_PORT ? { port: env.KBISS_PORT } : {}),
    ...(env.KBISS_QUANTIZATION ? { quantization: env.KBISS_QUANTIZATION } : {}),
    ...(env.KBISS_ROOT ? { root: env.KBISS_ROOT } : {}),
    ...(env.KBISS_STATE_DIR ? { stateDir: env.KBISS_STATE_DIR } : {}),
    ...(env.KBISS_VECTOR_DIMENSION ? { vectorDimension: env.KBISS_VECTOR_DIMENSION } : {}),
  };
}

const allowedConfigKeys = new Set<keyof RawConfig>([
  "cacheDir",
  "ignorePatterns",
  "modelId",
  "normalization",
  "offline",
  "port",
  "quantization",
  "root",
  "stateDir",
  "vectorDimension",
]);

function parseConfigFileValue(value: unknown): Result<RawConfig, ConfigurationError> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return err({
      code: "CONFIG_FILE_INVALID",
      message: "The user configuration file must contain a JSON object.",
    });
  }
  const record = value as Record<string, unknown>;
  const unknownKey = Object.keys(record).find(
    (key) => !allowedConfigKeys.has(key as keyof RawConfig),
  );
  if (unknownKey) {
    return err({
      code: "CONFIG_FILE_INVALID",
      message: `The user configuration file contains an unknown setting: ${unknownKey}`,
      details: { setting: unknownKey },
    });
  }
  for (const [key, setting] of Object.entries(record)) {
    const validType =
      key === "ignorePatterns"
        ? Array.isArray(setting) && setting.every((pattern) => typeof pattern === "string")
        : key === "port" || key === "vectorDimension"
          ? typeof setting === "number" || typeof setting === "string"
          : key === "offline"
            ? typeof setting === "boolean" || typeof setting === "string"
            : typeof setting === "string";
    if (!validType) {
      return err({
        code: "CONFIG_FILE_INVALID",
        message: `The user configuration setting ${key} has the wrong type.`,
        details: { setting: key },
      });
    }
  }
  return ok(record as RawConfig);
}

async function readUserConfig(
  path: string,
  required: boolean,
): Promise<Result<RawConfig, ConfigurationError>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!required && error instanceof Error && "code" in error && error.code === "ENOENT") {
      return ok({});
    }
    return err({
      code: "CONFIG_FILE_INVALID",
      message: "The user configuration file could not be read.",
      details: { path },
    });
  }
  try {
    return parseConfigFileValue(JSON.parse(text));
  } catch {
    return err({
      code: "CONFIG_FILE_INVALID",
      message: "The user configuration file is not valid JSON.",
      details: { path },
    });
  }
}

function parseInteger(
  value: string | number,
  setting: string,
  bounds: { readonly min: number; readonly max: number },
): Result<number, ConfigurationError> {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    return err({
      code: "CONFIG_VALUE_INVALID",
      message: `${setting} must be an integer from ${bounds.min} through ${bounds.max}.`,
      details: { setting },
    });
  }
  return ok(parsed);
}

function nonEmpty(value: string, setting: string): Result<string, ConfigurationError> {
  const trimmed = value.trim();
  if (!trimmed) {
    return err({
      code: "CONFIG_VALUE_INVALID",
      message: `${setting} must not be empty.`,
      details: { setting },
    });
  }
  return ok(trimmed);
}

function parseBoolean(
  value: string | boolean,
  setting: string,
): Result<boolean, ConfigurationError> {
  if (typeof value === "boolean") return ok(value);
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return ok(true);
  if (["0", "false", "no", "off"].includes(normalized)) return ok(false);
  return err({
    code: "CONFIG_VALUE_INVALID",
    message: `${setting} must be true or false.`,
    details: { setting },
  });
}

function parseIgnorePatterns(
  value: readonly string[],
): Result<readonly string[], ConfigurationError> {
  if (value.length > 256) {
    return err({
      code: "CONFIG_VALUE_INVALID",
      message: "ignorePatterns must contain no more than 256 entries.",
      details: { setting: "ignorePatterns" },
    });
  }
  const patterns: string[] = [];
  for (const input of value) {
    const pattern = input.trim().replaceAll("\\", "/");
    const segments = pattern.replace(/\/$/u, "").split("/");
    if (
      !pattern ||
      pattern.length > 256 ||
      pattern.startsWith("/") ||
      pattern.includes("\0") ||
      segments.includes("..")
    ) {
      return err({
        code: "CONFIG_VALUE_INVALID",
        message:
          "Each ignorePatterns entry must be a non-empty root-relative glob without parent traversal.",
        details: { setting: "ignorePatterns" },
      });
    }
    if (!patterns.includes(pattern)) patterns.push(pattern);
  }
  return ok(Object.freeze(patterns));
}

function compatibilityNamespaceInput(compatibility: IndexCompatibility): string {
  return JSON.stringify({
    chunking: compatibility.chunking,
    embedding: compatibility.embedding,
    extractorVersion: compatibility.extractorVersion,
    indexSchemaVersion: compatibility.indexSchemaVersion,
    rootIdentity: compatibility.rootIdentity,
  });
}

function resolveConfiguredPath(
  value: string,
  homeDir: string,
  cwd: string,
): Result<string, ConfigurationError> {
  const expanded = expandHomePath(value, homeDir);
  return expanded.ok ? ok(resolve(cwd, expanded.value)) : expanded;
}

export async function loadAppConfig(
  options: LoadAppConfigOptions = {},
): Promise<Result<AppConfig, ConfigurationError>> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const platformDirectories = resolvePlatformDirectories({
    env,
    homeDir,
    ...(options.platform ? { platform: options.platform } : {}),
  });
  if (!platformDirectories.ok) return platformDirectories;

  const cli = parseCliOptions(argv);
  if (!cli.ok) return cli;
  const environment = environmentConfig(env);
  const selectedConfigFile = cli.value.configFile ?? environment.configFile;
  const configFileInput = selectedConfigFile ?? platformDirectories.value.configFile;
  const configFilePath = resolveConfiguredPath(configFileInput, homeDir, cwd);
  if (!configFilePath.ok) return configFilePath;
  const file = await readUserConfig(configFilePath.value, selectedConfigFile !== undefined);
  if (!file.ok) return file;

  const merged = {
    cacheDir:
      cli.value.cacheDir ??
      environment.cacheDir ??
      file.value.cacheDir ??
      platformDirectories.value.cacheDir,
    modelId:
      cli.value.modelId ??
      environment.modelId ??
      file.value.modelId ??
      DEFAULT_EMBEDDING_CONFIG.modelId,
    ignorePatterns: file.value.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS,
    normalization:
      cli.value.normalization ??
      environment.normalization ??
      file.value.normalization ??
      DEFAULT_EMBEDDING_CONFIG.normalization,
    offline: cli.value.offline ?? environment.offline ?? file.value.offline ?? false,
    port: cli.value.port ?? environment.port ?? file.value.port ?? DEFAULT_PORT,
    quantization:
      cli.value.quantization ??
      environment.quantization ??
      file.value.quantization ??
      DEFAULT_EMBEDDING_CONFIG.quantization,
    root: cli.value.root ?? environment.root ?? file.value.root ?? DEFAULT_SOURCE_ROOT,
    stateDir:
      cli.value.stateDir ??
      environment.stateDir ??
      file.value.stateDir ??
      platformDirectories.value.stateDir,
    vectorDimension:
      cli.value.vectorDimension ??
      environment.vectorDimension ??
      file.value.vectorDimension ??
      DEFAULT_EMBEDDING_CONFIG.vectorDimension,
  };

  const port = parseInteger(merged.port, "port", { min: 1, max: 65_535 });
  if (!port.ok) return port;
  const vectorDimension = parseInteger(merged.vectorDimension, "vectorDimension", {
    min: 1,
    max: 65_536,
  });
  if (!vectorDimension.ok) return vectorDimension;
  const modelId = nonEmpty(merged.modelId, "modelId");
  if (!modelId.ok) return modelId;
  const quantization = nonEmpty(merged.quantization, "quantization");
  if (!quantization.ok) return quantization;
  if (!SUPPORTED_QUANTIZATIONS.has(quantization.value as DataType)) {
    return err({
      code: "CONFIG_VALUE_INVALID",
      message: "quantization is not supported by the local embedding runtime.",
      details: { setting: "quantization" },
    });
  }
  if (merged.normalization !== "l2") {
    return err({
      code: "CONFIG_VALUE_INVALID",
      message: "normalization must be l2 for the current index schema.",
      details: { setting: "normalization" },
    });
  }
  const offline = parseBoolean(merged.offline, "offline");
  if (!offline.ok) return offline;
  const ignorePatterns = parseIgnorePatterns(merged.ignorePatterns);
  if (!ignorePatterns.ok) return ignorePatterns;

  const sourceRoot = await canonicalizeSourceRoot(merged.root, { cwd, homeDir });
  if (!sourceRoot.ok) return sourceRoot;
  const rootIdentity = createRootIdentity(sourceRoot.value);
  const embedding: EmbeddingConfig = {
    modelId: modelId.value,
    normalization: "l2",
    quantization: quantization.value as DataType,
    vectorDimension: vectorDimension.value,
  };
  const compatibility = createIndexCompatibility({
    embedding,
    index: DEFAULT_INDEX_CONFIG,
    rootIdentity,
  });
  const stateDir = resolveConfiguredPath(merged.stateDir, homeDir, cwd);
  if (!stateDir.ok) return stateDir;
  const cacheDir = resolveConfiguredPath(merged.cacheDir, homeDir, cwd);
  if (!cacheDir.ok) return cacheDir;
  const paths = await resolveLocalPaths({
    applicationCacheDir: cacheDir.value,
    applicationStateDir: stateDir.value,
    compatibilityNamespaceInput: compatibilityNamespaceInput(compatibility),
    modelNamespaceInput: JSON.stringify(embedding),
    projectDir: options.projectDir ?? resolve(import.meta.dir, "../.."),
    rootIdentity,
    sourceRoot: sourceRoot.value,
  });
  if (!paths.ok) return paths;

  return ok({
    compatibility,
    embedding,
    ignorePatterns: ignorePatterns.value,
    index: DEFAULT_INDEX_CONFIG,
    offline: offline.value,
    paths: paths.value,
    server: { hostname: LOOPBACK_HOST, port: port.value },
    sourceRoots: [{ identity: rootIdentity, path: sourceRoot.value }],
  });
}
