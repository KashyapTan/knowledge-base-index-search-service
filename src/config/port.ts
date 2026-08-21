import { createServer } from "node:net";
import { err, ok, type Result } from "../shared/result.ts";
import { type ConfigurationError, LOOPBACK_HOST } from "./contracts.ts";

export interface PortSelection {
  readonly hostname: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly preferredPort: number;
  readonly usedFallback: boolean;
}

export type PortProbe = (port: number) => Promise<Result<boolean, ConfigurationError>>;

export function classifyPortBindError(
  code: string | undefined,
  port: number,
): Result<boolean, ConfigurationError> {
  if (code === "EADDRINUSE") return ok(false);
  return err({
    code: "PORT_CHECK_FAILED",
    message: "The loopback port could not be checked.",
    details: { port },
  });
}

function portIsAvailable(port: number): Promise<Result<boolean, ConfigurationError>> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      resolve(classifyPortBindError(error.code, port));
    });
    probe.listen(port, LOOPBACK_HOST, () => {
      probe.close(() => {
        resolve(ok(true));
      });
    });
  });
}

export async function selectAvailableLoopbackPort(
  preferredPort: number,
  maxAttempts = 20,
  probe: PortProbe = portIsAvailable,
): Promise<Result<PortSelection, ConfigurationError>> {
  if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65_535) {
    return err({
      code: "CONFIG_VALUE_INVALID",
      message: "port must be an integer from 1 through 65535.",
      details: { setting: "port" },
    });
  }
  const requestedAttempts = Math.max(1, maxAttempts);
  const finalPort = Math.min(65_535, preferredPort + requestedAttempts - 1);
  for (let port = preferredPort; port <= finalPort; port += 1) {
    const available = await probe(port);
    if (!available.ok) return available;
    if (available.value) {
      return ok({
        hostname: LOOPBACK_HOST,
        port,
        preferredPort,
        usedFallback: port !== preferredPort,
      });
    }
  }
  return err({
    code: "PORT_UNAVAILABLE",
    message: "No available loopback port was found in the configured range.",
    details: { attempts: finalPort - preferredPort + 1, preferredPort },
  });
}
