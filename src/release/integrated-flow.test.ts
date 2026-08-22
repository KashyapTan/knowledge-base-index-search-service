import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAppConfig } from "../config/index.ts";
import { createDiscoveryService } from "../discovery/index.ts";
import { FixtureSemanticEmbeddingProvider } from "../evaluation/index.ts";
import { createExtractionPipeline, createUnicodeWordTokenCounter } from "../extraction/index.ts";
import { createIndexingService, type LanceIndexStore, openLanceIndex } from "../indexing/index.ts";
import {
  createSearchService,
  type LanceCandidateRetriever,
  openLanceCandidateRetriever,
} from "../search/index.ts";

function expectOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("integrated incremental search release path", () => {
  test("keeps add, atomic edit, delete, and rename searchable without stale records", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "kbiss-integrated-release-"));
    const root = join(temporary, "source");
    const source = resolve(import.meta.dir, "../../fixtures/relevance/repository");
    const embeddings = new FixtureSemanticEmbeddingProvider();
    let store: LanceIndexStore | undefined;
    let retriever: LanceCandidateRetriever | undefined;
    try {
      await cp(source, root, { recursive: true });
      const loaded = await loadAppConfig({
        argv: ["--root", root],
        env: {
          KBISS_STATE_DIR: join(temporary, "state"),
          KBISS_CACHE_DIR: join(temporary, "cache"),
        },
        projectDir: resolve(import.meta.dir, "../.."),
      });
      const baseConfig = expectOk(loaded);
      const config = {
        ...baseConfig,
        embedding: embeddings.config,
        compatibility: { ...baseConfig.compatibility, embedding: embeddings.config },
      };
      const discovery = expectOk(await createDiscoveryService(config));
      store = expectOk(await openLanceIndex(config));
      const extraction = createExtractionPipeline(
        config,
        createUnicodeWordTokenCounter(),
        embeddings.identity.maximumTokens,
      );
      const indexing = createIndexingService(config, { extraction, embeddings, store });
      let scan = expectOk(await discovery.scanner.scan("scan"));
      expectOk(await indexing.indexFiles(scan.files));
      retriever = expectOk(await openLanceCandidateRetriever(config));
      const search = createSearchService({ embeddings, retriever });
      const paths = async (query: string) =>
        expectOk(await search.search({ query, fileCount: 10 })).results.map(
          (result) => result.relativePath,
        );
      expect(await paths("payment-retries.md")).toContain("docs/payment-retries.md");

      const configPath = join(root, "src/config/payment.ts");
      const pending = `${configPath}.pending`;
      await writeFile(pending, (await readFile(configPath, "utf8")).replace("5_000", "7_000"));
      await rename(pending, configPath);
      scan = expectOk(await discovery.scanner.scan("reconcile"));
      expect(scan.changes.some((change) => change.kind === "content-changed")).toBe(true);
      expectOk(await indexing.applyChanges(scan.changes));
      expect(await paths("7_000")).toContain("src/config/payment.ts");

      const addedPath = join(root, "src/recovery.ts");
      await writeFile(
        addedPath,
        "export function recoverGatewaySession() { return 'recovered'; }\n",
      );
      scan = expectOk(await discovery.scanner.scan("reconcile"));
      expectOk(await indexing.applyChanges(scan.changes));
      expect(await paths("recovery.ts")).toContain("src/recovery.ts");

      await unlink(join(root, "docs/troubleshooting.html"));
      scan = expectOk(await discovery.scanner.scan("reconcile"));
      expectOk(await indexing.applyChanges(scan.changes));
      expect(await paths('"Gateway handshake failed: certificate pin mismatch"')).not.toContain(
        "docs/troubleshooting.html",
      );

      await mkdir(join(root, "guides"), { recursive: true });
      await rename(join(root, "docs/idempotency.md"), join(root, "guides/safe-replay.md"));
      scan = expectOk(await discovery.scanner.scan("reconcile"));
      expect(scan.changes.filter((change) => change.kind === "deleted")).toHaveLength(1);
      expectOk(await indexing.applyChanges(scan.changes));
      const renamed = await paths("safe-replay.md");
      expect(renamed).toContain("guides/safe-replay.md");
      expect(renamed).not.toContain("docs/idempotency.md");

      scan = expectOk(await discovery.scanner.scan("reconcile"));
      const noChange = expectOk(await indexing.indexFiles(scan.files));
      expect(noChange.progress.unchangedFiles).toBe(scan.files.length);
      expect(noChange.progress.failedFiles).toBe(0);
    } finally {
      retriever?.close();
      store?.close();
      await embeddings.shutdown();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("persists and searches only contiguous excerpts from an oversized fallback unit", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "kbiss-integrated-chunk-regression-"));
    const root = join(temporary, "source");
    const embeddings = new FixtureSemanticEmbeddingProvider();
    let store: LanceIndexStore | undefined;
    let retriever: LanceCandidateRetriever | undefined;
    try {
      await mkdir(root, { recursive: true });
      const relativePath = "QuarterlyStatusCalculator.java";
      const source = [
        "public final class QuarterlyStatusCalculator {",
        ...Array.from(
          { length: 90 },
          (_, index) =>
            `  private final java.math.BigDecimal quarterlyValue${index} = java.math.BigDecimal.valueOf(${index});`,
        ),
        "}",
      ].join("\n");
      await writeFile(join(root, relativePath), source);
      const loaded = await loadAppConfig({
        argv: ["--root", root],
        env: {
          KBISS_STATE_DIR: join(temporary, "state"),
          KBISS_CACHE_DIR: join(temporary, "cache"),
        },
        projectDir: resolve(import.meta.dir, "../.."),
      });
      const baseConfig = expectOk(loaded);
      const config = {
        ...baseConfig,
        embedding: embeddings.config,
        compatibility: { ...baseConfig.compatibility, embedding: embeddings.config },
      };
      const discovery = expectOk(await createDiscoveryService(config));
      const scan = expectOk(await discovery.scanner.scan("scan"));
      const file = scan.files.find((candidate) => candidate.relativePath === relativePath);
      expect(file?.format).toBe("text");
      store = expectOk(await openLanceIndex(config));
      const extraction = createExtractionPipeline(
        config,
        createUnicodeWordTokenCounter(),
        embeddings.identity.maximumTokens,
      );
      const indexing = createIndexingService(config, { extraction, embeddings, store });
      const indexed = expectOk(await indexing.indexFiles(scan.files));
      expect(indexed.progress.failedFiles).toBe(0);
      const chunks = expectOk(await store.getChunks(file?.fileId ?? "missing"));
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => source.includes(chunk.displayText))).toBeTrue();

      retriever = expectOk(await openLanceCandidateRetriever(config));
      const search = createSearchService({ embeddings, retriever });
      const response = expectOk(await search.search({ query: "calculator", fileCount: 5 }));
      const result = response.results.find((candidate) => candidate.relativePath === relativePath);
      expect(result).toBeDefined();
      expect(result?.excerpts.length).toBeGreaterThan(0);
      expect(result?.excerpts.every((excerpt) => source.includes(excerpt.text))).toBeTrue();
    } finally {
      retriever?.close();
      store?.close();
      await embeddings.shutdown();
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
