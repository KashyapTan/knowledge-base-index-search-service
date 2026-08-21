import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initialStartupState, StartupStateStore } from "../src/config/index.ts";
import { indexableFile, indexingConfig } from "../src/indexing/test-helpers.ts";
import type { SearchResponse } from "../src/search/index.ts";
import { ApplicationRuntime, createApplicationServer } from "../src/server/index.ts";
import { fixtureServices } from "../src/server/test-helpers.ts";
import { ok } from "../src/shared/result.ts";

const port = Number(process.env.KBISS_E2E_PORT ?? 4328);
const fixtureDir = await realpath(await mkdtemp(join(tmpdir(), "kbiss-ui-e2e-")));
const root = join(fixtureDir, "card-gateway-artifacts");
const stateDir = join(fixtureDir, "state");
const cacheDir = join(fixtureDir, "cache");
await Promise.all([
  mkdir(join(root, "docs"), { recursive: true }),
  mkdir(join(root, "packages"), { recursive: true }),
  mkdir(join(root, "fixtures"), { recursive: true }),
  mkdir(stateDir),
  mkdir(cacheDir),
]);

const gatewayPath = join(root, "docs/gateway.md");
const clientPath = join(root, "packages/client.ts");
const unsafeHtmlPath = join(root, "fixtures/unsafe.html");
await Promise.all([
  writeFile(
    gatewayPath,
    `# Gateway
Set timeout_ms before retrying.

| Setting | Value |
| --- | --- |
| Timeout | 5000 |

[Safe external](https://example.com/docs) [Unsafe](javascript:alert(1)) [Local](file:///tmp/secret) [Data](data:text/html,bad)

<script>window.markdownPwned = true</script>
<img src="https://bad.invalid/pixel" onerror="window.markdownPwned=true">
<form action="https://bad.invalid"><input autofocus></form>
<iframe srcdoc="<script>parent.markdownPwned=true</script>"></iframe>

\`\`\`mermaid
flowchart LR
  Search --> Viewer
\`\`\`

\`\`\`plantuml
Alice -> Bob: Safe source fallback
\`\`\`
`,
  ),
  writeFile(clientPath, "export const timeout_ms = 5000;\n"),
  writeFile(
    unsafeHtmlPath,
    `<h1>HTML fixture</h1><p onclick="parent.htmlPwned=true">Visible text</p><script>parent.htmlPwned=true</script><form action="https://bad.invalid"><input></form><iframe src="https://bad.invalid"></iframe><img src="https://bad.invalid/pixel"><a href="javascript:alert(1)">Unsafe HTML link</a><a href="https://example.com/docs">Safe HTML link</a>`,
  ),
]);

const config = {
  ...indexingConfig(root, stateDir, cacheDir),
  server: { hostname: "127.0.0.1" as const, port },
};
const gateway = indexableFile("docs/gateway.md", "gateway-content", {
  canonicalPath: gatewayPath,
  rootIdentity: config.sourceRoots[0].identity,
  filename: "gateway.md",
});
const client = indexableFile("packages/client.ts", "client-content", {
  canonicalPath: clientPath,
  rootIdentity: config.sourceRoots[0].identity,
  filename: "client.ts",
  extension: ".ts",
  format: "typescript",
  mimeFamily: "text/typescript",
});
const unsafeHtml = indexableFile("fixtures/unsafe.html", "html-content", {
  canonicalPath: unsafeHtmlPath,
  rootIdentity: config.sourceRoots[0].identity,
  filename: "unsafe.html",
  extension: ".html",
  format: "html",
  mimeFamily: "text/html",
});
const services = fixtureServices(config, [gateway, client, unsafeHtml]);
services.search.responseFactory = (request): SearchResponse => ({
  query: request.query.trim(),
  requestedFileCount: request.fileCount ?? 10,
  formats: request.formats ?? [],
  timing: {
    totalMs: 4,
    embeddingMs: 1,
    retrievalMs: 1,
    vectorMs: 1,
    bm25Ms: 1,
    metadataMs: 1,
    fusionMs: 0.5,
    aggregationMs: 0.5,
  },
  results: [
    {
      fileId: gateway.fileId,
      relativePath: gateway.relativePath,
      filename: gateway.filename,
      format: gateway.format,
      score: 0.2,
      matchSources: ["metadata", "bm25"],
      excerpts: [
        {
          chunkId: "gateway-primary",
          text: "Set timeout_ms before retrying the gateway request.",
          startLine: 2,
          endLine: 2,
          startOffset: 10,
          endOffset: 55,
          headingTrail: ["Gateway"],
          symbols: [],
          score: 0.2,
          matchSources: ["bm25"],
          highlightTerms: ["timeout_ms"],
        },
        {
          chunkId: "gateway-secondary",
          text: "A second timeout_ms policy applies to fallback requests.",
          startLine: 18,
          endLine: 20,
          startOffset: 120,
          endOffset: 180,
          headingTrail: ["Gateway", "Fallback"],
          symbols: [],
          score: 0.1,
          matchSources: ["vector"],
          highlightTerms: ["timeout_ms"],
        },
      ],
    },
    {
      fileId: client.fileId,
      relativePath: client.relativePath,
      filename: client.filename,
      format: client.format,
      score: 0.1,
      matchSources: ["metadata"],
      excerpts: [
        {
          chunkId: "client-primary",
          text: "export const timeout_ms = 5000;",
          startLine: 1,
          endLine: 1,
          startOffset: 0,
          endOffset: 31,
          headingTrail: [],
          symbols: ["timeout_ms"],
          score: 0.1,
          matchSources: ["metadata"],
          highlightTerms: ["timeout_ms"],
        },
      ],
    },
    {
      fileId: unsafeHtml.fileId,
      relativePath: unsafeHtml.relativePath,
      filename: unsafeHtml.filename,
      format: unsafeHtml.format,
      score: 0.05,
      matchSources: ["metadata"],
      excerpts: [
        {
          chunkId: "html-primary",
          text: "HTML fixture with visible content.",
          startLine: 1,
          endLine: 1,
          startOffset: 0,
          endOffset: 30,
          headingTrail: ["HTML fixture"],
          symbols: [],
          score: 0.05,
          matchSources: ["metadata"],
          highlightTerms: [],
        },
      ],
    },
  ],
});

const startup = new StartupStateStore(initialStartupState());
startup.dispatch({ type: "begin_validation" });
startup.dispatch({ type: "configuration_validated" });
const runtime = new ApplicationRuntime(config, startup, {
  csrfToken: "playwright-fixture",
  factory: async () => ok(services),
});
const server = createApplicationServer(runtime, {
  port,
  uiDistDir: resolve(import.meta.dir, "../dist/ui"),
});
await runtime.initialize();
process.stdout.write(`KBISS UI fixture listening at ${server.url}\n`);

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await runtime.shutdown();
  await server.stop(true);
  await rm(fixtureDir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
await new Promise(() => undefined);
