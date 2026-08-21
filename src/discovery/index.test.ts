import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config/index.ts";
import { DEFAULT_EMBEDDING_CONFIG, DEFAULT_INDEX_CONFIG } from "../config/index.ts";
import { createDiscoveryService } from "./index.ts";

let fixture = "";

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "kbiss-discovery-service-")));
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe("discovery service composition", () => {
  test("uses the configured root and external metadata directory", async () => {
    const root = join(fixture, "source");
    const state = join(fixture, "state");
    const cache = join(fixture, "cache");
    const metadata = join(state, "metadata");
    await Promise.all([mkdir(root), mkdir(metadata, { recursive: true }), mkdir(cache)]);
    await writeFile(join(root, "document.md"), "# Document");
    const config: AppConfig = {
      embedding: DEFAULT_EMBEDDING_CONFIG,
      index: DEFAULT_INDEX_CONFIG,
      sourceRoots: [{ identity: "root-id", path: root }],
      server: { hostname: "127.0.0.1", port: 3210 },
      paths: {
        applicationCacheDir: cache,
        applicationStateDir: state,
        compatibilityFile: join(metadata, "compatibility.json"),
        diagnosticLogsDir: join(state, "logs"),
        indexDir: state,
        indexMetadataDir: metadata,
        indexNamespace: "index",
        lanceDbDir: join(state, "lancedb"),
        modelCacheDir: join(cache, "models"),
        rootNamespace: "root",
      },
      compatibility: {
        applicationVersion: "0.1.0",
        chunking: {
          overlapTokens: DEFAULT_INDEX_CONFIG.chunkOverlapTokens,
          sizeTokens: DEFAULT_INDEX_CONFIG.chunkSizeTokens,
          version: DEFAULT_INDEX_CONFIG.chunkerVersion,
        },
        descriptorVersion: 1,
        embedding: DEFAULT_EMBEDDING_CONFIG,
        extractorVersion: DEFAULT_INDEX_CONFIG.extractorVersion,
        indexSchemaVersion: DEFAULT_INDEX_CONFIG.schemaVersion,
        rootIdentity: "root-id",
      },
    };

    const service = await createDiscoveryService(config, {
      scanner: { concurrency: 2, ignorePatterns: ["ignored/**"] },
    });
    expect(service.ok).toBe(true);
    if (!service.ok) return;
    const scan = await service.value.scanner.scan();
    expect(scan.ok).toBe(true);
    expect(service.value.manifest.snapshot()[0]?.relativePath).toBe("document.md");
    expect(await Bun.file(join(metadata, "file-manifest.json")).exists()).toBe(true);
    expect(await Bun.file(join(root, "file-manifest.json")).exists()).toBe(false);
  });
});
