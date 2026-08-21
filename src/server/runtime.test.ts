import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialStartupState, StartupStateStore } from "../config/index.ts";
import { FakeEmbeddingProvider } from "../indexing/index.ts";
import { indexableFile, indexingConfig } from "../indexing/test-helpers.ts";
import { err, ok } from "../shared/result.ts";
import { ApplicationEventHub } from "./progress.ts";
import {
  ApplicationRuntime,
  createProductionServices,
  type ProductionServiceAdapters,
} from "./runtime.ts";
import { fixtureServices } from "./test-helpers.ts";

let fixtureDir = "";
const runtimes: ApplicationRuntime[] = [];

beforeEach(async () => {
  fixtureDir = await realpath(await mkdtemp(join(tmpdir(), "kbiss-runtime-test-")));
  await Promise.all([
    mkdir(join(fixtureDir, "root")),
    mkdir(join(fixtureDir, "state")),
    mkdir(join(fixtureDir, "cache")),
  ]);
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  await rm(fixtureDir, { recursive: true, force: true });
});

function setup() {
  const config = indexingConfig(
    join(fixtureDir, "root"),
    join(fixtureDir, "state"),
    join(fixtureDir, "cache"),
  );
  const state = new StartupStateStore(initialStartupState());
  state.dispatch({ type: "begin_validation" });
  state.dispatch({ type: "configuration_validated" });
  return { config, state };
}

function adapters(
  config: ReturnType<typeof setup>["config"],
  options: { readonly embeddings?: FakeEmbeddingProvider } = {},
): {
  readonly value: ProductionServiceAdapters;
  readonly services: ReturnType<typeof fixtureServices>;
  readonly retrieverCloses: { value: number };
} {
  const services = fixtureServices(config);
  const embeddings = options.embeddings ?? services.embeddings;
  const retrieverCloses = { value: 0 };
  return {
    services,
    retrieverCloses,
    value: {
      createEmbeddings: () => embeddings,
      loadTokenCounter: async () => ({ count: () => 1 }),
      openStore: async () => ok(services.store),
      openRetriever: async () =>
        ok({
          async retrieve() {
            return ok({
              vector: [],
              bm25: [],
              metadata: [],
              timing: { totalMs: 0, vectorMs: 0, bm25Ms: 0, metadataMs: 0 },
            });
          },
          close() {
            retrieverCloses.value += 1;
          },
        }),
      createDiscovery: async () => ok(services.discovery),
      createExtraction: () => ({
        async process() {
          throw new Error("The fixture extraction pipeline is not invoked by composition.");
        },
      }),
      createIndexing: () => services.indexing,
      createSearch: () => services.search,
    },
  };
}

describe("application lifecycle", () => {
  test("composes production service ownership and cleans up every failed startup stage", async () => {
    const { config } = setup();
    const success = adapters(config);
    const created = await createProductionServices(
      config,
      new AbortController().signal,
      success.value,
    );
    expect(created.ok).toBe(true);
    if (created.ok) {
      created.value.closeSearch();
      created.value.store.close();
      await created.value.embeddings.shutdown();
    }
    expect(success.retrieverCloses.value).toBe(1);

    const cancelled = adapters(config);
    const cancelledController = new AbortController();
    cancelledController.abort();
    expect(
      await createProductionServices(config, cancelledController.signal, cancelled.value),
    ).toMatchObject({ ok: false, error: { code: "STARTUP_CANCELLED" } });
    expect(cancelled.services.embeddings.shutdownCalls).toBe(1);

    const warmFailureProvider = new FakeEmbeddingProvider({ failWarmUp: true });
    const warmFailure = adapters(config, { embeddings: warmFailureProvider });
    expect(
      await createProductionServices(config, new AbortController().signal, warmFailure.value),
    ).toMatchObject({ ok: false, error: { code: "MODEL_ASSETS_MISSING" } });
    expect(warmFailureProvider.shutdownCalls).toBe(1);

    const midStartup = adapters(config);
    const midStartupController = new AbortController();
    midStartup.value.loadTokenCounter = async () => {
      midStartupController.abort();
      return { count: () => 1 };
    };
    expect(
      await createProductionServices(config, midStartupController.signal, midStartup.value),
    ).toMatchObject({ ok: false, error: { code: "STARTUP_CANCELLED" } });

    const storeFailure = adapters(config);
    storeFailure.value.openStore = async () =>
      err({ code: "INDEX_OPEN_FAILED", message: "Store unavailable." });
    expect(
      await createProductionServices(config, new AbortController().signal, storeFailure.value),
    ).toMatchObject({ ok: false, error: { code: "INDEX_OPEN_FAILED" } });

    const retrieverFailure = adapters(config);
    retrieverFailure.value.openRetriever = async () =>
      err({ code: "SEARCH_INDEX_UNAVAILABLE", message: "Retriever unavailable." });
    expect(
      await createProductionServices(config, new AbortController().signal, retrieverFailure.value),
    ).toMatchObject({ ok: false, error: { code: "SEARCH_INDEX_UNAVAILABLE" } });
    expect(retrieverFailure.services.store.closes).toBe(1);

    const discoveryFailure = adapters(config);
    discoveryFailure.value.createDiscovery = async () =>
      err({ code: "DISCOVERY_ROOT_UNAVAILABLE", message: "Discovery unavailable." });
    expect(
      await createProductionServices(config, new AbortController().signal, discoveryFailure.value),
    ).toMatchObject({ ok: false, error: { code: "DISCOVERY_ROOT_UNAVAILABLE" } });
    expect(discoveryFailure.retrieverCloses.value).toBe(1);
    expect(discoveryFailure.services.store.closes).toBe(1);

    const thrown = adapters(config);
    thrown.value.loadTokenCounter = () => Promise.reject(new Error("private path"));
    expect(
      await createProductionServices(config, new AbortController().signal, thrown.value),
    ).toMatchObject({ ok: false, error: { code: "STARTUP_FAILED" } });
  });

  test("reports unavailable operations until initialized and is idempotent", async () => {
    const { config, state } = setup();
    const services = fixtureServices(config);
    const events = new ApplicationEventHub({ heartbeatMs: 60_000 });
    const runtime = new ApplicationRuntime(config, state, {
      factory: async () => ok(services),
      events,
    });
    runtimes.push(runtime);
    expect(await runtime.search({ query: "x" }, new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: "SEARCH_UNAVAILABLE" },
    });
    expect(await runtime.runAction("reindex")).toMatchObject({
      ok: false,
      error: { code: "ACTION_BUSY" },
    });
    await Promise.all([runtime.initialize(), runtime.initialize()]);
    expect(runtime.status()).toMatchObject({ startup: { phase: "ready" }, searchAvailable: true });
    expect(services.discovery.watcher.starts).toBe(1);
    const marker = events.publish({ type: "issue", issue: { code: "MARKER", message: "marker" } });
    const changed = indexableFile("changed.md", "hash");
    await services.discovery.manifest.replace(
      [changed],
      [
        {
          kind: "content-changed",
          fileId: changed.fileId,
          relativePath: changed.relativePath,
          source: "watch",
          current: changed,
          previous: changed,
        },
      ],
    );
    const eventReader = events.stream(marker.id, () => runtime.status()).getReader();
    const fileEvent = new TextDecoder().decode((await eventReader.read()).value);
    expect(fileEvent).toContain('"type":"files"');
    expect(fileEvent).toContain(`"fileId":"${changed.fileId}"`);
    await eventReader.cancel();
    await Bun.sleep(1);
    expect(services.indexing.changeCalls).toBe(1);
  });

  test("maps factory and scan failures into display-safe startup errors", async () => {
    const first = setup();
    const factoryFailure = new ApplicationRuntime(first.config, first.state, {
      factory: async () => err({ code: "SETUP_FAILED", message: "Safe setup failure." }),
    });
    runtimes.push(factoryFailure);
    await factoryFailure.initialize();
    expect(factoryFailure.status().startup).toMatchObject({
      phase: "error",
      error: { code: "SETUP_FAILED" },
    });

    const second = setup();
    const services = fixtureServices(second.config);
    services.discovery.scanner.failure = {
      code: "DISCOVERY_ROOT_UNAVAILABLE",
      message: "The root cannot be scanned.",
    };
    const scanFailure = new ApplicationRuntime(second.config, second.state, {
      factory: async () => ok(services),
    });
    runtimes.push(scanFailure);
    await scanFailure.initialize();
    expect(scanFailure.status().startup).toMatchObject({
      phase: "error",
      error: { code: "DISCOVERY_ROOT_UNAVAILABLE" },
    });
  });

  test("keeps per-run indexing failures observable without losing readiness", async () => {
    const { config, state } = setup();
    const services = fixtureServices(config);
    services.indexing.fail = true;
    const runtime = new ApplicationRuntime(config, state, { factory: async () => ok(services) });
    runtimes.push(runtime);
    await runtime.initialize();
    expect(runtime.status().startup).toMatchObject({
      phase: "ready",
      issues: [{ code: "INDEXING_FATAL" }],
    });
    expect(await runtime.runAction("reindex")).toEqual({ ok: true, value: undefined });
    expect(runtime.status().actionInProgress).toBe(false);
  });

  test("reports watcher failure and rejects overlapping manual reconciliation", async () => {
    const { config, state } = setup();
    const services = fixtureServices(config);
    services.discovery.watcher.failStart = true;
    const runtime = new ApplicationRuntime(config, state, { factory: async () => ok(services) });
    runtimes.push(runtime);
    await runtime.initialize();
    expect(runtime.status().startup.issues).toContainEqual({
      code: "WATCH_START_FAILED",
      message: "File watching could not be started.",
    });

    let release = () => {};
    services.discovery.scanner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runtime.runAction("reconcile");
    await Bun.sleep(1);
    expect(await runtime.runAction("reindex")).toMatchObject({
      ok: false,
      error: { code: "ACTION_BUSY" },
    });
    release();
    expect(await first).toEqual({ ok: true, value: undefined });

    services.discovery.scanner.gate = undefined;
    services.discovery.scanner.failure = {
      code: "DISCOVERY_ROOT_UNAVAILABLE",
      message: "Manual scan failed.",
    };
    expect(await runtime.runAction("reconcile")).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
  });

  test("maps request cancellation and search failures without exposing internals", async () => {
    const { config, state } = setup();
    const services = fixtureServices(config);
    services.search.nextError = {
      code: "SEARCH_INDEX_UNAVAILABLE",
      message: "Index unavailable.",
    };
    const runtime = new ApplicationRuntime(config, state, { factory: async () => ok(services) });
    runtimes.push(runtime);
    await runtime.initialize();
    expect(await runtime.search({ query: "x" }, new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: "SEARCH_UNAVAILABLE", status: 503 },
    });

    services.search.nextError = { code: "SEARCH_QUERY_INVALID", message: "Invalid query." };
    expect(await runtime.search({ query: "" }, new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: "REQUEST_BODY_INVALID", status: 400 },
    });
  });

  test("rejects new work after shutdown and closes resources exactly once", async () => {
    const { config, state } = setup();
    const services = fixtureServices(config);
    const runtime = new ApplicationRuntime(config, state, { factory: async () => ok(services) });
    await runtime.initialize();
    await Promise.all([runtime.shutdown(), runtime.shutdown()]);
    expect(await runtime.search({ query: "x" }, new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: "APPLICATION_SHUTTING_DOWN" },
    });
    expect(await runtime.runAction("reconcile")).toMatchObject({
      ok: false,
      error: { code: "APPLICATION_SHUTTING_DOWN" },
    });
    expect(services.store.closes).toBe(1);
  });
});
