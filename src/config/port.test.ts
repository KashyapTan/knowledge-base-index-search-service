import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { classifyPortBindError, selectAvailableLoopbackPort } from "./port.ts";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function occupyPort(port = 0): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  return address.port;
}

describe("loopback port selection", () => {
  test("distinguishes a busy port from an unexpected bind failure", () => {
    expect(classifyPortBindError("EADDRINUSE", 3210)).toEqual({ ok: true, value: false });
    expect(classifyPortBindError("EACCES", 80)).toMatchObject({
      ok: false,
      error: { code: "PORT_CHECK_FAILED", details: { port: 80 } },
    });
  });

  test.each([0, 65_536, 3.5])("rejects invalid preferred port %s", async (port) => {
    expect(await selectAvailableLoopbackPort(port)).toMatchObject({
      ok: false,
      error: { code: "CONFIG_VALUE_INVALID", details: { setting: "port" } },
    });
  });
  test("uses the preferred port when it is free", async () => {
    const occupied = await occupyPort();
    const preferred = occupied + 1;
    const result = await selectAvailableLoopbackPort(preferred, 1);
    expect(result).toEqual({
      ok: true,
      value: {
        hostname: "127.0.0.1",
        port: preferred,
        preferredPort: preferred,
        usedFallback: false,
      },
    });
  });

  test("selects the next loopback port when the preferred port is occupied", async () => {
    const preferred = await occupyPort();
    const result = await selectAvailableLoopbackPort(preferred, 10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hostname).toBe("127.0.0.1");
      expect(result.value.port).toBeGreaterThan(preferred);
      expect(result.value.usedFallback).toBe(true);
    }
  });

  test("returns an actionable conflict when its search range is exhausted", async () => {
    const preferred = await occupyPort();
    const result = await selectAvailableLoopbackPort(preferred, 1);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PORT_UNAVAILABLE",
        details: { attempts: 1, preferredPort: preferred },
      },
    });
  });

  test("caps the fallback range at the highest valid port", async () => {
    const result = await selectAvailableLoopbackPort(65_535, 20, async () => ({
      ok: true,
      value: false,
    }));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PORT_UNAVAILABLE", details: { attempts: 1, preferredPort: 65_535 } },
    });
  });
});
