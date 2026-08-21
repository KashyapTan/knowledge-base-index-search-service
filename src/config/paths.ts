import { constants } from "node:fs";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { err, ok, type Result } from "../shared/result.ts";
import type { ConfigurationError, ResolvedPaths } from "./contracts.ts";
import { APPLICATION_NAME } from "./defaults.ts";
import { shortStableHash, stableHash } from "./hashing.ts";

export interface PlatformDirectoryOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
}

export interface PlatformDirectories {
  readonly cacheDir: string;
  readonly configFile: string;
  readonly stateDir: string;
}

export interface ResolveLocalPathsOptions {
  readonly applicationCacheDir: string;
  readonly applicationStateDir: string;
  readonly compatibilityNamespaceInput: string;
  readonly modelNamespaceInput: string;
  readonly projectDir: string;
  readonly rootIdentity: string;
  readonly sourceRoot: string;
}

function pathIsInside(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
}

export function expandHomePath(input: string, homeDir: string): Result<string, ConfigurationError> {
  if (!homeDir) {
    return err({
      code: "HOME_DIRECTORY_UNAVAILABLE",
      message: "The operating-system home directory could not be determined.",
    });
  }
  if (input === "~") return ok(resolve(homeDir));
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return ok(resolve(homeDir, input.slice(2)));
  }
  if (input.startsWith("~")) {
    return err({
      code: "CONFIG_VALUE_INVALID",
      message: "Named-user home paths are not supported; use ~ or an absolute path.",
      details: { setting: "path" },
    });
  }
  return ok(input);
}

export function resolvePlatformDirectories(
  options: PlatformDirectoryOptions = {},
): Result<PlatformDirectories, ConfigurationError> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const platformPath = platform === "win32" ? win32 : posix;
  if (!homeDir) {
    return err({
      code: "HOME_DIRECTORY_UNAVAILABLE",
      message: "The operating-system home directory could not be determined.",
    });
  }

  if (platform === "darwin") {
    const applicationSupport = platformPath.join(
      homeDir,
      "Library",
      "Application Support",
      APPLICATION_NAME,
    );
    return ok({
      cacheDir: platformPath.join(homeDir, "Library", "Caches", APPLICATION_NAME),
      configFile: platformPath.join(applicationSupport, "config.json"),
      stateDir: applicationSupport,
    });
  }

  if (platform === "win32") {
    const roaming = env.APPDATA || platformPath.join(homeDir, "AppData", "Roaming");
    const local = env.LOCALAPPDATA || platformPath.join(homeDir, "AppData", "Local");
    return ok({
      cacheDir: platformPath.join(local, APPLICATION_NAME, "cache"),
      configFile: platformPath.join(roaming, APPLICATION_NAME, "config.json"),
      stateDir: platformPath.join(local, APPLICATION_NAME, "state"),
    });
  }

  const configHome = env.XDG_CONFIG_HOME || platformPath.join(homeDir, ".config");
  const stateHome = env.XDG_STATE_HOME || platformPath.join(homeDir, ".local", "state");
  const cacheHome = env.XDG_CACHE_HOME || platformPath.join(homeDir, ".cache");
  return ok({
    cacheDir: platformPath.join(cacheHome, APPLICATION_NAME),
    configFile: platformPath.join(configHome, APPLICATION_NAME, "config.json"),
    stateDir: platformPath.join(stateHome, APPLICATION_NAME),
  });
}

export async function canonicalizeSourceRoot(
  input: string,
  options: { readonly cwd: string; readonly homeDir: string },
): Promise<Result<string, ConfigurationError>> {
  const expanded = expandHomePath(input, options.homeDir);
  if (!expanded.ok) return expanded;
  const absolutePath = resolve(options.cwd, expanded.value);

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return err({
        code: "ROOT_NOT_FOUND",
        message: "The configured source root does not exist.",
        details: { path: absolutePath },
      });
    }
    return err({
      code: "ROOT_UNREADABLE",
      message: "The configured source root could not be resolved.",
      details: { path: absolutePath },
    });
  }

  try {
    const rootStat = await stat(canonicalPath);
    if (!rootStat.isDirectory()) {
      return err({
        code: "ROOT_NOT_DIRECTORY",
        message: "The configured source root is not a directory.",
        details: { path: canonicalPath },
      });
    }
    await access(canonicalPath, constants.R_OK | constants.X_OK);
  } catch {
    return err({
      code: "ROOT_UNREADABLE",
      message: "The configured source root is not readable and searchable.",
      details: { path: canonicalPath },
    });
  }
  return ok(canonicalPath);
}

async function canonicalizeProspectivePath(path: string): Promise<string> {
  let cursor = resolve(path);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missingSegments.reverse());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(basename(cursor));
      cursor = parent;
    }
  }
}

function unsafeGeneratedPath(
  sourceRoot: string,
  projectDir: string,
  candidates: readonly string[],
): string | undefined {
  return candidates.find(
    (candidate) => pathIsInside(sourceRoot, candidate) || pathIsInside(projectDir, candidate),
  );
}

export async function resolveLocalPaths(
  options: ResolveLocalPathsOptions,
): Promise<Result<ResolvedPaths, ConfigurationError>> {
  try {
    const [sourceRoot, projectDir, applicationStateDir, applicationCacheDir] = await Promise.all([
      realpath(options.sourceRoot),
      realpath(options.projectDir),
      canonicalizeProspectivePath(options.applicationStateDir),
      canonicalizeProspectivePath(options.applicationCacheDir),
    ]);
    const rootNamespace = shortStableHash(`root-v1\0${options.rootIdentity}`);
    const indexNamespace = shortStableHash(`index-v1\0${options.compatibilityNamespaceInput}`);
    const indexDir = join(applicationStateDir, "indexes", rootNamespace, indexNamespace);
    const indexMetadataDir = join(indexDir, "metadata");
    const modelNamespace = shortStableHash(`model-v1\0${options.modelNamespaceInput}`);
    const modelCacheDir = join(applicationCacheDir, "models", modelNamespace);
    const generatedPaths = [applicationStateDir, applicationCacheDir, indexDir, modelCacheDir];
    const unsafe = unsafeGeneratedPath(sourceRoot, projectDir, generatedPaths);
    if (unsafe) {
      return err({
        code: "STATE_PATH_UNSAFE",
        message:
          "Application state and cache directories must be outside the source and project repositories.",
        details: { path: unsafe },
      });
    }

    const lanceDbDir = join(indexDir, "lancedb");
    const diagnosticLogsDir = join(applicationStateDir, "logs");
    await Promise.all([
      mkdir(lanceDbDir, { recursive: true }),
      mkdir(indexMetadataDir, { recursive: true }),
      mkdir(modelCacheDir, { recursive: true }),
      mkdir(diagnosticLogsDir, { recursive: true }),
    ]);
    return ok({
      applicationCacheDir,
      applicationStateDir,
      compatibilityFile: join(indexMetadataDir, "compatibility.json"),
      diagnosticLogsDir,
      indexDir,
      indexMetadataDir,
      indexNamespace,
      lanceDbDir,
      modelCacheDir,
      rootNamespace,
    });
  } catch {
    return err({
      code: "STATE_DIRECTORY_UNAVAILABLE",
      message: "Application state or cache directories could not be prepared.",
    });
  }
}

export function createRootIdentity(canonicalRoot: string): string {
  return stableHash(`canonical-root-v1\0${canonicalRoot}`);
}
