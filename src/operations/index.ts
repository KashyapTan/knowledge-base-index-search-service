import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  APPLICATION_VERSION,
  type AppConfig,
  canonicalizeSourceRoot,
  expandHomePath,
  readCompatibilityMetadata,
  resolvePlatformDirectories,
} from "../config/index.ts";
import { inspectModelAssets, type ModelAssetInspection } from "../indexing/index.ts";
import { API_PREFIX, findCompatibleInstance } from "../server/index.ts";
import { err, ok, type Result } from "../shared/result.ts";

export type OperationErrorCode =
  | "OPERATION_ARGUMENT_INVALID"
  | "OPERATION_CONFIRMATION_REQUIRED"
  | "OPERATION_TARGET_UNSAFE"
  | "OPERATION_FAILED"
  | "APPLICATION_NOT_RUNNING"
  | "APPLICATION_ACTION_FAILED"
  | "CONFIGURATION_WRITE_FAILED";

export interface OperationError {
  readonly code: OperationErrorCode;
  readonly message: string;
}

export interface PlatformSupport {
  readonly level: "verified" | "supported-unverified" | "unsupported";
  readonly message: string;
}

export interface DiagnosticReport {
  readonly applicationVersion: string;
  readonly bun: {
    readonly actual: string;
    readonly expected: string;
    readonly compatible: boolean;
  };
  readonly dependencies: Readonly<Record<string, string>>;
  readonly platform: {
    readonly name: NodeJS.Platform;
    readonly architecture: string;
    readonly support: PlatformSupport;
  };
  readonly sourceRoot: string;
  readonly rootIdentity: string;
  readonly offline: boolean;
  readonly model: ModelAssetInspection & { readonly cacheDir: string };
  readonly index: {
    readonly state:
      | "not-initialized"
      | "compatible"
      | "migration-required"
      | "rebuild-required"
      | "corrupt";
    readonly reasons: readonly string[];
    readonly directory: string;
  };
  readonly paths: AppConfig["paths"];
}

const EXPECTED_BUN_VERSION = "1.4.0";
const DIAGNOSTIC_DEPENDENCIES = [
  "@huggingface/transformers",
  "@lancedb/lancedb",
  "apache-arrow",
  "react",
  "vite",
] as const;

function operationFailure(
  code: OperationErrorCode,
  message: string,
): Result<never, OperationError> {
  return err({ code, message });
}

function isInside(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

async function existingCanonicalPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function validateExactTarget(
  target: string,
  parent: string,
): Promise<Result<void, OperationError>> {
  const absoluteTarget = resolve(target);
  const absoluteParent = resolve(parent);
  if (absoluteTarget === absoluteParent || !isInside(absoluteParent, absoluteTarget)) {
    return operationFailure(
      "OPERATION_TARGET_UNSAFE",
      "The requested target is not a specific child of the configured application-data directory.",
    );
  }
  try {
    const canonicalParent = await realpath(absoluteParent);
    const canonicalTarget = await existingCanonicalPath(absoluteTarget);
    if (canonicalTarget && !isInside(canonicalParent, canonicalTarget)) {
      return operationFailure(
        "OPERATION_TARGET_UNSAFE",
        "The requested target resolves outside the configured application-data directory.",
      );
    }
    return ok(undefined);
  } catch {
    return operationFailure(
      "OPERATION_TARGET_UNSAFE",
      "The requested target could not be safely resolved.",
    );
  }
}

export function platformSupport(
  platform: NodeJS.Platform = process.platform,
  architecture = process.arch,
): PlatformSupport {
  if (platform === "darwin" && architecture === "arm64") {
    return { level: "verified", message: "Verified on macOS arm64 with the pinned native stack." };
  }
  const recognized = new Set(["darwin:x64", "linux:x64", "linux:arm64", "win32:x64"]);
  return recognized.has(`${platform}:${architecture}`)
    ? {
        level: "supported-unverified",
        message:
          "The pinned native packages publish support, but this exact target is not CI-verified by KBISS.",
      }
    : {
        level: "unsupported",
        message: "This platform/architecture is not supported by the pinned KBISS native stack.",
      };
}

export function resolvedConfiguration(config: AppConfig): Record<string, unknown> {
  return {
    applicationVersion: APPLICATION_VERSION,
    sourceRoot: config.sourceRoots[0].path,
    rootIdentity: config.sourceRoots[0].identity,
    server: config.server,
    offline: config.offline,
    ignorePatterns: config.ignorePatterns,
    embedding: config.embedding,
    index: config.index,
    paths: config.paths,
  };
}

export async function pinnedDependencyVersions(): Promise<Readonly<Record<string, string>>> {
  try {
    const packageFile = resolve(import.meta.dir, "../../package.json");
    const value = JSON.parse(await readFile(packageFile, "utf8")) as {
      readonly dependencies?: Readonly<Record<string, unknown>>;
      readonly devDependencies?: Readonly<Record<string, unknown>>;
    };
    const versions: Record<string, string> = {};
    for (const name of DIAGNOSTIC_DEPENDENCIES) {
      const version = value.dependencies?.[name] ?? value.devDependencies?.[name];
      if (typeof version === "string") versions[name] = version;
    }
    return versions;
  } catch {
    return {};
  }
}

export async function collectDiagnostics(config: AppConfig): Promise<DiagnosticReport> {
  const [model, assessment, dependencies] = await Promise.all([
    inspectModelAssets(config.paths.modelCacheDir, {
      ...config.embedding,
      maximumTokens: 512,
    }),
    readCompatibilityMetadata(config.paths.compatibilityFile, config.compatibility),
    pinnedDependencyVersions(),
  ]);
  let hasIndexFiles = false;
  try {
    hasIndexFiles = (await readdir(config.paths.lanceDbDir)).length > 0;
  } catch {
    // A missing database directory is reported as not initialized.
  }
  const index = !assessment.ok
    ? {
        state: "corrupt" as const,
        reasons: [assessment.error.message],
        directory: config.paths.indexDir,
      }
    : !hasIndexFiles && assessment.value.reasons.includes("compatibility metadata is missing")
      ? {
          state: "not-initialized" as const,
          reasons: [],
          directory: config.paths.indexDir,
        }
      : {
          state: assessment.value.status,
          reasons: assessment.value.reasons,
          directory: config.paths.indexDir,
        };
  return {
    applicationVersion: APPLICATION_VERSION,
    bun: {
      actual: Bun.version,
      expected: EXPECTED_BUN_VERSION,
      compatible: Bun.version === EXPECTED_BUN_VERSION,
    },
    dependencies,
    platform: {
      name: process.platform,
      architecture: process.arch,
      support: platformSupport(),
    },
    sourceRoot: config.sourceRoots[0].path,
    rootIdentity: config.sourceRoots[0].identity,
    offline: config.offline,
    model: { ...model, cacheDir: config.paths.modelCacheDir },
    index,
    paths: config.paths,
  };
}

export type ResetScope = "current-index" | "root-indexes" | "model-cache";

export function resetTargets(config: AppConfig, scopes: readonly ResetScope[]): readonly string[] {
  const targets = new Set<string>();
  for (const scope of scopes) {
    if (scope === "current-index") targets.add(config.paths.indexDir);
    if (scope === "root-indexes") {
      targets.add(join(config.paths.applicationStateDir, "indexes", config.paths.rootNamespace));
    }
    if (scope === "model-cache") targets.add(config.paths.modelCacheDir);
  }
  return [...targets];
}

function targetParent(config: AppConfig, scope: ResetScope): string {
  if (scope === "current-index") {
    return join(config.paths.applicationStateDir, "indexes", config.paths.rootNamespace);
  }
  if (scope === "root-indexes") return join(config.paths.applicationStateDir, "indexes");
  return join(config.paths.applicationCacheDir, "models");
}

export async function resetLocalState(
  config: AppConfig,
  scopes: readonly ResetScope[],
  options: { readonly confirmed: boolean },
): Promise<Result<readonly string[], OperationError>> {
  if (!options.confirmed) {
    return operationFailure(
      "OPERATION_CONFIRMATION_REQUIRED",
      "Reset was not confirmed; no application data was removed.",
    );
  }
  if (scopes.length === 0) {
    return operationFailure("OPERATION_ARGUMENT_INVALID", "Select at least one reset scope.");
  }
  const entries = scopes.map((scope) => ({ scope, target: resetTargets(config, [scope])[0] }));
  if (entries.some((entry) => !entry.target)) {
    return operationFailure("OPERATION_TARGET_UNSAFE", "A reset target could not be resolved.");
  }
  for (const entry of entries) {
    const safe = await validateExactTarget(
      entry.target as string,
      targetParent(config, entry.scope),
    );
    if (!safe.ok) return safe;
  }
  try {
    for (const target of new Set(entries.map((entry) => entry.target as string))) {
      await rm(target, { recursive: true, force: true });
    }
    return ok(resetTargets(config, scopes));
  } catch {
    return operationFailure(
      "OPERATION_FAILED",
      "The selected application data could not be removed completely.",
    );
  }
}

export async function stageIndexRebuild(
  config: AppConfig,
  options: { readonly confirmed: boolean; readonly now?: Date } = { confirmed: false },
): Promise<Result<{ readonly backup?: string; readonly target: string }, OperationError>> {
  if (!options.confirmed) {
    return operationFailure(
      "OPERATION_CONFIRMATION_REQUIRED",
      "Rebuild was not confirmed; the current index remains unchanged.",
    );
  }
  const parent = join(config.paths.applicationStateDir, "indexes", config.paths.rootNamespace);
  const safe = await validateExactTarget(config.paths.indexDir, parent);
  if (!safe.ok) return safe;
  try {
    const exists = await lstat(config.paths.indexDir).then(
      () => true,
      (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      },
    );
    let backup: string | undefined;
    if (exists) {
      const stamp = (options.now ?? new Date()).toISOString().replaceAll(/[:.]/gu, "-");
      const backups = join(
        config.paths.applicationStateDir,
        "rebuild-backups",
        config.paths.rootNamespace,
      );
      await mkdir(backups, { recursive: true });
      backup = join(backups, `${config.paths.indexNamespace}-${stamp}-${randomUUID()}`);
      await rename(config.paths.indexDir, backup);
    }
    await Promise.all([
      mkdir(config.paths.indexMetadataDir, { recursive: true }),
      mkdir(config.paths.lanceDbDir, { recursive: true }),
    ]);
    return ok({ ...(backup ? { backup } : {}), target: config.paths.indexDir });
  } catch {
    return operationFailure(
      "OPERATION_FAILED",
      "The existing index could not be preserved and staged for rebuild.",
    );
  }
}

export interface SelectRootOptions {
  readonly configFile?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
}

export async function selectConfiguredRoot(
  input: string,
  options: SelectRootOptions = {},
): Promise<Result<{ readonly configFile: string; readonly root: string }, OperationError>> {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const canonical = await canonicalizeSourceRoot(input, { cwd, homeDir });
  if (!canonical.ok) return operationFailure("OPERATION_ARGUMENT_INVALID", canonical.error.message);
  const directories = resolvePlatformDirectories({
    ...(options.env ? { env: options.env } : {}),
    homeDir,
    ...(options.platform ? { platform: options.platform } : {}),
  });
  if (!directories.ok) {
    return operationFailure("CONFIGURATION_WRITE_FAILED", directories.error.message);
  }
  const configuredPath =
    options.configFile ?? options.env?.KBISS_CONFIG_FILE ?? directories.value.configFile;
  const expanded = expandHomePath(configuredPath, homeDir);
  if (!expanded.ok) return operationFailure("CONFIGURATION_WRITE_FAILED", expanded.error.message);
  const configFile = resolve(cwd, expanded.value);
  let existing: Record<string, unknown> = {};
  try {
    const text = await readFile(configFile, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    existing = parsed as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      return operationFailure(
        "CONFIGURATION_WRITE_FAILED",
        "The existing user configuration is not valid JSON and was not overwritten.",
      );
    }
  }
  const temporary = `${configFile}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(dirname(configFile), { recursive: true });
    await writeFile(
      temporary,
      `${JSON.stringify({ ...existing, root: canonical.value }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    await rename(temporary, configFile);
    return ok({ configFile, root: canonical.value });
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    return operationFailure(
      "CONFIGURATION_WRITE_FAILED",
      "The selected root could not be saved to the user configuration.",
    );
  }
}

export async function triggerRunningAction(
  config: AppConfig,
  mode: "reconcile" | "reindex",
): Promise<Result<URL, OperationError>> {
  const instance = await findCompatibleInstance(config);
  if (!instance) {
    return operationFailure(
      "APPLICATION_NOT_RUNNING",
      "No compatible KBISS process is running for this root. Start it with bun run serve.",
    );
  }
  try {
    const statusResponse = await fetch(new URL(`${API_PREFIX}/status`, instance.url));
    if (!statusResponse.ok) throw new Error();
    const status = (await statusResponse.json()) as { readonly csrfToken?: unknown };
    if (typeof status.csrfToken !== "string" || !status.csrfToken) throw new Error();
    const response = await fetch(new URL(`${API_PREFIX}/actions/reconcile`, instance.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-KBISS-CSRF": status.csrfToken,
      },
      body: JSON.stringify({ mode }),
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => undefined)) as
        | { readonly error?: { readonly message?: unknown } }
        | undefined;
      return operationFailure(
        "APPLICATION_ACTION_FAILED",
        typeof value?.error?.message === "string"
          ? value.error.message
          : "The running application rejected the index action.",
      );
    }
    return ok(instance.url);
  } catch {
    return operationFailure(
      "APPLICATION_ACTION_FAILED",
      "The running application could not complete the index action.",
    );
  }
}

async function rejectSymlinks(directory: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return false;
    if (entry.isDirectory() && !(await rejectSymlinks(join(directory, entry.name)))) return false;
  }
  return true;
}

export async function importModelAssetSource(
  config: AppConfig,
  sourceInput: string,
): Promise<Result<{ readonly backup?: string; readonly source: string }, OperationError>> {
  const modelsParent = join(config.paths.applicationCacheDir, "models");
  const safe = await validateExactTarget(config.paths.modelCacheDir, modelsParent);
  if (!safe.ok) return safe;
  let source: string;
  try {
    source = await realpath(resolve(sourceInput));
    const info = await lstat(source);
    if (!info.isDirectory() || !(await rejectSymlinks(source))) {
      return operationFailure(
        "OPERATION_ARGUMENT_INVALID",
        "The model asset source must be a directory containing no symbolic links.",
      );
    }
  } catch {
    return operationFailure(
      "OPERATION_ARGUMENT_INVALID",
      "The model asset source could not be read.",
    );
  }
  if (
    isInside(source, config.paths.modelCacheDir) ||
    isInside(config.paths.modelCacheDir, source)
  ) {
    return operationFailure(
      "OPERATION_TARGET_UNSAFE",
      "The model asset source and managed model cache must be separate directories.",
    );
  }
  const identity = { ...config.embedding, maximumTokens: 512 };
  const inspection = await inspectModelAssets(source, identity);
  if (inspection.state !== "ready") {
    return operationFailure(
      "OPERATION_ARGUMENT_INVALID",
      `The model asset source is not a verified KBISS bundle: ${inspection.message}`,
    );
  }
  const stage = `${config.paths.modelCacheDir}.import-${process.pid}-${randomUUID()}`;
  let backup: string | undefined;
  try {
    await mkdir(dirname(stage), { recursive: true });
    await cp(source, stage, { recursive: true, errorOnExist: true, force: false });
    const currentExists = await lstat(config.paths.modelCacheDir).then(
      () => true,
      (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (currentExists) {
      backup = `${config.paths.modelCacheDir}.previous-${new Date()
        .toISOString()
        .replaceAll(/[:.]/gu, "-")}-${randomUUID()}`;
      await rename(config.paths.modelCacheDir, backup);
    }
    await rename(stage, config.paths.modelCacheDir);
    return ok({ ...(backup ? { backup } : {}), source });
  } catch {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    return operationFailure(
      "OPERATION_FAILED",
      "The verified model asset source could not be imported into the managed cache.",
    );
  }
}
