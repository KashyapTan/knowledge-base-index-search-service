import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFoundationServer, startConfiguredFoundationServer } from "./index.ts";

let fixtureDir = "";
const occupiedServers: Server[] = [];
const bunServers: Bun.Server<undefined>[] = [];

beforeEach(async () => {
  fixtureDir = await realpath(await mkdtemp(join(tmpdir(), "kbiss-server-test-")));
  await Promise.all([mkdir(join(fixtureDir, "project")), mkdir(join(fixtureDir, "root"))]);
});

afterEach(async () => {
  for (const server of bunServers.splice(0)) await server.stop(true);
  await Promise.all(
    occupiedServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

async function occupyPort(): Promise<number> {
  const server = createServer();
  occupiedServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  return address.port;
}

function options(port: number) {
  return {
    argv: ["--root", join(fixtureDir, "root"), "--port", String(port)],
    env: {
      KBISS_STATE_DIR: join(fixtureDir, "state"),
      KBISS_CACHE_DIR: join(fixtureDir, "cache"),
    },
    homeDir: fixtureDir,
    projectDir: join(fixtureDir, "project"),
  } as const;
}

describe("configured foundation server", () => {
  test("serves built assets safely with SPA fallback", async () => {
    const uiDir = join(fixtureDir, "ui");
    await mkdir(uiDir);
    await Promise.all([
      writeFile(join(uiDir, "index.html"), "<main>KBISS</main>"),
      writeFile(join(uiDir, "app.js"), "export {};"),
    ]);
    const server = createFoundationServer({ port: 0, uiDistDir: uiDir });
    bunServers.push(server);
    expect(await (await fetch(server.url)).text()).toBe("<main>KBISS</main>");
    expect(await (await fetch(new URL("/app.js", server.url))).text()).toBe("export {};");
    expect(await (await fetch(new URL("/search/route", server.url))).text()).toBe(
      "<main>KBISS</main>",
    );
    expect((await fetch(new URL("/missing.txt", server.url))).status).toBe(404);
    expect((await fetch(new URL("/%E0%A4%A", server.url))).status).toBe(400);
    expect((await fetch(new URL("/%2e%2e/secret.txt", server.url))).status).toBe(404);
  });

  test("validates configuration, assesses metadata, and binds only to loopback", async () => {
    const occupiedPort = await occupyPort();
    const startup = await startConfiguredFoundationServer(options(occupiedPort));
    expect(startup.ok).toBe(true);
    if (!startup.ok) return;
    bunServers.push(startup.value.server);
    expect(startup.value.portSelection).toMatchObject({
      hostname: "127.0.0.1",
      preferredPort: occupiedPort,
      usedFallback: true,
    });
    expect(startup.value.compatibility.status).toBe("rebuild-required");
    expect(startup.value.server.hostname).toBe("127.0.0.1");
    expect(await (await fetch(new URL("/api/health", startup.value.server.url))).json()).toEqual({
      service: "kbiss",
      status: "ok",
    });
  });

  test("returns structured configuration failures without binding a server", async () => {
    const startup = await startConfiguredFoundationServer({
      ...options(3210),
      argv: ["--root", join(fixtureDir, "missing")],
    });
    expect(startup).toMatchObject({ ok: false, error: { code: "ROOT_NOT_FOUND" } });
  });

  test("surfaces corrupt compatibility state before later database use", async () => {
    const initial = await startConfiguredFoundationServer(options(32_100));
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    bunServers.push(initial.value.server);
    await writeFile(initial.value.config.paths.compatibilityFile, "not json");
    await initial.value.server.stop(true);
    bunServers.splice(bunServers.indexOf(initial.value.server), 1);

    const restarted = await startConfiguredFoundationServer(options(32_100));
    expect(restarted.ok).toBe(true);
    if (restarted.ok) {
      bunServers.push(restarted.value.server);
      expect(restarted.value.compatibility.status).toBe("corrupt");
    }
  });
});
