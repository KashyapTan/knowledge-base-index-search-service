import { join } from "node:path";
import type { AppConfig } from "../config/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type { DiscoveryError } from "./contracts.ts";
import { JsonFileManifest } from "./manifest.ts";
import { createRepositoryScanner, type DiscoveryScannerOptions } from "./scanner.ts";
import { DiscoveryWatcher, type DiscoveryWatcherOptions } from "./watcher.ts";

export type {
  DiscoveredFile,
  DiscoveryError,
  DiscoveryErrorCode,
  DiscoveryProgress,
  DiscoveryScanResult,
  FileChange,
  FileChangeKind,
  FileChangeListener,
  FileChangeSource,
  FileFingerprint,
  FileFormat,
  FileIndexStatus,
  FileManifest,
  FileReadStatus,
  FileScanner,
  RawWatchEvent,
  WatchSource,
  WatchSubscription,
} from "./contracts.ts";
export { fingerprintFile, fingerprintMetadata, metadataMatches } from "./fingerprint.ts";
export { formatForExtension, inspectTextBytes, normalizedExtension } from "./formats.ts";
export { createFileId, normalizeRelativePath } from "./identity.ts";
export { createIgnoreMatcher, type IgnoreMatcher } from "./ignore.ts";
export { JsonFileManifest } from "./manifest.ts";
export {
  createRepositoryScanner,
  type DiscoveryScannerOptions,
  RepositoryScanner,
} from "./scanner.ts";
export {
  DiscoveryWatcher,
  type DiscoveryWatcherOptions,
  NativeWatchSource,
  type WatchScheduler,
} from "./watcher.ts";

export interface DiscoveryService {
  readonly manifest: JsonFileManifest;
  readonly scanner: ReturnType<typeof createRepositoryScanner>;
  readonly watcher: DiscoveryWatcher;
}

export async function createDiscoveryService(
  config: AppConfig,
  options: {
    readonly scanner?: Omit<DiscoveryScannerOptions, "excludedCanonicalPaths">;
    readonly watcher?: DiscoveryWatcherOptions;
  } = {},
): Promise<Result<DiscoveryService, DiscoveryError>> {
  const manifestResult = await JsonFileManifest.open(
    join(config.paths.indexMetadataDir, "file-manifest.json"),
    config.sourceRoots[0].identity,
  );
  if (!manifestResult.ok) return err(manifestResult.error);
  const scanner = createRepositoryScanner(config, manifestResult.value, options.scanner);
  return ok({
    manifest: manifestResult.value,
    scanner,
    watcher: new DiscoveryWatcher(config.sourceRoots[0].path, scanner, options.watcher),
  });
}
