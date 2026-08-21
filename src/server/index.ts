import { isAbsolute, relative, resolve } from "node:path";
import {
  type AppConfig,
  type CompatibilityAssessment,
  type CompatibilityError,
  type ConfigurationError,
  LOOPBACK_HOST,
  type LoadAppConfigOptions,
  loadAppConfig,
  type PortSelection,
  readCompatibilityMetadata,
  selectAvailableLoopbackPort,
} from "../config/index.ts";
import { err, ok, type Result } from "../shared/result.ts";

export interface FoundationServerOptions {
  readonly port?: number;
  readonly uiDistDir?: string;
}

export interface ConfiguredFoundationServer {
  readonly compatibility: CompatibilityAssessment;
  readonly config: AppConfig;
  readonly portSelection: PortSelection;
  readonly server: Bun.Server<undefined>;
}

const defaultUiDistDir = resolve(import.meta.dir, "../../dist/ui");

function isInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

async function serveUi(pathname: string, uiDistDir: string): Promise<Response> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return new Response("Invalid path", { status: 400 });
  }

  const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const assetPath = resolve(uiDistDir, `.${requestedPath}`);
  if (!isInside(uiDistDir, assetPath)) return new Response("Not found", { status: 404 });

  const asset = Bun.file(assetPath);
  if (await asset.exists()) return new Response(asset);

  const index = Bun.file(resolve(uiDistDir, "index.html"));
  if ((await index.exists()) && !requestedPath.includes(".")) return new Response(index);

  return new Response("UI assets are not built.", { status: 404 });
}

export function createFoundationServer(
  options: FoundationServerOptions = {},
): Bun.Server<undefined> {
  const uiDistDir = resolve(options.uiDistDir ?? defaultUiDistDir);

  return Bun.serve({
    hostname: LOOPBACK_HOST,
    port: options.port ?? 3210,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/health") {
        return Response.json({ service: "kbiss", status: "ok" });
      }
      return serveUi(url.pathname, uiDistDir);
    },
  });
}

export async function startConfiguredFoundationServer(
  options: LoadAppConfigOptions = {},
): Promise<Result<ConfiguredFoundationServer, ConfigurationError | CompatibilityError>> {
  const loaded = await loadAppConfig(options);
  if (!loaded.ok) return loaded;
  const compatibility = await readCompatibilityMetadata(
    loaded.value.paths.compatibilityFile,
    loaded.value.compatibility,
  );
  if (!compatibility.ok) return compatibility;
  const portSelection = await selectAvailableLoopbackPort(loaded.value.server.port);
  if (!portSelection.ok) return portSelection;

  try {
    const server = createFoundationServer({ port: portSelection.value.port });
    return ok({
      compatibility: compatibility.value,
      config: loaded.value,
      portSelection: portSelection.value,
      server,
    });
  } catch {
    return err({
      code: "SERVER_START_FAILED",
      message: "The local HTTP server could not be started on the selected loopback port.",
      details: { port: portSelection.value.port },
    });
  }
}

if (import.meta.main) {
  const startup = await startConfiguredFoundationServer();
  if (!startup.ok) {
    console.error(`[${startup.error.code}] ${startup.error.message}`);
    process.exitCode = 1;
  } else {
    if (startup.value.portSelection.usedFallback) {
      console.info(
        `Port ${startup.value.portSelection.preferredPort} was busy; using ${startup.value.portSelection.port}.`,
      );
    }
    console.info(
      `KBISS foundation server listening at ${startup.value.server.url} (${startup.value.compatibility.status})`,
    );
  }
}
