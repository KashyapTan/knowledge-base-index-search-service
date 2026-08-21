import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialStartupState, StartupStateStore } from "../config/index.ts";
import { indexableFile, indexingConfig } from "../indexing/test-helpers.ts";
import { ok } from "../shared/result.ts";
import {
  API_PREFIX,
  ApplicationRuntime,
  createApplicationServer,
  createFoundationServer,
  type StartedApplication,
  startApplication,
} from "./index.ts";
import { type FixtureServices, fixtureServices } from "./test-helpers.ts";

let fixtureDir = "";
const servers: Bun.Server<undefined>[] = [];
const runtimes: ApplicationRuntime[] = [];
const applications: StartedApplication[] = [];

beforeEach(async () => {
  fixtureDir = await realpath(await mkdtemp(join(tmpdir(), "kbiss-api-test-")));
  await Promise.all([
    mkdir(join(fixtureDir, "root")),
    mkdir(join(fixtureDir, "state")),
    mkdir(join(fixtureDir, "cache")),
    mkdir(join(fixtureDir, "ui")),
    mkdir(join(fixtureDir, "project")),
  ]);
  await Promise.all([
    writeFile(join(fixtureDir, "ui", "index.html"), "<main>KBISS</main>"),
    writeFile(join(fixtureDir, "ui", "app.js"), "export {};"),
  ]);
});

afterEach(async () => {
  for (const application of applications.splice(0)) await application.shutdown();
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const server of servers.splice(0)) await server.stop(true);
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

async function fixtureRuntime(): Promise<{
  readonly runtime: ApplicationRuntime;
  readonly services: FixtureServices;
  readonly fileId: string;
}> {
  const root = join(fixtureDir, "root");
  const path = join(root, "guide.md");
  await writeFile(path, "# Guide\nstreamed file body\n");
  const config = indexingConfig(root, join(fixtureDir, "state"), join(fixtureDir, "cache"));
  const file = indexableFile("guide.md", "content-hash", {
    canonicalPath: path,
    rootIdentity: config.sourceRoots[0].identity,
    fingerprint: {
      size: 27,
      modifiedAtMs: 10,
      modifiedAtNs: "10000000",
      changedAtNs: "10000000",
      timestampPrecisionMs: 1,
      contentHash: "content-hash",
    },
  });
  const services = fixtureServices(config, [file]);
  const state = new StartupStateStore(initialStartupState());
  state.dispatch({ type: "begin_validation" });
  state.dispatch({ type: "configuration_validated" });
  const runtime = new ApplicationRuntime(config, state, {
    csrfToken: "fixture-csrf",
    factory: async () => ok(services),
    maxConcurrentSearches: 1,
  });
  runtimes.push(runtime);
  return { runtime, services, fileId: file.fileId };
}

async function startFixtureServer() {
  const fixture = await fixtureRuntime();
  const server = createApplicationServer(fixture.runtime, {
    port: 0,
    uiDistDir: join(fixtureDir, "ui"),
  });
  servers.push(server);
  await fixture.runtime.initialize();
  return { ...fixture, server };
}

describe("Plan 7 Bun API", () => {
  test("serves health, status, production assets, and SPA fallback without swallowing API errors", async () => {
    const { server } = await startFixtureServer();
    const health = await fetch(new URL(`${API_PREFIX}/health`, server.url));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ service: "kbiss", status: "ok", phase: "ready" });
    expect(health.headers.get("content-security-policy")).toContain("default-src 'none'");

    const status = await fetch(new URL(`${API_PREFIX}/status`, server.url));
    expect(await status.json()).toMatchObject({
      sourceRootLabel: "root",
      startup: { phase: "ready" },
      searchAvailable: true,
    });
    expect(await (await fetch(server.url)).text()).toBe("<main>KBISS</main>");
    expect(await (await fetch(new URL("/app.js", server.url))).text()).toBe("export {};");
    expect(await (await fetch(new URL("/search/results", server.url))).text()).toBe(
      "<main>KBISS</main>",
    );
    expect((await fetch(new URL(`${API_PREFIX}/missing`, server.url))).status).toBe(404);
    expect((await fetch(new URL("/missing.txt", server.url))).status).toBe(404);
    expect((await fetch(new URL("/%E0%A4%A", server.url))).status).toBe(400);
    expect((await fetch(new URL("/%00", server.url))).status).toBe(404);
    expect((await fetch(new URL("/..%2Fsecret.txt", server.url))).status).toBe(404);
    expect((await fetch(server.url, { method: "POST" })).status).toBe(405);
    expect(
      (await fetch(new URL(`${API_PREFIX}/status`, server.url), { method: "POST" })).status,
    ).toBe(405);
    expect(
      (await fetch(new URL(`${API_PREFIX}/events`, server.url), { method: "POST" })).status,
    ).toBe(405);
  });

  test("validates methods, content type, JSON shape, body limits, Host, and Origin", async () => {
    const { server } = await startFixtureServer();
    const searchUrl = new URL(`${API_PREFIX}/search`, server.url);
    expect((await fetch(searchUrl)).status).toBe(405);
    expect((await fetch(searchUrl, { method: "POST", body: "{}" })).status).toBe(415);
    expect(
      (
        await fetch(searchUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(searchUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "x", surprise: true }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(searchUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "x".repeat(40_000) }),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await fetch(searchUrl, {
          method: "POST",
          headers: { Host: "evil.example:9999", "Content-Type": "application/json" },
          body: JSON.stringify({ query: "x" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(searchUrl, {
          method: "POST",
          headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
          body: JSON.stringify({ query: "x" }),
        })
      ).status,
    ).toBe(403);
  });

  test("returns typed search responses and bounds concurrent expensive searches", async () => {
    const { server, services } = await startFixtureServer();
    const url = new URL(`${API_PREFIX}/search`, server.url);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "  gateway timeout  ", fileCount: 5, formats: ["markdown"] }),
    });
    expect(await response.json()).toMatchObject({
      query: "gateway timeout",
      requestedFileCount: 5,
    });

    services.search.delay = true;
    const firstController = new AbortController();
    const first = fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "slow" }),
      signal: firstController.signal,
    }).catch(() => undefined);
    await Bun.sleep(10);
    const busy = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "second" }),
    });
    expect(busy.status).toBe(429);
    firstController.abort();
    await first;
  });

  test("returns metadata and streams current file bytes only through opaque IDs", async () => {
    const { server, fileId } = await startFixtureServer();
    const metadata = await fetch(new URL(`${API_PREFIX}/files/${fileId}`, server.url));
    expect(await metadata.json()).toMatchObject({ fileId, relativePath: "guide.md" });
    const content = await fetch(new URL(`${API_PREFIX}/files/${fileId}/content`, server.url));
    expect(content.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await content.text()).toContain("streamed file body");
    expect(
      (await fetch(new URL(`${API_PREFIX}/files/${fileId}`, server.url), { method: "POST" }))
        .status,
    ).toBe(405);

    expect((await fetch(new URL(`${API_PREFIX}/files/not-an-id`, server.url))).status).toBe(400);
    expect(
      (await fetch(new URL(`${API_PREFIX}/files/${"f".repeat(64)}/content`, server.url))).status,
    ).toBe(404);
    expect((await fetch(new URL(`${API_PREFIX}/files/%00/content`, server.url))).status).toBe(400);
    expect((await fetch(new URL(`${API_PREFIX}/files/%E0%A4%A/content`, server.url))).status).toBe(
      400,
    );
    expect((await fetch(new URL(`${API_PREFIX}/files/%2e%2e/content`, server.url))).status).toBe(
      404,
    );
  });

  test("requires a same-origin action token and performs controlled reconcile/reindex", async () => {
    const { server, services } = await startFixtureServer();
    const url = new URL(`${API_PREFIX}/actions/reconcile`, server.url);
    const request = (mode: string, token?: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-KBISS-CSRF": token } : {}),
        },
        body: JSON.stringify({ mode }),
      });
    expect((await request("reconcile")).status).toBe(403);
    expect((await request("erase", "fixture-csrf")).status).toBe(400);
    expect((await request("reconcile", "fixture-csrf")).status).toBe(200);
    expect((await request("reindex", "fixture-csrf")).status).toBe(200);
    expect(services.discovery.scanner.scans).toBe(2);
    expect(services.indexing.indexCalls).toBe(2);
    services.discovery.scanner.failure = {
      code: "DISCOVERY_ROOT_UNAVAILABLE",
      message: "The fixture root cannot be scanned.",
    };
    expect((await request("reconcile", "fixture-csrf")).status).toBe(500);
    expect((await fetch(url)).status).toBe(405);
  });

  test("streams ordered SSE snapshots and reconnects from Last-Event-ID", async () => {
    const { server, runtime } = await startFixtureServer();
    const response = await fetch(new URL(`${API_PREFIX}/events`, server.url));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    const first = await reader?.read();
    const text = new TextDecoder().decode(first?.value);
    expect(text).toContain("event: snapshot");
    const id = Number(/id: (\d+)/u.exec(text)?.[1]);
    await reader?.cancel();

    runtime.events.publish({ type: "issue", issue: { code: "TEST", message: "test issue" } });
    const replay = await fetch(new URL(`${API_PREFIX}/events`, server.url), {
      headers: { "Last-Event-ID": String(id) },
    });
    const replayReader = replay.body?.getReader();
    const replayChunk = await replayReader?.read();
    expect(new TextDecoder().decode(replayChunk?.value)).toContain("test issue");
    await replayReader?.cancel();
  });

  test("keeps the server useful when background startup fails", async () => {
    const root = join(fixtureDir, "root");
    const config = indexingConfig(root, join(fixtureDir, "state"), join(fixtureDir, "cache"));
    const state = new StartupStateStore({
      phase: "loading_model",
      changedAt: 1,
      issues: [],
    });
    const runtime = new ApplicationRuntime(config, state, {
      factory: async () => ({
        ok: false,
        error: { code: "MODEL_ASSETS_MISSING", message: "Run model setup." },
      }),
    });
    runtimes.push(runtime);
    const server = createApplicationServer(runtime, { port: 0, uiDistDir: join(fixtureDir, "ui") });
    servers.push(server);
    await runtime.initialize();
    const status = await fetch(new URL(`${API_PREFIX}/status`, server.url));
    expect(await status.json()).toMatchObject({
      startup: { phase: "error", error: { code: "MODEL_ASSETS_MISSING" } },
    });
    expect(await (await fetch(server.url)).text()).toBe("<main>KBISS</main>");
    expect(
      (
        await fetch(new URL(`${API_PREFIX}/search`, server.url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "not ready" }),
        })
      ).status,
    ).toBe(503);
    expect((await fetch(new URL(`${API_PREFIX}/files/${"a".repeat(64)}`, server.url))).status).toBe(
      503,
    );
    expect(
      (await fetch(new URL(`${API_PREFIX}/files/${"a".repeat(64)}/content`, server.url))).status,
    ).toBe(503);
    expect(
      (
        await fetch(new URL(`${API_PREFIX}/actions/reconcile`, server.url), {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-KBISS-CSRF": runtime.csrfToken },
          body: JSON.stringify({ mode: "reindex" }),
        })
      ).status,
    ).toBe(409);
  });

  test("detects a compatible configured instance and opens the browser once", async () => {
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("unrelated", { status: 404 }),
    });
    servers.push(blocker);
    const port = blocker.port;
    if (port === undefined) throw new Error("Expected an ephemeral test port.");
    const options = {
      argv: ["--root", join(fixtureDir, "root"), "--port", String(port)],
      env: {
        KBISS_STATE_DIR: join(fixtureDir, "state"),
        KBISS_CACHE_DIR: join(fixtureDir, "cache"),
      },
      homeDir: fixtureDir,
      projectDir: join(fixtureDir, "project"),
      uiDistDir: join(fixtureDir, "ui"),
    } as const;
    let opens = 0;
    let firstServices: FixtureServices | undefined;
    const first = await startApplication({
      ...options,
      factory: async (config) => {
        firstServices = fixtureServices(config);
        return ok(firstServices);
      },
      openBrowser: () => {
        opens += 1;
      },
    });
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.kind !== "started") return;
    applications.push(first.value);
    await first.value.ready;
    expect(first.value.server.port).toBe(port + 1);
    const second = await startApplication({
      ...options,
      openBrowser: () => {
        opens += 1;
      },
    });
    expect(second).toMatchObject({ ok: true, value: { kind: "existing" } });
    expect(opens).toBe(2);
    expect(firstServices?.indexing.indexCalls).toBe(1);

    const bindProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const bindPort = bindProbe.port;
    await bindProbe.stop(true);
    if (bindPort === undefined) throw new Error("Expected a bind-test port.");
    const bindFailure = await startApplication({
      ...options,
      argv: ["--root", join(fixtureDir, "root"), "--port", String(bindPort)],
      serverFactory: () => {
        throw new Error("simulated bind race");
      },
    });
    expect(bindFailure).toMatchObject({ ok: false, error: { code: "SERVER_START_FAILED" } });
  });

  test("retains the Plan 1 compatibility server and maps unexpected handlers safely", async () => {
    const foundation = createFoundationServer({ port: 0, uiDistDir: join(fixtureDir, "ui") });
    servers.push(foundation);
    expect(await (await fetch(new URL("/api/health", foundation.url))).json()).toEqual({
      service: "kbiss",
      status: "ok",
    });
    expect(await (await fetch(foundation.url)).text()).toBe("<main>KBISS</main>");

    const { runtime } = await fixtureRuntime();
    const originalStatus = runtime.status.bind(runtime);
    Object.defineProperty(runtime, "status", {
      configurable: true,
      value: () => {
        throw new Error("/private/absolute/path");
      },
    });
    const server = createApplicationServer(runtime, { port: 0, uiDistDir: join(fixtureDir, "ui") });
    servers.push(server);
    const response = await fetch(new URL(`${API_PREFIX}/health`, server.url));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("/private/absolute/path");
    Object.defineProperty(runtime, "status", { configurable: true, value: originalStatus });
  });

  test("graceful shutdown cancels in-flight search and releases every owned service", async () => {
    const { runtime, services } = await fixtureRuntime();
    await runtime.initialize();
    services.search.delay = true;
    const operation = runtime.search({ query: "slow" }, new AbortController().signal);
    await Bun.sleep(5);
    await runtime.shutdown();
    const result = await operation;
    expect(result).toMatchObject({ ok: false, error: { code: "SEARCH_CANCELLED" } });
    expect(services.discovery.watcher.stops).toBeGreaterThan(0);
    expect(services.store.closes).toBe(1);
    expect(services.embeddings.shutdownCalls).toBe(1);
    expect(services.searchCloseCount.value).toBe(1);
  });
});
