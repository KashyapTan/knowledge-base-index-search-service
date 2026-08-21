import type { BigIntStats, Dirent } from "node:fs";
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { AppConfig, SourceRoot, StartupStateStore } from "../config/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type {
  DiscoveredFile,
  DiscoveryError,
  DiscoveryProgress,
  DiscoveryScanResult,
  FileChange,
  FileChangeKind,
  FileChangeSource,
  FileFingerprint,
  FileManifest,
  FileScanner,
} from "./contracts.ts";
import {
  fingerprintFile,
  fingerprintMetadata,
  metadataMatches,
  safeFileError,
} from "./fingerprint.ts";
import { formatForExtension, normalizedExtension } from "./formats.ts";
import { createFileId, normalizeRelativePath } from "./identity.ts";
import { createIgnoreMatcher, type IgnoreMatcher } from "./ignore.ts";

interface CandidateFile {
  readonly sourcePath: string;
  readonly canonicalPath: string;
  readonly relativePath: string;
}

interface CandidateFailure {
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly error: string;
  readonly stats?: BigIntStats;
}

interface WalkResult {
  readonly candidates: readonly CandidateFile[];
  readonly failures: readonly CandidateFailure[];
}

export interface DiscoveryScannerOptions {
  readonly concurrency?: number;
  readonly ignorePatterns?: readonly string[];
  readonly excludedCanonicalPaths?: readonly string[];
  readonly startupState?: StartupStateStore;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function excludedPath(candidate: string, excluded: readonly string[]): boolean {
  return excluded.some((path) => isWithin(path, candidate));
}

async function mapConcurrent<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  operation: (value: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const output = new Array<TOutput>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      const value = values[index];
      if (value !== undefined) output[index] = await operation(value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return output;
}

async function walkRoot(
  sourceRoot: string,
  matcher: IgnoreMatcher,
  excluded: readonly string[],
): Promise<WalkResult> {
  const candidates: CandidateFile[] = [];
  const failures: CandidateFailure[] = [];
  const visitedDirectories = new Set<string>();

  async function visitDirectory(sourceDirectory: string): Promise<void> {
    const canonicalDirectory = await realpath(sourceDirectory);
    if (!isWithin(sourceRoot, canonicalDirectory) || excludedPath(canonicalDirectory, excluded)) {
      return;
    }
    if (visitedDirectories.has(canonicalDirectory)) return;
    visitedDirectories.add(canonicalDirectory);

    const directory = await opendir(canonicalDirectory);
    const entries: Dirent[] = [];
    for await (const entry of directory) entries.push(entry);
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) await visitEntry(sourceDirectory, entry);
  }

  async function visitEntry(parent: string, entry: Dirent): Promise<void> {
    const sourcePath = resolve(parent, entry.name);
    const relativePath = normalizeRelativePath(sourceRoot, sourcePath);
    if (!relativePath || matcher.ignores(relativePath, entry.isDirectory())) return;

    let entryStats: BigIntStats | undefined;
    try {
      entryStats = await lstat(sourcePath, { bigint: true });
      const canonicalPath = await realpath(sourcePath);
      if (!isWithin(sourceRoot, canonicalPath)) {
        failures.push({
          sourcePath,
          relativePath,
          error: "A symbolic link points outside the configured source root.",
          stats: entryStats,
        });
        return;
      }
      if (excludedPath(canonicalPath, excluded)) return;

      const targetStats = entryStats.isSymbolicLink()
        ? await stat(canonicalPath, { bigint: true })
        : entryStats;
      if (targetStats.isDirectory()) {
        if (!matcher.ignores(relativePath, true)) await visitDirectory(sourcePath);
      } else if (targetStats.isFile()) {
        candidates.push({ sourcePath, canonicalPath, relativePath });
      }
    } catch (error) {
      failures.push({
        sourcePath,
        relativePath,
        error: safeFileError(error),
        ...(entryStats === undefined ? {} : { stats: entryStats }),
      });
    }
  }

  await visitDirectory(sourceRoot);
  candidates.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
  failures.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
  return { candidates, failures };
}

function fallbackFingerprint(stats?: BigIntStats): FileFingerprint {
  if (stats) return fingerprintMetadata(stats);
  return {
    size: 0,
    modifiedAtMs: 0,
    modifiedAtNs: "0",
    changedAtNs: "0",
    timestampPrecisionMs: 1_000,
  };
}

function failedRecord(root: SourceRoot, failure: CandidateFailure): DiscoveredFile {
  const extension = normalizedExtension(failure.relativePath);
  return {
    fileId: createFileId(root.identity, failure.relativePath),
    rootIdentity: root.identity,
    relativePath: failure.relativePath,
    canonicalPath: failure.sourcePath,
    filename: basename(failure.relativePath),
    extension,
    format: formatForExtension(extension)?.format ?? "unknown",
    mimeFamily: formatForExtension(extension)?.mimeFamily ?? "application/octet-stream",
    fingerprint: fallbackFingerprint(failure.stats),
    readStatus: failure.error.includes("outside") ? "unsafe" : "unreadable",
    indexStatus: "skipped",
    lastError: failure.error,
  };
}

function changedMetadata(left: DiscoveredFile, right: DiscoveredFile): boolean {
  return (
    left.canonicalPath !== right.canonicalPath ||
    left.format !== right.format ||
    left.mimeFamily !== right.mimeFamily ||
    left.readStatus !== right.readStatus ||
    left.indexStatus !== right.indexStatus ||
    left.lastError !== right.lastError ||
    !metadataMatches(left.fingerprint, right.fingerprint)
  );
}

function classify(previous: DiscoveredFile | undefined, current: DiscoveredFile): FileChangeKind {
  if (!previous) return current.readStatus === "ready" ? "added" : "failed";
  if (current.readStatus !== previous.readStatus) {
    return current.readStatus === "ready" ? "content-changed" : "failed";
  }
  if (current.readStatus !== "ready") {
    if (previous.fingerprint.contentHash !== current.fingerprint.contentHash) return "failed";
    return changedMetadata(previous, current) ? "failed" : "unchanged";
  }
  if (previous.fingerprint.contentHash !== current.fingerprint.contentHash) {
    return "content-changed";
  }
  return changedMetadata(previous, current) ? "metadata-only" : "unchanged";
}

function makeChange(
  kind: FileChangeKind,
  source: FileChangeSource,
  current: DiscoveredFile | undefined,
  previous: DiscoveredFile | undefined,
): FileChange {
  const selected = current ?? previous;
  if (!selected) throw new Error("A file change requires a current or previous record.");
  return {
    kind,
    source,
    fileId: selected.fileId,
    relativePath: selected.relativePath,
    ...(current === undefined ? {} : { current }),
    ...(previous === undefined ? {} : { previous }),
    ...(kind === "failed" && current?.lastError ? { error: current.lastError } : {}),
  };
}

export class RepositoryScanner implements FileScanner {
  readonly #root: SourceRoot;
  readonly #manifest: FileManifest;
  readonly #concurrency: number;
  readonly #matcher: IgnoreMatcher;
  readonly #excluded: readonly string[];
  readonly #startupState: StartupStateStore | undefined;
  readonly #progressListeners = new Set<(progress: DiscoveryProgress) => void>();
  #activeScan: Promise<Result<DiscoveryScanResult, DiscoveryError>> | undefined;

  constructor(root: SourceRoot, manifest: FileManifest, options: DiscoveryScannerOptions = {}) {
    this.#root = root;
    this.#manifest = manifest;
    this.#concurrency = Math.max(1, Math.floor(options.concurrency ?? 8));
    this.#matcher = createIgnoreMatcher(options.ignorePatterns);
    this.#excluded = (options.excludedCanonicalPaths ?? []).map((path) => resolve(path));
    this.#startupState = options.startupState;
  }

  scan(source: FileChangeSource = "scan"): Promise<Result<DiscoveryScanResult, DiscoveryError>> {
    if (this.#activeScan) return this.#activeScan;
    this.#activeScan = this.#performScan(source).finally(() => {
      this.#activeScan = undefined;
    });
    return this.#activeScan;
  }

  subscribeProgress(listener: (progress: DiscoveryProgress) => void): () => void {
    this.#progressListeners.add(listener);
    return () => this.#progressListeners.delete(listener);
  }

  #emit(progress: DiscoveryProgress): void {
    for (const listener of this.#progressListeners) listener(progress);
  }

  async #performScan(
    source: FileChangeSource,
  ): Promise<Result<DiscoveryScanResult, DiscoveryError>> {
    let walked: WalkResult;
    try {
      walked = await walkRoot(this.#root.path, this.#matcher, this.#excluded);
    } catch {
      const error: DiscoveryError = {
        code: "DISCOVERY_ROOT_UNAVAILABLE",
        message: "The configured source root could not be scanned.",
      };
      this.#startupState?.dispatch({ type: "fatal_error", error });
      return err(error);
    }

    const previousFiles = this.#manifest.snapshot();
    const previousById = new Map(previousFiles.map((file) => [file.fileId, file]));
    const total = walked.candidates.length + walked.failures.length;
    let completed = 0;
    let unchanged = 0;
    let failed = 0;
    this.#emit({
      phase: "scanning",
      discovered: total,
      unchanged,
      pending: total,
      failed: 0,
      removed: 0,
    });

    const inspected = await mapConcurrent(
      walked.candidates,
      this.#concurrency,
      async (candidate) => {
        const fileId = createFileId(this.#root.identity, candidate.relativePath);
        const previous = previousById.get(fileId);
        const extension = normalizedExtension(candidate.relativePath);
        const knownFormat = formatForExtension(extension);
        let currentStats: BigIntStats | undefined;
        let record: DiscoveredFile;
        try {
          currentStats = await stat(candidate.canonicalPath, { bigint: true });
          const currentMetadata = fingerprintMetadata(currentStats);
          const canReuse =
            previous?.fingerprint.contentHash !== undefined &&
            previous.readStatus !== "unreadable" &&
            previous.readStatus !== "unsafe" &&
            metadataMatches(previous.fingerprint, currentMetadata) &&
            currentMetadata.timestampPrecisionMs < 1_000;
          if (canReuse) {
            record = {
              ...previous,
              canonicalPath: candidate.canonicalPath,
              fingerprint: previous.fingerprint,
            };
          } else {
            const fingerprint = await fingerprintFile(
              candidate.sourcePath,
              candidate.canonicalPath,
              knownFormat,
            );
            record = {
              fileId,
              rootIdentity: this.#root.identity,
              relativePath: candidate.relativePath,
              canonicalPath: candidate.canonicalPath,
              filename: basename(candidate.relativePath),
              extension,
              format: fingerprint.descriptor.format,
              mimeFamily: fingerprint.descriptor.mimeFamily,
              fingerprint: fingerprint.fingerprint,
              readStatus: fingerprint.status,
              indexStatus: fingerprint.status === "ready" ? "pending" : "skipped",
              ...(fingerprint.error === undefined ? {} : { lastError: fingerprint.error }),
            };
          }
        } catch (error) {
          record = failedRecord(this.#root, {
            sourcePath: candidate.sourcePath,
            relativePath: candidate.relativePath,
            error: safeFileError(error),
            ...(currentStats === undefined ? {} : { stats: currentStats }),
          });
        }
        const kind = classify(previous, record);
        completed += 1;
        if (kind === "unchanged") unchanged += 1;
        if (record.readStatus !== "ready") failed += 1;
        this.#emit({
          phase: "scanning",
          discovered: total,
          unchanged,
          pending: total - completed,
          failed,
          removed: 0,
        });
        return { record, change: makeChange(kind, source, record, previous) };
      },
    );

    const failureRecords = walked.failures.map((failure) => {
      const record = failedRecord(this.#root, failure);
      const previous = previousById.get(record.fileId);
      const kind = classify(previous, record);
      completed += 1;
      failed += 1;
      this.#emit({
        phase: "scanning",
        discovered: total,
        unchanged,
        pending: total - completed,
        failed,
        removed: 0,
      });
      return { record, change: makeChange(kind, source, record, previous) };
    });

    const currentPairs = [...inspected, ...failureRecords].sort((left, right) =>
      comparePaths(left.record.relativePath, right.record.relativePath),
    );
    const currentIds = new Set(currentPairs.map(({ record }) => record.fileId));
    const deletions = previousFiles
      .filter((file) => !currentIds.has(file.fileId))
      .map((file) => makeChange("deleted", source, undefined, file));
    const changes = [...currentPairs.map(({ change }) => change), ...deletions].sort(
      (left, right) => comparePaths(left.relativePath, right.relativePath),
    );
    const files = currentPairs.map(({ record }) => record);
    const actionable = changes.filter((change) => change.kind !== "unchanged");
    const persisted = await this.#manifest.replace(files, actionable);
    if (!persisted.ok) return persisted;

    for (const change of actionable) {
      if (change.kind === "failed") {
        this.#startupState?.dispatch({
          type: "file_error",
          issue: {
            code: change.current?.readStatus === "unsafe" ? "FILE_PATH_UNSAFE" : "FILE_UNREADABLE",
            message: change.error ?? "A file could not be discovered.",
            fileId: change.fileId,
          },
        });
        if (this.#startupState?.getSnapshot().phase === "degraded") {
          this.#startupState.dispatch({ type: "continue_degraded" });
        }
      }
    }
    if (source === "scan" && this.#startupState?.getSnapshot().phase === "scanning") {
      this.#startupState.dispatch({ type: "scan_completed" });
    }

    const progress: DiscoveryProgress = {
      phase: "complete",
      discovered: total,
      unchanged,
      pending: 0,
      failed,
      removed: deletions.length,
    };
    this.#emit(progress);
    return ok({ files, changes, progress });
  }
}

export function createRepositoryScanner(
  config: AppConfig,
  manifest: FileManifest,
  options: Omit<DiscoveryScannerOptions, "excludedCanonicalPaths"> = {},
): RepositoryScanner {
  return new RepositoryScanner(config.sourceRoots[0], manifest, {
    ...options,
    excludedCanonicalPaths: [config.paths.applicationStateDir, config.paths.applicationCacheDir],
  });
}
