import type { AppConfig } from "../config/index.ts";
import type {
  DiscoveredFile,
  DiscoveryProgress,
  DiscoveryScanResult,
  FileChange,
  FileChangeListener,
  FileManifest,
  FileScanner,
} from "../discovery/index.ts";
import {
  FakeEmbeddingProvider,
  type IndexedChunkRecord,
  type IndexedFileRecord,
  type IndexingProgress,
  type IndexingService,
  type IndexStore,
} from "../indexing/index.ts";
import type { SearchError, SearchRequest, SearchResponse, SearchService } from "../search/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type { ApplicationServices } from "./contracts.ts";

export class MemoryManifest implements FileManifest {
  readonly rootIdentity: string;
  readonly #listeners = new Set<FileChangeListener>();
  #files: DiscoveredFile[];

  constructor(rootIdentity: string, files: readonly DiscoveredFile[] = []) {
    this.rootIdentity = rootIdentity;
    this.#files = [...files];
  }

  snapshot(): readonly DiscoveredFile[] {
    return [...this.#files];
  }

  get(fileId: string): DiscoveredFile | undefined {
    return this.#files.find((file) => file.fileId === fileId);
  }

  async replace(files: readonly DiscoveredFile[], changes: readonly FileChange[]) {
    this.#files = [...files];
    for (const listener of this.#listeners) listener(changes);
    return ok(undefined);
  }

  subscribe(listener: FileChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

const EMPTY_DISCOVERY_PROGRESS: DiscoveryProgress = {
  phase: "complete",
  discovered: 0,
  unchanged: 0,
  pending: 0,
  failed: 0,
  removed: 0,
};

export class FixtureScanner implements FileScanner {
  readonly manifest: MemoryManifest;
  readonly #listeners = new Set<(progress: DiscoveryProgress) => void>();
  changes: FileChange[] = [];
  scans = 0;
  gate: Promise<void> | undefined;
  failure: { readonly code: "DISCOVERY_ROOT_UNAVAILABLE"; readonly message: string } | undefined;

  constructor(manifest: MemoryManifest) {
    this.manifest = manifest;
  }

  async scan(source: "scan" | "watch" | "reconcile" = "scan") {
    this.scans += 1;
    await this.gate;
    if (this.failure) return err(this.failure);
    const progress = {
      ...EMPTY_DISCOVERY_PROGRESS,
      discovered: this.manifest.snapshot().length,
    };
    for (const listener of this.#listeners) listener({ ...progress, phase: "scanning" });
    const changes = this.changes.map((change) => ({ ...change, source }));
    await this.manifest.replace(this.manifest.snapshot(), changes);
    for (const listener of this.#listeners) listener(progress);
    return ok({ files: this.manifest.snapshot(), changes, progress } satisfies DiscoveryScanResult);
  }

  subscribeProgress(listener: (progress: DiscoveryProgress) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export class FixtureWatcher {
  starts = 0;
  stops = 0;
  failStart = false;

  async start(): Promise<void> {
    this.starts += 1;
    if (this.failStart) throw new Error("Fixture watch startup failed.");
  }

  stop(): void {
    this.stops += 1;
  }
}

const COMPLETE_INDEXING_PROGRESS: IndexingProgress = {
  phase: "complete",
  totalFiles: 0,
  processedFiles: 0,
  unchangedFiles: 0,
  skippedFiles: 0,
  failedFiles: 0,
  deletedFiles: 0,
  totalChunks: 0,
  embeddedChunks: 0,
  reusedChunks: 0,
  committedChunks: 0,
  batchesCompleted: 0,
  errors: [],
};

export class FixtureIndexing implements IndexingService {
  readonly #listeners = new Set<(progress: IndexingProgress) => void>();
  indexCalls = 0;
  changeCalls = 0;
  fail = false;

  async indexFiles(files: readonly DiscoveredFile[], options = {}) {
    this.indexCalls += 1;
    return this.#run(files.length, options as { readonly signal?: AbortSignal });
  }

  async applyChanges(changes: readonly FileChange[], options = {}) {
    this.changeCalls += 1;
    return this.#run(changes.length, options as { readonly signal?: AbortSignal });
  }

  subscribeProgress(listener: (progress: IndexingProgress) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #run(totalFiles: number, options: { readonly signal?: AbortSignal }) {
    if (options.signal?.aborted) {
      return err({ code: "INDEXING_CANCELLED" as const, message: "Indexing was cancelled." });
    }
    const progress = { ...COMPLETE_INDEXING_PROGRESS, totalFiles, processedFiles: totalFiles };
    for (const listener of this.#listeners) listener(progress);
    return this.fail
      ? err({ code: "INDEXING_FATAL" as const, message: "Fixture indexing failed." })
      : ok({
          progress,
          timing: {
            totalMs: 0,
            warmUpMs: 0,
            preparationMs: 0,
            embeddingMs: 0,
            commitMs: 0,
            finalizationMs: 0,
          },
        });
  }
}

export class FixtureStore implements IndexStore {
  closes = 0;
  async getFile() {
    return ok(undefined);
  }

  async getFiles() {
    return ok([]);
  }
  async getChunks() {
    return ok([] as IndexedChunkRecord[]);
  }
  async getChunksForFiles() {
    return ok([] as IndexedChunkRecord[]);
  }
  async replaceFile(_file: IndexedFileRecord, _chunks: readonly IndexedChunkRecord[]) {
    return ok(undefined);
  }
  async replaceFiles(
    _entries: readonly {
      readonly file: IndexedFileRecord;
      readonly chunks: readonly IndexedChunkRecord[];
    }[],
  ) {
    return ok(undefined);
  }
  async markFileFailed() {
    return ok(undefined);
  }
  async deleteFile() {
    return ok(undefined);
  }
  async refreshSearchIndexes() {
    return ok(undefined);
  }
  close(): void {
    this.closes += 1;
  }
}

export class FixtureSearch implements SearchService {
  calls = 0;
  delay = false;
  nextError: SearchError | undefined;
  responseFactory: ((request: SearchRequest) => SearchResponse) | undefined;

  async search(
    request: SearchRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<SearchResponse, SearchError>> {
    this.calls += 1;
    if (this.delay) {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    if (options.signal?.aborted) {
      return err({ code: "SEARCH_CANCELLED" as const, message: "Search was cancelled." });
    }
    if (this.nextError) return err(this.nextError);
    if (this.responseFactory) return ok(this.responseFactory(request));
    return ok({
      query: request.query.trim(),
      requestedFileCount: request.fileCount ?? 10,
      formats: request.formats ?? [],
      timing: {
        totalMs: 1,
        embeddingMs: 0,
        retrievalMs: 0,
        vectorMs: 0,
        bm25Ms: 0,
        metadataMs: 0,
        fusionMs: 0,
        aggregationMs: 0,
      },
      results: [],
    } satisfies SearchResponse);
  }
}

export interface FixtureServices extends ApplicationServices {
  readonly embeddings: FakeEmbeddingProvider;
  readonly indexing: FixtureIndexing;
  readonly store: FixtureStore;
  readonly search: FixtureSearch;
  readonly discovery: {
    readonly manifest: MemoryManifest;
    readonly scanner: FixtureScanner;
    readonly watcher: FixtureWatcher;
  };
  readonly searchCloseCount: { value: number };
}

export function fixtureServices(
  config: AppConfig,
  files: readonly DiscoveredFile[] = [],
): FixtureServices {
  const manifest = new MemoryManifest(config.sourceRoots[0].identity, files);
  const scanner = new FixtureScanner(manifest);
  const watcher = new FixtureWatcher();
  const indexing = new FixtureIndexing();
  const store = new FixtureStore();
  const search = new FixtureSearch();
  const embeddings = new FakeEmbeddingProvider({ dimension: config.embedding.vectorDimension });
  const searchCloseCount = { value: 0 };
  return {
    discovery: { manifest, scanner, watcher },
    embeddings,
    indexing,
    store,
    search,
    closeExtraction: async () => undefined,
    closeSearch: () => {
      searchCloseCount.value += 1;
    },
    searchCloseCount,
  };
}
