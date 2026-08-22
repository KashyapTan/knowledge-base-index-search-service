import { basename } from "node:path";
import type { AppConfig, StartupIssue, StartupStateStore } from "../config/index.ts";
import { createDiscoveryService, type FileChange } from "../discovery/index.ts";
import { createWorkerExtractionPipeline, type ExtractionPipeline } from "../extraction/index.ts";
import {
  createIndexingService,
  createTransformersEmbeddingProvider,
  type EmbeddingProvider,
  type IndexingService,
  type IndexStore,
  openLanceIndex,
} from "../indexing/index.ts";
import {
  type CandidateRetriever,
  createSearchService,
  openLanceCandidateRetriever,
  type SearchError,
  type SearchRequest,
  type SearchService,
} from "../search/index.ts";
import { type AppError, err, ok, type Result } from "../shared/result.ts";
import type {
  ApiError,
  ApplicationServices,
  ApplicationServicesFactory,
  ApplicationStatus,
  OpenFileChange,
} from "./contracts.ts";
import { SafeFileAccess } from "./file-access.ts";
import { ApplicationEventHub } from "./progress.ts";

function serviceFailure(error: {
  readonly code: string;
  readonly message: string;
}): Result<never, AppError> {
  return err({ code: error.code, message: error.message });
}

export interface ProductionServiceAdapters {
  createEmbeddings(config: AppConfig): EmbeddingProvider;
  openStore(config: AppConfig): Promise<Result<IndexStore, AppError>>;
  openRetriever(config: AppConfig): Promise<Result<CandidateRetriever, AppError>>;
  createDiscovery(config: AppConfig): Promise<Result<ApplicationServices["discovery"], AppError>>;
  createExtraction(config: AppConfig, maxTokens: number): ExtractionPipeline;
  createIndexing(
    config: AppConfig,
    dependencies: {
      readonly extraction: ExtractionPipeline;
      readonly embeddings: EmbeddingProvider;
      readonly store: IndexStore;
    },
  ): IndexingService;
  createSearch(dependencies: {
    readonly embeddings: EmbeddingProvider;
    readonly retriever: CandidateRetriever;
  }): SearchService;
}

/* c8 ignore start -- Thin production adapters are covered by their owning Plan 3-6 suites. */
const productionAdapters: ProductionServiceAdapters = {
  createEmbeddings: createTransformersEmbeddingProvider,
  openStore: openLanceIndex,
  openRetriever: openLanceCandidateRetriever,
  createDiscovery: createDiscoveryService,
  createExtraction: createWorkerExtractionPipeline,
  createIndexing: createIndexingService,
  createSearch: createSearchService,
};
/* c8 ignore stop */

export async function createProductionServices(
  config: AppConfig,
  signal: AbortSignal,
  adapters: ProductionServiceAdapters = productionAdapters,
): Promise<Result<ApplicationServices, AppError>> {
  const embeddings = adapters.createEmbeddings(config);
  let store: IndexStore | undefined;
  let retriever: CandidateRetriever | undefined;
  let extraction: ExtractionPipeline | undefined;
  let completed = false;
  try {
    if (signal.aborted) {
      return serviceFailure({ code: "STARTUP_CANCELLED", message: "Startup was cancelled." });
    }
    const warm = await embeddings.warmUp({
      allowDownload: !config.offline,
      downloadRetries: 2,
      recoverCorruptAssets: !config.offline,
    });
    if (!warm.ok) return serviceFailure(warm.error);
    if (signal.aborted) {
      return serviceFailure({ code: "STARTUP_CANCELLED", message: "Startup was cancelled." });
    }
    const openedStore = await adapters.openStore(config);
    if (!openedStore.ok) return serviceFailure(openedStore.error);
    store = openedStore.value;
    const openedRetriever = await adapters.openRetriever(config);
    if (!openedRetriever.ok) {
      store.close();
      return serviceFailure(openedRetriever.error);
    }
    retriever = openedRetriever.value;
    const discovery = await adapters.createDiscovery(config);
    if (!discovery.ok) {
      retriever.close();
      store.close();
      return serviceFailure(discovery.error);
    }
    extraction = adapters.createExtraction(config, embeddings.identity.maximumTokens);
    const indexing = adapters.createIndexing(config, { extraction, embeddings, store });
    const activeRetriever = retriever;
    completed = true;
    return ok({
      discovery: discovery.value,
      embeddings,
      indexing,
      store,
      search: adapters.createSearch({ embeddings, retriever: activeRetriever }),
      closeExtraction: async () => extraction?.shutdown?.(),
      closeSearch: () => activeRetriever.close(),
    });
  } catch {
    retriever?.close();
    store?.close();
    return serviceFailure({
      code: "STARTUP_FAILED",
      message: "The local index services could not be initialized.",
    });
  } finally {
    if (!completed) {
      await extraction?.shutdown?.();
      await embeddings.shutdown();
    }
  }
}

function searchApiError(error: SearchError): ApiError {
  switch (error.code) {
    case "SEARCH_QUERY_INVALID":
    case "SEARCH_REQUEST_INVALID":
      return { code: "REQUEST_BODY_INVALID", message: error.message, status: 400 };
    case "SEARCH_CANCELLED":
      return { code: "SEARCH_CANCELLED", message: error.message, status: 499 };
    case "SEARCH_INDEX_UNAVAILABLE":
      return { code: "SEARCH_UNAVAILABLE", message: error.message, status: 503 };
    default:
      return { code: "SEARCH_FAILED", message: error.message, status: 500 };
  }
}

function runtimeError(code: ApiError["code"], message: string, status: number): ApiError {
  return { code, message, status };
}

export class ApplicationRuntime {
  readonly config: AppConfig;
  readonly state: StartupStateStore;
  readonly events: ApplicationEventHub;
  readonly csrfToken: string;
  readonly #factory: ApplicationServicesFactory;
  readonly #lifecycleController = new AbortController();
  readonly #activeSearchControllers = new Set<AbortController>();
  readonly #activeSearches = new Set<Promise<unknown>>();
  readonly #unsubscribers: Array<() => void> = [];
  readonly #maxConcurrentSearches: number;
  #services: ApplicationServices | undefined;
  #fileAccess: SafeFileAccess | undefined;
  #discoveryProgress: ApplicationStatus["discovery"];
  #indexingProgress: ApplicationStatus["indexing"];
  #initializePromise: Promise<void> | undefined;
  #indexTail: Promise<void> = Promise.resolve();
  #actionInProgress = false;
  #shuttingDown = false;
  #closed = false;

  constructor(
    config: AppConfig,
    state: StartupStateStore,
    options: {
      readonly csrfToken?: string;
      readonly events?: ApplicationEventHub;
      readonly factory?: ApplicationServicesFactory;
      readonly maxConcurrentSearches?: number;
    } = {},
  ) {
    this.config = config;
    this.state = state;
    this.csrfToken = options.csrfToken ?? crypto.randomUUID();
    this.events = options.events ?? new ApplicationEventHub();
    this.#factory = options.factory ?? createProductionServices;
    this.#maxConcurrentSearches = Math.max(1, options.maxConcurrentSearches ?? 4);
    this.#unsubscribers.push(
      state.subscribe((startup) => this.events.publish({ type: "startup", startup })),
    );
  }

  status(): ApplicationStatus {
    return {
      sourceRootLabel: basename(this.config.sourceRoots[0].path) || "Configured source",
      startup: this.state.getSnapshot(),
      ...(this.#discoveryProgress ? { discovery: this.#discoveryProgress } : {}),
      ...(this.#indexingProgress ? { indexing: this.#indexingProgress } : {}),
      searchAvailable: this.#services !== undefined && !this.#shuttingDown,
      actionInProgress: this.#actionInProgress,
      shuttingDown: this.#shuttingDown,
      csrfToken: this.csrfToken,
    };
  }

  initialize(): Promise<void> {
    this.#initializePromise ??= this.#performInitialize();
    return this.#initializePromise;
  }

  async #performInitialize(): Promise<void> {
    const created = await this.#factory(this.config, this.#lifecycleController.signal);
    if (!created.ok) {
      this.#fatal(created.error);
      return;
    }
    if (this.#shuttingDown) {
      await this.#closeServices(created.value);
      return;
    }
    this.#services = created.value;
    this.#fileAccess = new SafeFileAccess(
      this.config.sourceRoots[0],
      created.value.discovery.manifest,
    );
    this.events.publish({ type: "snapshot", status: this.status() });
    const { discovery, indexing } = created.value;
    this.#unsubscribers.push(
      discovery.scanner.subscribeProgress((progress) => {
        this.#discoveryProgress = progress;
        this.events.publish({ type: "discovery", progress });
      }),
      indexing.subscribeProgress((progress) => {
        this.#indexingProgress = progress;
        this.events.publish({ type: "indexing", progress });
      }),
    );
    let acceptingChanges = false;
    this.#unsubscribers.push(
      discovery.manifest.subscribe((changes) => {
        if (!acceptingChanges) return;
        const notifications: OpenFileChange[] = [];
        for (const change of changes) {
          if (change.kind === "deleted") {
            notifications.push({ fileId: change.fileId, kind: "deleted" });
          }
          if (
            change.kind === "content-changed" ||
            change.kind === "metadata-only" ||
            change.kind === "failed"
          ) {
            notifications.push({ fileId: change.fileId, kind: "changed" });
          }
        }
        if (notifications.length > 0) {
          this.events.publish({ type: "files", changes: notifications });
        }
        this.#enqueueChanges(changes);
      }),
    );

    if (!this.#dispatch({ type: "model_loaded" })) return;
    const scan = await discovery.scanner.scan("scan");
    if (!scan.ok) {
      this.#fatal(scan.error);
      return;
    }
    if (!this.#dispatch({ type: "scan_completed" })) return;
    await this.#enqueueIndex(() =>
      indexing.indexFiles(scan.value.files, { signal: this.#lifecycleController.signal }),
    );
    if (this.#lifecycleController.signal.aborted) return;
    if (!this.#dispatch({ type: "index_committed" })) return;
    acceptingChanges = true;
    try {
      await discovery.watcher.start({ scanInitially: false });
    } catch {
      this.#issue({ code: "WATCH_START_FAILED", message: "File watching could not be started." });
    }
  }

  async search(
    request: SearchRequest,
    requestSignal: AbortSignal,
  ): Promise<Result<import("../search/index.ts").SearchResponse, ApiError>> {
    if (this.#shuttingDown) {
      return err(
        runtimeError("APPLICATION_SHUTTING_DOWN", "The application is shutting down.", 503),
      );
    }
    if (!this.#services) {
      return err(runtimeError("SEARCH_UNAVAILABLE", "Search is not ready yet.", 503));
    }
    if (this.#activeSearchControllers.size >= this.#maxConcurrentSearches) {
      return err(runtimeError("SEARCH_BUSY", "Too many searches are already running.", 429));
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (requestSignal.aborted) controller.abort();
    else requestSignal.addEventListener("abort", abort, { once: true });
    this.#activeSearchControllers.add(controller);
    const operation = this.#services.search.search(request, { signal: controller.signal });
    this.#activeSearches.add(operation);
    try {
      const result = await operation;
      return result.ok ? result : err(searchApiError(result.error));
    } finally {
      requestSignal.removeEventListener("abort", abort);
      this.#activeSearchControllers.delete(controller);
      this.#activeSearches.delete(operation);
    }
  }

  fileMetadata(fileId: string) {
    return this.#fileAccess?.metadata(fileId);
  }

  fileContent(fileId: string) {
    return this.#fileAccess?.content(fileId);
  }

  async runAction(mode: "reconcile" | "reindex"): Promise<Result<void, ApiError>> {
    if (this.#shuttingDown) {
      return err(
        runtimeError("APPLICATION_SHUTTING_DOWN", "The application is shutting down.", 503),
      );
    }
    if (!this.#services) {
      return err(runtimeError("ACTION_BUSY", "Index services are not ready yet.", 409));
    }
    const services = this.#services;
    if (this.#actionInProgress) {
      return err(runtimeError("ACTION_BUSY", "Another index action is already running.", 409));
    }
    this.#actionInProgress = true;
    this.events.publish({ type: "snapshot", status: this.status() });
    try {
      if (mode === "reconcile") {
        const scan = await services.discovery.scanner.scan("reconcile");
        if (!scan.ok) {
          this.#issue(scan.error);
          return err(runtimeError("INTERNAL_ERROR", scan.error.message, 500));
        }
        await this.#indexTail;
      } else {
        await this.#enqueueIndex(() =>
          services.indexing.indexFiles(services.discovery.manifest.snapshot(), {
            signal: this.#lifecycleController.signal,
          }),
        );
      }
      return ok(undefined);
    } finally {
      this.#actionInProgress = false;
      this.events.publish({ type: "snapshot", status: this.status() });
    }
  }

  #enqueueChanges(changes: readonly FileChange[]): void {
    if (changes.length === 0 || !this.#services || this.#shuttingDown) return;
    const services = this.#services;
    void this.#enqueueIndex(() =>
      services.indexing.applyChanges(changes, { signal: this.#lifecycleController.signal }),
    );
  }

  #enqueueIndex(
    operation: () => Promise<Result<unknown, { readonly code: string; readonly message: string }>>,
  ): Promise<void> {
    const next = this.#indexTail.then(async () => {
      if (this.#lifecycleController.signal.aborted) return;
      const result = await operation();
      if (!result.ok && result.error.code !== "INDEXING_CANCELLED") this.#issue(result.error);
    });
    this.#indexTail = next.catch(() => {
      this.#issue({ code: "INDEXING_FATAL", message: "Background indexing failed unexpectedly." });
    });
    return this.#indexTail;
  }

  #dispatch(event: Parameters<StartupStateStore["dispatch"]>[0]): boolean {
    const result = this.state.dispatch(event);
    if (result.ok) return true;
    this.#fatal(result.error);
    return false;
  }

  #issue(issue: StartupIssue): void {
    this.events.publish({ type: "issue", issue });
    const phase = this.state.getSnapshot().phase;
    if (phase === "scanning" || phase === "indexing" || phase === "ready") {
      this.state.dispatch({ type: "file_error", issue });
      if (this.state.getSnapshot().phase === "degraded") {
        this.state.dispatch({ type: "continue_degraded" });
      }
    }
  }

  #fatal(error: { readonly code: string; readonly message: string }): void {
    this.state.dispatch({ type: "fatal_error", error });
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#shuttingDown = true;
    this.events.publish({ type: "snapshot", status: this.status() });
    this.#services?.discovery.watcher.stop();
    this.#lifecycleController.abort();
    for (const controller of this.#activeSearchControllers) controller.abort();
    await Promise.allSettled([...this.#activeSearches]);
    await this.#initializePromise;
    await this.#indexTail;
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    if (this.#services) await this.#closeServices(this.#services);
    this.#services = undefined;
    this.#fileAccess = undefined;
    this.events.close();
  }

  async #closeServices(services: ApplicationServices): Promise<void> {
    services.discovery.watcher.stop();
    services.closeSearch();
    services.store.close();
    await services.closeExtraction();
    await services.embeddings.shutdown();
  }
}
