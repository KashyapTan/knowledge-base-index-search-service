import { isAbsolute, relative, resolve } from "node:path";

export interface FoundationServerOptions {
  readonly hostname?: string;
  readonly port?: number;
  readonly uiDistDir?: string;
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
  const hostname = options.hostname ?? "127.0.0.1";
  const uiDistDir = resolve(options.uiDistDir ?? defaultUiDistDir);

  return Bun.serve({
    hostname,
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

if (import.meta.main) {
  const server = createFoundationServer();
  console.info(`KBISS foundation server listening at ${server.url}`);
}
