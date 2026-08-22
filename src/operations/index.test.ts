import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppConfig,
  initialStartupState,
  loadAppConfig,
  StartupStateStore,
  writeCompatibilityMetadata,
} from "../config/index.ts";
import {
  type EmbeddingProvider,
  FakeEmbeddingProvider,
  verifyOrWriteModelAssetManifest,
} from "../indexing/index.ts";
import { ApplicationRuntime, createApplicationServer } from "../server/index.ts";
import { fixtureServices } from "../server/test-helpers.ts";
import { ok } from "../shared/result.ts";
import { runOperationsCli } from "./cli.ts";
import {
  collectDiagnostics,
  importModelAssetSource,
  platformSupport,
  resetLocalState,
  resetTargets,
  resolvedConfiguration,
  selectConfiguredRoot,
  stageIndexRebuild,
  triggerRunningAction,
} from "./index.ts";

let fixture = "";
let config: AppConfig;
const servers: Bun.Server<undefined>[] = [];
const runtimes: ApplicationRuntime[] = [];

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "kbiss-operations-test-")));
  const root = join(fixture, "root");
  const project = join(fixture, "project");
  await Promise.all([mkdir(root), mkdir(project)]);
  const loaded = await loadAppConfig({
    argv: ["--root", root],
    env: {
      KBISS_CACHE_DIR: join(fixture, "cache"),
      KBISS_STATE_DIR: join(fixture, "state"),
    },
    homeDir: fixture,
    platform: "linux",
    projectDir: project,
  });
  if (!loaded.ok) throw new Error(loaded.error.message);
  config = loaded.value;
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const server of servers.splice(0)) await server.stop(true);
  await rm(fixture, { recursive: true, force: true });
});

describe("operational diagnostics", () => {
  test("reports resolved paths, runtime compatibility, and uninitialized local state", async () => {
    const resolved = resolvedConfiguration(config);
    expect(resolved).toMatchObject({
      applicationVersion: "0.1.0",
      sourceRoot: join(fixture, "root"),
      offline: false,
      ignorePatterns: config.ignorePatterns,
      paths: { indexDir: config.paths.indexDir, modelCacheDir: config.paths.modelCacheDir },
    });
    const report = await collectDiagnostics(config);
    expect(report.bun).toEqual({ actual: "1.4.0", expected: "1.4.0", compatible: true });
    expect(report.dependencies["@lancedb/lancedb"]).toBe("0.37.1");
    expect(report.model.state).toBe("missing");
    expect(report.index.state).toBe("not-initialized");
    expect(platformSupport("darwin", "arm64").level).toBe("verified");
    expect(platformSupport("linux", "x64").level).toBe("supported-unverified");
    expect(platformSupport("aix", "ppc64").level).toBe("unsupported");

    await writeCompatibilityMetadata(config.paths.compatibilityFile, config.compatibility);
    await writeFile(join(config.paths.lanceDbDir, "initialized"), "yes");
    expect((await collectDiagnostics(config)).index.state).toBe("compatible");
  });

  test("classifies corrupt model and compatibility metadata without throwing", async () => {
    await Promise.all([
      writeFile(join(config.paths.modelCacheDir, "kbiss-model-assets.json"), "{"),
      writeFile(config.paths.compatibilityFile, "{"),
      writeFile(join(config.paths.lanceDbDir, "state"), "present"),
    ]);
    const report = await collectDiagnostics(config);
    expect(report.model.state).toBe("corrupt");
    expect(report.index.state).toBe("corrupt");

    await rm(config.paths.compatibilityFile);
    await mkdir(config.paths.compatibilityFile);
    expect((await collectDiagnostics(config)).index).toMatchObject({
      state: "corrupt",
      reasons: ["The index compatibility metadata could not be read."],
    });
  });
});

describe("safe state operations", () => {
  test("requires confirmation and removes only the selected exact index", async () => {
    const marker = join(config.paths.indexDir, "marker.txt");
    const unrelated = join(config.paths.applicationStateDir, "unrelated.txt");
    await Promise.all([writeFile(marker, "index"), writeFile(unrelated, "keep")]);
    expect(await resetLocalState(config, ["current-index"], { confirmed: false })).toMatchObject({
      ok: false,
      error: { code: "OPERATION_CONFIRMATION_REQUIRED" },
    });
    expect(await Bun.file(marker).exists()).toBe(true);
    const reset = await resetLocalState(config, ["current-index"], { confirmed: true });
    expect(reset).toEqual({ ok: true, value: [config.paths.indexDir] });
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await Bun.file(unrelated).text()).toBe("keep");
  });

  test("supports explicit root-version and model scopes while rejecting unsafe targets", async () => {
    const otherVersion = join(
      config.paths.applicationStateDir,
      "indexes",
      config.paths.rootNamespace,
      "older-index",
    );
    await mkdir(otherVersion, { recursive: true });
    await writeFile(join(otherVersion, "old"), "old");
    await writeFile(join(config.paths.modelCacheDir, "weights"), "weights");
    expect(resetTargets(config, ["root-indexes", "model-cache"])).toEqual([
      join(config.paths.applicationStateDir, "indexes", config.paths.rootNamespace),
      config.paths.modelCacheDir,
    ]);
    expect(
      await resetLocalState(config, ["root-indexes", "model-cache"], { confirmed: true }),
    ).toMatchObject({ ok: true });
    expect(await Bun.file(join(otherVersion, "old")).exists()).toBe(false);
    expect(await Bun.file(join(config.paths.modelCacheDir, "weights")).exists()).toBe(false);

    const outside = join(fixture, "must-survive");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "safe");
    const malicious = { ...config, paths: { ...config.paths, indexDir: outside } };
    expect(await resetLocalState(malicious, ["current-index"], { confirmed: true })).toMatchObject({
      ok: false,
      error: { code: "OPERATION_TARGET_UNSAFE" },
    });
    expect(await Bun.file(join(outside, "sentinel")).text()).toBe("safe");
    expect(await resetLocalState(config, [], { confirmed: true })).toMatchObject({
      ok: false,
      error: { code: "OPERATION_ARGUMENT_INVALID" },
    });

    const escapedLink = join(
      config.paths.applicationStateDir,
      "indexes",
      config.paths.rootNamespace,
      "escaped-index",
    );
    await mkdir(join(config.paths.applicationStateDir, "indexes", config.paths.rootNamespace), {
      recursive: true,
    });
    await symlink(outside, escapedLink);
    const escaped = { ...config, paths: { ...config.paths, indexDir: escapedLink } };
    expect(await resetLocalState(escaped, ["current-index"], { confirmed: true })).toMatchObject({
      ok: false,
      error: { code: "OPERATION_TARGET_UNSAFE" },
    });

    const missingParentConfig = {
      ...config,
      paths: {
        ...config.paths,
        applicationStateDir: join(fixture, "missing-state-parent"),
        indexDir: join(fixture, "missing-state-parent", "indexes", "root", "index"),
        rootNamespace: "root",
      },
    };
    expect(
      await resetLocalState(missingParentConfig, ["current-index"], { confirmed: true }),
    ).toMatchObject({ ok: false, error: { code: "OPERATION_TARGET_UNSAFE" } });

    if (process.platform !== "win32") {
      const parent = join(config.paths.applicationStateDir, "indexes", config.paths.rootNamespace);
      await mkdir(config.paths.indexDir, { recursive: true });
      await chmod(parent, 0o500);
      try {
        expect(await resetLocalState(config, ["current-index"], { confirmed: true })).toMatchObject(
          { ok: false, error: { code: "OPERATION_FAILED" } },
        );
      } finally {
        await chmod(parent, 0o700);
      }
    }
  });

  test("preserves old indexes and creates a recoverable fresh rebuild target", async () => {
    await writeFile(join(config.paths.indexDir, "old-index"), "preserved");
    expect(await stageIndexRebuild(config, { confirmed: false })).toMatchObject({
      ok: false,
      error: { code: "OPERATION_CONFIRMATION_REQUIRED" },
    });
    const staged = await stageIndexRebuild(config, {
      confirmed: true,
      now: new Date("2026-08-21T12:00:00Z"),
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.value.backup).toBeDefined();
    expect(await Bun.file(join(staged.value.backup as string, "old-index")).text()).toBe(
      "preserved",
    );
    expect((await lstat(config.paths.indexMetadataDir)).isDirectory()).toBe(true);
    expect((await lstat(config.paths.lanceDbDir)).isDirectory()).toBe(true);

    await writeFile(join(config.paths.indexDir, "interrupted-retry"), "second");
    const retry = await stageIndexRebuild(config, { confirmed: true });
    expect(retry.ok).toBe(true);
    expect(await Bun.file(join(staged.value.backup as string, "old-index")).exists()).toBe(true);

    await resetLocalState(config, ["current-index"], { confirmed: true });
    expect(await stageIndexRebuild(config, { confirmed: true })).toEqual({
      ok: true,
      value: { target: config.paths.indexDir },
    });
    if (process.platform !== "win32") {
      const parent = join(config.paths.applicationStateDir, "indexes", config.paths.rootNamespace);
      await chmod(parent, 0o500);
      try {
        expect(await stageIndexRebuild(config, { confirmed: true })).toMatchObject({
          ok: false,
          error: { code: "OPERATION_FAILED" },
        });
      } finally {
        await chmod(parent, 0o700);
      }
    }
  });
});

describe("root and model asset operations", () => {
  test("atomically selects a validated root while preserving existing user settings", async () => {
    const nextRoot = join(fixture, "next-root");
    const configFile = join(fixture, "user", "config.json");
    await mkdir(nextRoot);
    await mkdir(join(fixture, "user"));
    await writeFile(
      configFile,
      JSON.stringify({ port: 4123, ignorePatterns: ["node_modules/", "generated/"] }),
    );
    const selected = await selectConfiguredRoot(nextRoot, {
      configFile,
      cwd: fixture,
      homeDir: fixture,
      platform: "linux",
    });
    expect(selected).toEqual({ ok: true, value: { configFile, root: nextRoot } });
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
      port: 4123,
      ignorePatterns: ["node_modules/", "generated/"],
      root: nextRoot,
    });
    await writeFile(configFile, "{");
    expect(
      await selectConfiguredRoot(nextRoot, { configFile, cwd: fixture, homeDir: fixture }),
    ).toMatchObject({ ok: false, error: { code: "CONFIGURATION_WRITE_FAILED" } });
    expect(await readFile(configFile, "utf8")).toBe("{");
    expect(
      await selectConfiguredRoot(join(fixture, "missing-root"), { homeDir: fixture }),
    ).toMatchObject({
      ok: false,
      error: { code: "OPERATION_ARGUMENT_INVALID" },
    });

    const envConfig = join(fixture, "env-config.json");
    expect(
      await selectConfiguredRoot(nextRoot, {
        cwd: fixture,
        env: { KBISS_CONFIG_FILE: envConfig },
        homeDir: fixture,
        platform: "linux",
      }),
    ).toMatchObject({ ok: true, value: { configFile: envConfig } });

    if (process.platform !== "win32") {
      const locked = join(fixture, "locked-config-parent");
      await mkdir(locked);
      await chmod(locked, 0o500);
      try {
        expect(
          await selectConfiguredRoot(nextRoot, {
            configFile: join(locked, "config.json"),
            homeDir: fixture,
          }),
        ).toMatchObject({ ok: false, error: { code: "CONFIGURATION_WRITE_FAILED" } });
      } finally {
        await chmod(locked, 0o700);
      }
    }
  });

  test("imports only a verified, symlink-free model bundle and preserves the old cache", async () => {
    const source = join(fixture, "airgap-model");
    await mkdir(source);
    await mkdir(join(source, "Xenova", "bge-small-en-v1.5", "onnx"), { recursive: true });
    const sourceOutput = join(
      source,
      "Xenova",
      "bge-small-en-v1.5",
      "onnx",
      config.embedding.quantization === "fp16" ? "model_fp16.onnx" : "model_quantized.onnx",
    );
    await writeFile(sourceOutput, "verified weights");
    const identity = {
      ...config.embedding,
      maximumTokens: 512,
    };
    expect((await verifyOrWriteModelAssetManifest(source, identity, "write-if-missing")).ok).toBe(
      true,
    );
    await writeFile(join(config.paths.modelCacheDir, "old.bin"), "old cache");
    const imported = await importModelAssetSource(config, source);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(
      await Bun.file(
        join(
          config.paths.modelCacheDir,
          "Xenova",
          "bge-small-en-v1.5",
          "onnx",
          config.embedding.quantization === "fp16" ? "model_fp16.onnx" : "model_quantized.onnx",
        ),
      ).text(),
    ).toBe("verified weights");
    expect(await Bun.file(join(imported.value.backup as string, "old.bin")).text()).toBe(
      "old cache",
    );

    const unsafeSource = join(fixture, "unsafe-model");
    await mkdir(unsafeSource);
    await symlink(join(source, "weights.bin"), join(unsafeSource, "weights.bin"));
    expect(await importModelAssetSource(config, unsafeSource)).toMatchObject({
      ok: false,
      error: { code: "OPERATION_ARGUMENT_INVALID" },
    });
    expect(await importModelAssetSource(config, join(fixture, "missing-model"))).toMatchObject({
      ok: false,
      error: { code: "OPERATION_ARGUMENT_INVALID" },
    });
    expect(await importModelAssetSource(config, config.paths.modelCacheDir)).toMatchObject({
      ok: false,
      error: { code: "OPERATION_TARGET_UNSAFE" },
    });

    const unverified = join(fixture, "unverified-model");
    await mkdir(unverified);
    await writeFile(join(unverified, "weights.bin"), "no manifest");
    expect(await importModelAssetSource(config, unverified)).toMatchObject({
      ok: false,
      error: { code: "OPERATION_ARGUMENT_INVALID" },
    });

    await resetLocalState(config, ["model-cache"], { confirmed: true });
    expect(await importModelAssetSource(config, source)).toMatchObject({
      ok: true,
      value: { source },
    });

    if (process.platform !== "win32") {
      await resetLocalState(config, ["model-cache"], { confirmed: true });
      const modelsParent = join(config.paths.applicationCacheDir, "models");
      await chmod(modelsParent, 0o500);
      try {
        expect(await importModelAssetSource(config, source)).toMatchObject({
          ok: false,
          error: { code: "OPERATION_FAILED" },
        });
      } finally {
        await chmod(modelsParent, 0o700);
      }
    }
  });
});

describe("running actions and CLI", () => {
  test("triggers a same-root running reconciliation and reports absent instances", async () => {
    const services = fixtureServices(config);
    const state = new StartupStateStore(initialStartupState());
    state.dispatch({ type: "begin_validation" });
    state.dispatch({ type: "configuration_validated" });
    const runtime = new ApplicationRuntime(config, state, {
      csrfToken: "operations-csrf",
      factory: async () => ok(services),
    });
    runtimes.push(runtime);
    const server = createApplicationServer(runtime, { port: 0, uiDistDir: join(fixture, "ui") });
    servers.push(server);
    const runningConfig = {
      ...config,
      server: { ...config.server, port: server.port as number },
    };
    await runtime.initialize();
    expect(await triggerRunningAction(runningConfig, "reconcile")).toMatchObject({ ok: true });
    expect(services.discovery.scanner.scans).toBe(2);
    const cliOutput: string[] = [];
    expect(
      await runOperationsCli(
        ["reindex", "--root", config.sourceRoots[0].path, "--port", String(server.port)],
        {
          env: {
            KBISS_CACHE_DIR: config.paths.applicationCacheDir,
            KBISS_STATE_DIR: config.paths.applicationStateDir,
          },
          homeDir: fixture,
          projectDir: join(fixture, "project"),
          io: {
            info: (message) => cliOutput.push(message),
            error: (message) => cliOutput.push(message),
          },
        },
      ),
    ).toBe(0);
    expect(cliOutput.join("\n")).toContain("Reindex completed");
    services.discovery.scanner.failure = {
      code: "DISCOVERY_ROOT_UNAVAILABLE",
      message: "Controlled reconciliation failure.",
    };
    expect(await triggerRunningAction(runningConfig, "reconcile")).toMatchObject({
      ok: false,
      error: {
        code: "APPLICATION_ACTION_FAILED",
        message: "Controlled reconciliation failure.",
      },
    });
    await server.stop(true);
    servers.splice(servers.indexOf(server), 1);
    expect(await triggerRunningAction(runningConfig, "reconcile")).toMatchObject({
      ok: false,
      error: { code: "APPLICATION_NOT_RUNNING" },
    });

    const malformedActionServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("/health")) {
          return Response.json({
            service: "kbiss",
            version: "0.1.0",
            rootIdentity: config.sourceRoots[0].identity,
          });
        }
        if (pathname.endsWith("/status")) return Response.json({ csrfToken: "token" });
        return new Response("not-json", { status: 500 });
      },
    });
    servers.push(malformedActionServer);
    const malformedConfig = {
      ...config,
      server: { ...config.server, port: malformedActionServer.port as number },
    };
    expect(await triggerRunningAction(malformedConfig, "reindex")).toMatchObject({
      ok: false,
      error: { code: "APPLICATION_ACTION_FAILED" },
    });
  });

  test("handles help, version, configuration, confirmation, root, and unknown arguments", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const options = {
      env: {
        KBISS_CACHE_DIR: join(fixture, "cache"),
        KBISS_STATE_DIR: join(fixture, "state"),
      },
      homeDir: fixture,
      platform: "linux" as const,
      projectDir: join(fixture, "project"),
      io: {
        info: (message: string) => output.push(message),
        error: (message: string) => errors.push(message),
        confirm: () => false,
      },
    };
    expect(await runOperationsCli(["help"], options)).toBe(0);
    expect(await runOperationsCli(["version"], options)).toBe(0);
    expect(await runOperationsCli(["config", "--root", join(fixture, "root")], options)).toBe(0);
    expect(await runOperationsCli(["reset", "--root", join(fixture, "root")], options)).toBe(1);
    const next = join(fixture, "cli-root");
    await mkdir(next);
    expect(
      await runOperationsCli(["root", next, "--config", join(fixture, "selected.json")], options),
    ).toBe(0);
    expect(await runOperationsCli(["unknown", "--root", join(fixture, "root")], options)).toBe(1);
    expect(await runOperationsCli(["rebuild", "--root", join(fixture, "root")], options)).toBe(1);
    const withoutConfirm = {
      ...options,
      io: { info: options.io.info, error: options.io.error },
    };
    expect(await runOperationsCli(["reset", "--root", join(fixture, "root")], withoutConfirm)).toBe(
      1,
    );
    expect(output.join("\n")).toContain("KBISS operational commands");
    expect(output.join("\n")).toContain(config.paths.applicationStateDir);
    expect(errors.join("\n")).toContain("OPERATION_CONFIRMATION_REQUIRED");
    expect(errors.join("\n")).toContain("Unknown command");
  });

  test("exercises the real minimal process entrypoint without touching developer state", async () => {
    const child = Bun.spawn([process.execPath, "run", "scripts/operations.ts", "version"], {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toContain("KBISS 0.1.0");
    expect(await new Response(child.stderr).text()).toBe("");
  });

  test("covers operational command success and validation branches", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const baseOptions = {
      env: {
        KBISS_CACHE_DIR: join(fixture, "cache"),
        KBISS_STATE_DIR: join(fixture, "state"),
      },
      homeDir: fixture,
      platform: "linux" as const,
      projectDir: join(fixture, "project"),
      io: {
        info: (message: string) => output.push(message),
        error: (message: string) => errors.push(message),
        confirm: () => true,
      },
    };
    const rootArgs = ["--root", join(fixture, "root")];
    expect(await runOperationsCli([], baseOptions)).toBe(0);
    expect(await runOperationsCli(["root"], baseOptions)).toBe(1);
    expect(
      await runOperationsCli(["root", join(fixture, "missing"), "--config=x"], baseOptions),
    ).toBe(1);
    expect(await runOperationsCli(["doctor", ...rootArgs], baseOptions)).toBe(0);
    expect(await runOperationsCli(["reconcile", ...rootArgs], baseOptions)).toBe(1);
    expect(await runOperationsCli(["reindex", ...rootArgs], baseOptions)).toBe(1);
    expect(await runOperationsCli(["rebuild", "--yes", ...rootArgs], baseOptions)).toBe(0);
    expect(
      await runOperationsCli(
        ["reset", "--yes", "--all-index-versions", "--include-model", ...rootArgs],
        baseOptions,
      ),
    ).toBe(0);
    expect(
      await runOperationsCli(["config", "--root", join(fixture, "missing")], baseOptions),
    ).toBe(1);
    expect(await runOperationsCli(["model-setup", "--asset-source"], baseOptions)).toBe(1);
    expect(
      await runOperationsCli(
        ["model-setup", "--asset-source", join(fixture, "missing-bundle"), ...rootArgs],
        baseOptions,
      ),
    ).toBe(1);

    const successProvider = new FakeEmbeddingProvider();
    (successProvider as EmbeddingProvider).warmUp = async (warmOptions) => {
      warmOptions?.onProgress?.("verifying", "Controlled CLI model verification.");
      return ok(undefined);
    };
    expect(
      await runOperationsCli(["model-setup", ...rootArgs], {
        ...baseOptions,
        createEmbeddingProvider: () => successProvider,
      }),
    ).toBe(0);
    expect(successProvider.shutdownCalls).toBe(1);
    const failureProvider = new FakeEmbeddingProvider({ failWarmUp: true });
    expect(
      await runOperationsCli(["model-setup", "--offline", ...rootArgs], {
        ...baseOptions,
        createEmbeddingProvider: () => failureProvider,
      }),
    ).toBe(1);
    expect(failureProvider.shutdownCalls).toBe(1);
    const bundle = join(fixture, "cli-model-bundle");
    await mkdir(bundle);
    await mkdir(join(bundle, "Xenova", "bge-small-en-v1.5", "onnx"), { recursive: true });
    await writeFile(
      join(
        bundle,
        "Xenova",
        "bge-small-en-v1.5",
        "onnx",
        config.embedding.quantization === "fp16" ? "model_fp16.onnx" : "model_quantized.onnx",
      ),
      "cli bundle",
    );
    expect(
      (
        await verifyOrWriteModelAssetManifest(
          bundle,
          {
            ...config.embedding,
            maximumTokens: 512,
          },
          "write-if-missing",
        )
      ).ok,
    ).toBe(true);
    const importedProvider = new FakeEmbeddingProvider();
    expect(
      await runOperationsCli(
        ["model-setup", `--asset-source=${bundle}`, "--offline", ...rootArgs],
        {
          ...baseOptions,
          createEmbeddingProvider: () => importedProvider,
        },
      ),
    ).toBe(0);
    expect(importedProvider.shutdownCalls).toBe(1);
    expect(errors.join("\n")).toContain("MODEL_ASSETS_MISSING");
    expect(output.join("\n")).toContain("Fresh index staged");
    expect(output.join("\n")).toContain("Imported verified model assets");
  });
});
