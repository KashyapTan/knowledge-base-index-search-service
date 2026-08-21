import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAppConfig, parseCliOptions } from "./configuration.ts";
import { DEFAULT_PORT } from "./defaults.ts";
import {
  canonicalizeSourceRoot,
  createRootIdentity,
  expandHomePath,
  resolvePlatformDirectories,
} from "./paths.ts";

let fixtureDir = "";
let projectDir = "";

beforeEach(async () => {
  fixtureDir = await realpath(await mkdtemp(join(tmpdir(), "kbiss-config-test-")));
  projectDir = join(fixtureDir, "project");
  await mkdir(projectDir);
});

afterEach(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

async function makeRoot(name: string): Promise<string> {
  const path = join(fixtureDir, name);
  await mkdir(path, { recursive: true });
  return path;
}

function externalPaths(name: string): { cacheDir: string; stateDir: string } {
  return {
    cacheDir: join(fixtureDir, `${name}-cache`),
    stateDir: join(fixtureDir, `${name}-state`),
  };
}

describe("command-line parsing", () => {
  test("accepts separated and equals-style values", () => {
    expect(parseCliOptions(["--root", "repo", "--port=4111", "--model", "local/model"])).toEqual({
      ok: true,
      value: { root: "repo", port: "4111", modelId: "local/model" },
    });
  });

  test("accepts the offline flag and explicit offline values", () => {
    expect(parseCliOptions(["--offline"])).toEqual({ ok: true, value: { offline: "true" } });
    expect(parseCliOptions(["--offline=false"])).toEqual({
      ok: true,
      value: { offline: "false" },
    });
  });

  test.each([
    [["--unknown", "value"], "Unknown command-line option"],
    [["--root"], "requires a value"],
    [["--root", "--port", "4000"], "requires a value"],
    [["--port="], "requires a value"],
  ] as const)("rejects invalid arguments %#", (argv, message) => {
    const result = parseCliOptions(argv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(message);
  });
});

describe("configuration precedence and validation", () => {
  test("resolves offline policy from CLI, environment, and configuration", async () => {
    const root = await makeRoot("offline-root");
    const locations = externalPaths("offline");
    const configFile = join(fixtureDir, "offline.json");
    await writeFile(configFile, JSON.stringify({ offline: true }));
    const fromFile = await loadAppConfig({
      argv: ["--config", configFile, "--root", root],
      env: { KBISS_STATE_DIR: locations.stateDir, KBISS_CACHE_DIR: locations.cacheDir },
      homeDir: fixtureDir,
      projectDir,
    });
    expect(fromFile.ok && fromFile.value.offline).toBe(true);
    const fromCli = await loadAppConfig({
      argv: ["--config", configFile, "--root", root, "--offline=false"],
      env: {
        KBISS_OFFLINE: "true",
        KBISS_STATE_DIR: locations.stateDir,
        KBISS_CACHE_DIR: locations.cacheDir,
      },
      homeDir: fixtureDir,
      projectDir,
    });
    expect(fromCli.ok && fromCli.value.offline).toBe(false);
    const invalid = await loadAppConfig({
      argv: ["--root", root],
      env: {
        KBISS_OFFLINE: "sometimes",
        KBISS_STATE_DIR: locations.stateDir,
        KBISS_CACHE_DIR: locations.cacheDir,
      },
      homeDir: fixtureDir,
      projectDir,
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "CONFIG_VALUE_INVALID" } });
  });
  test("applies CLI, environment, user file, then defaults without mutating inputs", async () => {
    const [fileRoot, environmentRoot, cliRoot] = await Promise.all([
      makeRoot("file-root"),
      makeRoot("environment-root"),
      makeRoot("cli-root"),
    ]);
    const configFile = join(fixtureDir, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        root: fileRoot,
        port: 4001,
        modelId: "file/model",
        quantization: "q8",
        vectorDimension: 768,
      }),
    );
    const locations = externalPaths("precedence");
    const env = Object.freeze({
      KBISS_ROOT: environmentRoot,
      KBISS_PORT: "4002",
      KBISS_MODEL_ID: "environment/model",
      KBISS_QUANTIZATION: "q4",
      KBISS_STATE_DIR: locations.stateDir,
      KBISS_CACHE_DIR: locations.cacheDir,
    });
    const argv = Object.freeze([
      "--config",
      configFile,
      "--root",
      cliRoot,
      "--port=4003",
      "--model=cli/model",
    ]);

    const result = await loadAppConfig({ argv, env, homeDir: fixtureDir, projectDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceRoots[0].path).toBe(cliRoot);
    expect(result.value.server).toEqual({ hostname: "127.0.0.1", port: 4003 });
    expect(result.value.embedding).toEqual({
      modelId: "cli/model",
      normalization: "l2",
      quantization: "q4",
      vectorDimension: 768,
    });
    expect(env.KBISS_ROOT).toBe(environmentRoot);
    expect(argv).toHaveLength(6);
  });

  test("uses environment over a user file and defaults for absent values", async () => {
    const fileRoot = await makeRoot("file-root");
    const environmentRoot = await makeRoot("environment-root");
    const configFile = join(fixtureDir, "settings.json");
    await writeFile(configFile, JSON.stringify({ root: fileRoot, port: 4100 }));
    const locations = externalPaths("environment");
    const result = await loadAppConfig({
      argv: [],
      env: {
        KBISS_CONFIG_FILE: configFile,
        KBISS_ROOT: environmentRoot,
        KBISS_STATE_DIR: locations.stateDir,
        KBISS_CACHE_DIR: locations.cacheDir,
      },
      homeDir: fixtureDir,
      projectDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceRoots[0].path).toBe(environmentRoot);
    expect(result.value.server.port).toBe(4100);
    expect(result.value.embedding.vectorDimension).toBe(384);
  });

  test("expands the default root from the operating-system home directory", async () => {
    const defaultRoot = join(fixtureDir, "dev", "card-gateway-artifacts");
    await mkdir(defaultRoot, { recursive: true });
    const locations = externalPaths("default");
    const result = await loadAppConfig({
      argv: [],
      env: { KBISS_STATE_DIR: locations.stateDir, KBISS_CACHE_DIR: locations.cacheDir },
      homeDir: fixtureDir,
      platform: "linux",
      projectDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sourceRoots[0].path).toBe(defaultRoot);
      expect(result.value.server.port).toBe(DEFAULT_PORT);
    }
  });

  test("canonicalizes relative and symlinked root overrides", async () => {
    const root = await makeRoot("real-root");
    const link = join(fixtureDir, "root-link");
    await symlink(root, link, "dir");
    const locations = externalPaths("canonical");
    const result = await loadAppConfig({
      argv: ["--root", "root-link"],
      cwd: fixtureDir,
      env: { KBISS_STATE_DIR: locations.stateDir, KBISS_CACHE_DIR: locations.cacheDir },
      homeDir: fixtureDir,
      projectDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.sourceRoots[0].path).toBe(root);
  });

  test.each([
    ["0", "port"],
    ["65536", "port"],
    ["3.5", "port"],
    ["not-a-number", "port"],
  ])("rejects invalid port %s", async (port, setting) => {
    const root = await makeRoot(`port-${port.replaceAll(".", "-")}`);
    const locations = externalPaths(`port-${port}`);
    const result = await loadAppConfig({
      argv: ["--root", root, "--port", port],
      env: { KBISS_STATE_DIR: locations.stateDir, KBISS_CACHE_DIR: locations.cacheDir },
      homeDir: fixtureDir,
      projectDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.setting).toBe(setting);
  });

  test.each([
    [["--model", "   "], "modelId"],
    [["--quantization", "   "], "quantization"],
    [["--quantization", "made-up"], "quantization"],
    [["--vector-dimension", "0"], "vectorDimension"],
    [["--normalization", "none"], "normalization"],
  ] as const)("rejects invalid model setting %#", async (settingArgs, setting) => {
    const root = await makeRoot(`model-${setting}`);
    const locations = externalPaths(`model-${setting}`);
    const result = await loadAppConfig({
      argv: ["--root", root, ...settingArgs],
      env: { KBISS_STATE_DIR: locations.stateDir, KBISS_CACHE_DIR: locations.cacheDir },
      homeDir: fixtureDir,
      projectDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.setting).toBe(setting);
  });

  test.each([
    ["{", "not valid JSON"],
    ["[]", "must contain a JSON object"],
    ['{"unknown": true}', "unknown setting"],
    ['{"port": false}', "wrong type"],
  ])("reports malformed user configuration %#", async (contents, message) => {
    const root = await makeRoot(`bad-config-${message.replaceAll(" ", "-")}`);
    const configFile = join(fixtureDir, `${crypto.randomUUID()}.json`);
    await writeFile(configFile, contents);
    const locations = externalPaths(crypto.randomUUID());
    const result = await loadAppConfig({
      argv: ["--config", configFile, "--root", root],
      env: { KBISS_STATE_DIR: locations.stateDir, KBISS_CACHE_DIR: locations.cacheDir },
      homeDir: fixtureDir,
      projectDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(message);
  });

  test("reports an explicitly selected missing configuration file", async () => {
    const result = await loadAppConfig({
      argv: ["--config", join(fixtureDir, "missing.json")],
      env: {},
      homeDir: fixtureDir,
      projectDir,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "CONFIG_FILE_INVALID" } });
  });
});

describe("source roots and state paths", () => {
  test("reports missing roots without creating them", async () => {
    const missingRoot = join(fixtureDir, "missing-root");
    const locations = externalPaths("missing");
    const result = await loadAppConfig({
      argv: ["--root", missingRoot],
      env: { KBISS_STATE_DIR: locations.stateDir, KBISS_CACHE_DIR: locations.cacheDir },
      homeDir: fixtureDir,
      projectDir,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "ROOT_NOT_FOUND" } });
    expect(await Bun.file(missingRoot).exists()).toBe(false);
  });

  test("reports a file used as the source root", async () => {
    const file = join(fixtureDir, "file.txt");
    await writeFile(file, "text");
    const result = await canonicalizeSourceRoot(file, { cwd: fixtureDir, homeDir: fixtureDir });
    expect(result).toMatchObject({ ok: false, error: { code: "ROOT_NOT_DIRECTORY" } });
  });

  test("reports an unreadable root", async () => {
    if (process.platform === "win32") return;
    const root = await makeRoot("unreadable-root");
    await chmod(root, 0o000);
    try {
      const result = await canonicalizeSourceRoot(root, { cwd: fixtureDir, homeDir: fixtureDir });
      expect(result).toMatchObject({ ok: false, error: { code: "ROOT_UNREADABLE" } });
    } finally {
      await chmod(root, 0o700);
    }
  });

  test("rejects state nested in the indexed or project repository", async () => {
    const root = await makeRoot("unsafe-root");
    const cache = join(fixtureDir, "safe-cache");
    const result = await loadAppConfig({
      argv: ["--root", root, "--state-dir", join(root, ".kbiss")],
      env: { KBISS_CACHE_DIR: cache },
      homeDir: fixtureDir,
      projectDir,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "STATE_PATH_UNSAFE" } });

    const second = await loadAppConfig({
      argv: ["--root", root, "--cache-dir", join(projectDir, ".cache")],
      env: { KBISS_STATE_DIR: join(fixtureDir, "safe-state") },
      homeDir: fixtureDir,
      projectDir,
    });
    expect(second).toMatchObject({ ok: false, error: { code: "STATE_PATH_UNSAFE" } });
  });

  test("reports state directories that cannot be prepared", async () => {
    const root = await makeRoot("state-failure-root");
    const blockingFile = join(fixtureDir, "blocking-state-parent");
    await writeFile(blockingFile, "not a directory");
    const result = await loadAppConfig({
      argv: ["--root", root, "--state-dir", join(blockingFile, "state")],
      env: { KBISS_CACHE_DIR: join(fixtureDir, "cache-for-state-failure") },
      homeDir: fixtureDir,
      projectDir,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STATE_DIRECTORY_UNAVAILABLE" },
    });
  });

  test("creates stable opaque namespaces outside both repositories", async () => {
    const root = await makeRoot("stable-root");
    const locations = externalPaths("stable");
    const baseOptions = {
      env: { KBISS_STATE_DIR: locations.stateDir, KBISS_CACHE_DIR: locations.cacheDir },
      homeDir: fixtureDir,
      projectDir,
    } as const;
    const first = await loadAppConfig({ ...baseOptions, argv: ["--root", root] });
    const second = await loadAppConfig({ ...baseOptions, argv: ["--root", root] });
    const changedModel = await loadAppConfig({
      ...baseOptions,
      argv: ["--root", root, "--model", "different/model"],
    });
    expect(first.ok && second.ok && changedModel.ok).toBe(true);
    if (!first.ok || !second.ok || !changedModel.ok) return;
    expect(first.value.paths.rootNamespace).toBe(second.value.paths.rootNamespace);
    expect(first.value.paths.indexNamespace).toBe(second.value.paths.indexNamespace);
    expect(first.value.paths.rootNamespace).toBe(changedModel.value.paths.rootNamespace);
    expect(first.value.paths.indexNamespace).not.toBe(changedModel.value.paths.indexNamespace);
    expect(first.value.paths.indexDir).not.toContain(root);
    expect(first.value.paths.indexNamespace).not.toContain(root);
    expect(first.value.sourceRoots[0].identity).toBe(createRootIdentity(root));
    expect((await Bun.file(first.value.paths.indexMetadataDir).stat()).isDirectory()).toBe(true);
  });
});

describe("home expansion and platform layout", () => {
  test.each([
    ["~", "/users/test"],
    ["~/repo", resolve("/users/test", "repo")],
    ["~\\repo", resolve("/users/test", "repo")],
    ["relative/repo", "relative/repo"],
  ])("expands %s", (input, expected) => {
    expect(expandHomePath(input, "/users/test")).toEqual({ ok: true, value: expected });
  });

  test("rejects unavailable and named-user home expansion", () => {
    expect(expandHomePath("~/repo", "")).toMatchObject({
      ok: false,
      error: { code: "HOME_DIRECTORY_UNAVAILABLE" },
    });
    expect(expandHomePath("~someone/repo", "/users/test")).toMatchObject({
      ok: false,
      error: { code: "CONFIG_VALUE_INVALID" },
    });
    expect(resolvePlatformDirectories({ homeDir: "" })).toMatchObject({
      ok: false,
      error: { code: "HOME_DIRECTORY_UNAVAILABLE" },
    });
  });

  test.each([
    ["darwin", {}, "/home/me/Library/Application Support/kbiss"],
    ["linux", {}, "/home/me/.local/state/kbiss"],
    ["linux", { XDG_STATE_HOME: "/state" }, "/state/kbiss"],
    ["win32", { LOCALAPPDATA: "C:\\local", APPDATA: "C:\\roaming" }, "C:\\local\\kbiss\\state"],
  ] as const)("uses an OS-appropriate state path for %s %#", (platform, env, expectedState) => {
    const result = resolvePlatformDirectories({ platform, env, homeDir: "/home/me" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stateDir).toBe(expectedState);
  });
});
