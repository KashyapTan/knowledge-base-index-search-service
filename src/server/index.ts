import { resolve } from "node:path";
import {
  APPLICATION_NAME,
  APPLICATION_VERSION,
  type AppConfig,
  type ConfigurationError,
  initialStartupState,
  LOOPBACK_HOST,
  type LoadAppConfigOptions,
  loadAppConfig,
  StartupStateStore,
  selectAvailableLoopbackPort,
} from "../config/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import { API_PREFIX, type ApiError, type ApplicationServicesFactory } from "./contracts.ts";
import { parseLastEventId } from "./progress.ts";
import { ApplicationRuntime } from "./runtime.ts";
import { isWithinRoot, requestSecurityError, withSecurityHeaders } from "./security.ts";
import {
  readJsonBody,
  validateActionBody,
  validateFileId,
  validateSearchBody,
} from "./validation.ts";

export type {
  ApiError,
  ApiErrorCode,
  ApplicationEventData,
  ApplicationServices,
  ApplicationServicesFactory,
  ApplicationStatus,
  FileMetadataResponse,
  OpenFileChange,
  SequencedApplicationEvent,
} from "./contracts.ts";
export { API_PREFIX, MAX_FILE_BYTES, MAX_REQUEST_BYTES } from "./contracts.ts";
export { SafeFileAccess } from "./file-access.ts";
export { ApplicationEventHub, parseLastEventId } from "./progress.ts";
export { ApplicationRuntime, createProductionServices } from "./runtime.ts";
export {
  isExpectedHost,
  isExpectedOrigin,
  isWithinRoot,
  SECURITY_HEADERS,
  withSecurityHeaders,
} from "./security.ts";
export {
  readJsonBody,
  validateActionBody,
  validateFileId,
  validateSearchBody,
} from "./validation.ts";

const defaultUiDistDir = resolve(import.meta.dir, "../../dist/ui");

function apiResponse(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, {
    status,
    headers: withSecurityHeaders({ "Cache-Control": "no-store", ...headers }),
  });
}

function errorResponse(error: ApiError, headers: HeadersInit = {}): Response {
  return apiResponse(
    { error: { code: error.code, message: error.message } },
    error.status,
    headers,
  );
}

function methodNotAllowed(allow: string): Response {
  return errorResponse(
    { code: "METHOD_NOT_ALLOWED", message: "The request method is not allowed.", status: 405 },
    { Allow: allow },
  );
}

async function serveUi(pathname: string, uiDistDir: string): Promise<Response> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return errorResponse({
      code: "NOT_FOUND",
      message: "The requested page is invalid.",
      status: 400,
    });
  }
  if (decodedPath.includes("\0")) {
    return errorResponse({
      code: "NOT_FOUND",
      message: "The requested page was not found.",
      status: 404,
    });
  }
  const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const assetPath = resolve(uiDistDir, `.${requestedPath}`);
  if (!isWithinRoot(uiDistDir, assetPath)) {
    return errorResponse({
      code: "NOT_FOUND",
      message: "The requested page was not found.",
      status: 404,
    });
  }
  const asset = Bun.file(assetPath);
  if (await asset.exists()) {
    const immutable = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/u.test(requestedPath);
    const html = requestedPath.endsWith(".html");
    return new Response(asset, {
      headers: withSecurityHeaders({
        "Cache-Control": html
          ? "no-cache"
          : immutable
            ? "public, max-age=31536000, immutable"
            : "public, max-age=0, must-revalidate",
        "Content-Type": asset.type || "application/octet-stream",
      }),
    });
  }
  const index = Bun.file(resolve(uiDistDir, "index.html"));
  if ((await index.exists()) && !requestedPath.includes(".")) {
    return new Response(index, {
      headers: withSecurityHeaders({
        "Cache-Control": "no-cache",
        "Content-Type": "text/html; charset=utf-8",
      }),
    });
  }
  return new Response("UI assets are not built.", {
    status: 404,
    headers: withSecurityHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
  });
}

function routeFilePath(
  pathname: string,
): { readonly fileId: string; readonly content: boolean } | undefined {
  const match = /^\/api\/v1\/files\/([^/]+)(\/content)?$/u.exec(pathname);
  if (!match?.[1]) return undefined;
  let fileId: string;
  try {
    fileId = decodeURIComponent(match[1]);
  } catch {
    return { fileId: "", content: match[2] !== undefined };
  }
  return { fileId, content: match[2] !== undefined };
}

export interface ApplicationServerOptions {
  readonly port?: number;
  readonly uiDistDir?: string;
}

export function createApplicationServer(
  runtime: ApplicationRuntime,
  options: ApplicationServerOptions = {},
): Bun.Server<undefined> {
  const uiDistDir = resolve(options.uiDistDir ?? defaultUiDistDir);
  const configuredPort = options.port ?? runtime.config.server.port;
  let actualPort = configuredPort;
  const server = Bun.serve({
    hostname: LOOPBACK_HOST,
    port: configuredPort,
    async fetch(request) {
      try {
        const securityError = requestSecurityError(request, actualPort);
        if (securityError) return errorResponse(securityError);
        const url = new URL(request.url);
        const { pathname } = url;

        if (pathname === `${API_PREFIX}/health` || pathname === "/api/health") {
          if (request.method !== "GET") return methodNotAllowed("GET");
          return apiResponse({
            service: APPLICATION_NAME,
            version: APPLICATION_VERSION,
            status: "ok",
            phase: runtime.status().startup.phase,
            rootIdentity: runtime.config.sourceRoots[0].identity,
          });
        }
        if (pathname === `${API_PREFIX}/status`) {
          if (request.method !== "GET") return methodNotAllowed("GET");
          return apiResponse(runtime.status());
        }
        if (pathname === `${API_PREFIX}/events`) {
          if (request.method !== "GET") return methodNotAllowed("GET");
          return new Response(
            runtime.events.stream(parseLastEventId(request.headers.get("last-event-id")), () =>
              runtime.status(),
            ),
            {
              headers: withSecurityHeaders({
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "Content-Type": "text/event-stream; charset=utf-8",
              }),
            },
          );
        }
        if (pathname === `${API_PREFIX}/search`) {
          if (request.method !== "POST") return methodNotAllowed("POST");
          const body = await readJsonBody(request);
          if (!body.ok) return errorResponse(body.error);
          const validated = validateSearchBody(body.value);
          if (!validated.ok) return errorResponse(validated.error);
          const result = await runtime.search(validated.value, request.signal);
          return result.ok ? apiResponse(result.value) : errorResponse(result.error);
        }
        if (pathname === `${API_PREFIX}/actions/reconcile`) {
          if (request.method !== "POST") return methodNotAllowed("POST");
          if (request.headers.get("x-kbiss-csrf") !== runtime.csrfToken) {
            return errorResponse({
              code: "CSRF_TOKEN_INVALID",
              message: "A valid same-origin action token is required.",
              status: 403,
            });
          }
          const body = await readJsonBody(request);
          if (!body.ok) return errorResponse(body.error);
          const validated = validateActionBody(body.value);
          if (!validated.ok) return errorResponse(validated.error);
          const result = await runtime.runAction(validated.value);
          return result.ok
            ? apiResponse({ accepted: true, mode: validated.value })
            : errorResponse(result.error);
        }
        const fileRoute = routeFilePath(pathname);
        if (fileRoute) {
          if (request.method !== "GET") return methodNotAllowed("GET");
          if (!validateFileId(fileRoute.fileId)) {
            return errorResponse({
              code: "FILE_ID_INVALID",
              message: "The file ID is invalid.",
              status: 400,
            });
          }
          if (fileRoute.content) {
            const content = await runtime.fileContent(fileRoute.fileId);
            if (!content) {
              return errorResponse({
                code: "FILE_NOT_FOUND",
                message: "The requested file is not available.",
                status: 503,
              });
            }
            return content.ok ? content.value : errorResponse(content.error);
          }
          const metadata = runtime.fileMetadata(fileRoute.fileId);
          if (!metadata) {
            return errorResponse({
              code: "FILE_NOT_FOUND",
              message: "The requested file is not available.",
              status: 503,
            });
          }
          return metadata.ok ? apiResponse(metadata.value) : errorResponse(metadata.error);
        }
        if (
          pathname === API_PREFIX ||
          pathname.startsWith(`${API_PREFIX}/`) ||
          pathname.startsWith("/api/")
        ) {
          return errorResponse({
            code: "NOT_FOUND",
            message: "The API route was not found.",
            status: 404,
          });
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed("GET, HEAD");
        }
        return serveUi(pathname, uiDistDir);
      } catch {
        return errorResponse({
          code: "INTERNAL_ERROR",
          message: "The request could not be completed.",
          status: 500,
        });
      }
    },
  });
  actualPort = server.port ?? configuredPort;
  return server;
}

/** Plan 1 compatibility harness; production launches use createApplicationServer. */
export function createFoundationServer(
  options: { readonly port?: number; readonly uiDistDir?: string } = {},
): Bun.Server<undefined> {
  const uiDistDir = resolve(options.uiDistDir ?? defaultUiDistDir);
  return Bun.serve({
    hostname: LOOPBACK_HOST,
    port: options.port ?? 3210,
    async fetch(request) {
      if (new URL(request.url).pathname === "/api/health") {
        return Response.json({ service: APPLICATION_NAME, status: "ok" });
      }
      return serveUi(new URL(request.url).pathname, uiDistDir);
    },
  });
}

export interface StartedApplication {
  readonly kind: "started";
  readonly config: AppConfig;
  readonly runtime: ApplicationRuntime;
  readonly server: Bun.Server<undefined>;
  readonly ready: Promise<void>;
  readonly url: URL;
  shutdown(): Promise<void>;
}

export interface ExistingApplication {
  readonly kind: "existing";
  readonly url: URL;
}

export type ApplicationLaunch = StartedApplication | ExistingApplication;

export async function findCompatibleInstance(
  config: AppConfig,
): Promise<ExistingApplication | undefined> {
  const lastPort = Math.min(65_535, config.server.port + 19);
  const probes = Array.from({ length: lastPort - config.server.port + 1 }, async (_, offset) => {
    const url = new URL(`http://${LOOPBACK_HOST}:${config.server.port + offset}`);
    try {
      const response = await fetch(new URL(`${API_PREFIX}/health`, url), {
        signal: AbortSignal.timeout(300),
      });
      if (!response.ok) return undefined;
      const health = (await response.json()) as Record<string, unknown>;
      return health.service === APPLICATION_NAME &&
        health.version === APPLICATION_VERSION &&
        health.rootIdentity === config.sourceRoots[0].identity
        ? ({ kind: "existing", url } as const)
        : undefined;
    } catch {
      return undefined;
    }
  });
  return (await Promise.all(probes)).find((instance) => instance !== undefined);
}

export interface StartApplicationOptions extends LoadAppConfigOptions {
  readonly factory?: ApplicationServicesFactory;
  readonly maxConcurrentSearches?: number;
  readonly openBrowser?: (url: URL) => void | Promise<void>;
  readonly serverFactory?: typeof createApplicationServer;
  readonly uiDistDir?: string;
}

export async function startApplication(
  options: StartApplicationOptions = {},
): Promise<Result<ApplicationLaunch, ConfigurationError>> {
  const loaded = await loadAppConfig(options);
  if (!loaded.ok) return loaded;
  const existing = await findCompatibleInstance(loaded.value);
  if (existing) {
    await options.openBrowser?.(existing.url);
    return ok(existing);
  }
  const selected = await selectAvailableLoopbackPort(loaded.value.server.port);
  if (!selected.ok) return selected;
  const config: AppConfig = {
    ...loaded.value,
    server: { hostname: LOOPBACK_HOST, port: selected.value.port },
  };
  const state = new StartupStateStore(initialStartupState());
  state.dispatch({ type: "begin_validation" });
  state.dispatch({ type: "configuration_validated" });
  const runtime = new ApplicationRuntime(config, state, {
    ...(options.factory ? { factory: options.factory } : {}),
    ...(options.maxConcurrentSearches === undefined
      ? {}
      : { maxConcurrentSearches: options.maxConcurrentSearches }),
  });
  let server: Bun.Server<undefined>;
  try {
    server = (options.serverFactory ?? createApplicationServer)(runtime, {
      port: selected.value.port,
      ...(options.uiDistDir ? { uiDistDir: options.uiDistDir } : {}),
    });
  } catch {
    await runtime.shutdown();
    return err({
      code: "SERVER_START_FAILED",
      message: "The local HTTP server could not be started on the selected loopback port.",
      details: { port: selected.value.port },
    });
  }
  const url = server.url;
  const ready = runtime.initialize();
  let shutdownPromise: Promise<void> | undefined;
  const started: StartedApplication = {
    kind: "started",
    config,
    runtime,
    server,
    ready,
    url,
    shutdown() {
      shutdownPromise ??= (async () => {
        await runtime.shutdown();
        await server.stop(true);
      })();
      return shutdownPromise;
    },
  };
  await options.openBrowser?.(url);
  return ok(started);
}
