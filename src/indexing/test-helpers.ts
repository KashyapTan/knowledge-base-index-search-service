import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { AppConfig } from "../config/index.ts";
import { DEFAULT_INDEX_CONFIG } from "../config/index.ts";
import type { DiscoveredFile } from "../discovery/index.ts";
import type { ExtractedFile, ExtractionPipeline, SearchChunk } from "../extraction/index.ts";
import { ok } from "../shared/result.ts";
import { fakeEmbeddingProfile } from "./fake-embedding-provider.ts";

export function indexingConfig(
  root: string,
  state: string,
  cache: string,
  dimension = 4,
): AppConfig {
  const embedding = {
    device: "cpu" as const,
    modelId: "kbiss/deterministic-fake",
    nativeDimension: dimension,
    normalization: "l2" as const,
    profile: fakeEmbeddingProfile(),
    quantization: "fp32" as const,
    vectorDimension: dimension,
  };
  const metadata = join(state, "metadata");
  return {
    embedding,
    ignorePatterns: [],
    index: DEFAULT_INDEX_CONFIG,
    offline: false,
    sourceRoots: [{ identity: "indexing-test-root", path: root }],
    server: { hostname: "127.0.0.1", port: 3210 },
    paths: {
      applicationCacheDir: cache,
      applicationStateDir: state,
      compatibilityFile: join(metadata, "compatibility.json"),
      diagnosticLogsDir: join(state, "logs"),
      indexDir: state,
      indexMetadataDir: metadata,
      indexNamespace: "test-index",
      lanceDbDir: join(state, "lancedb"),
      modelCacheDir: join(cache, "models"),
      rootNamespace: "test-root",
    },
    compatibility: {
      applicationVersion: "0.1.0",
      chunking: {
        overlapTokens: DEFAULT_INDEX_CONFIG.chunkOverlapTokens,
        sizeTokens: DEFAULT_INDEX_CONFIG.chunkSizeTokens,
        version: DEFAULT_INDEX_CONFIG.chunkerVersion,
      },
      descriptorVersion: 3,
      embedding,
      extractorVersion: DEFAULT_INDEX_CONFIG.extractorVersion,
      indexSchemaVersion: DEFAULT_INDEX_CONFIG.schemaVersion,
      rootIdentity: "indexing-test-root",
    },
  };
}

export function indexableFile(
  relativePath: string,
  contentHash: string,
  overrides: Partial<DiscoveredFile> = {},
): DiscoveredFile {
  return {
    fileId: createHash("sha256").update(relativePath).digest("hex"),
    rootIdentity: "indexing-test-root",
    relativePath,
    canonicalPath: `/fixture/${relativePath}`,
    filename: basename(relativePath),
    extension: ".md",
    format: "markdown",
    mimeFamily: "text/markdown",
    fingerprint: {
      size: contentHash.length,
      modifiedAtMs: 10,
      modifiedAtNs: "10000000",
      changedAtNs: "10000000",
      timestampPrecisionMs: 1,
      contentHash,
    },
    readStatus: "ready",
    indexStatus: "pending",
    ...overrides,
  };
}

export function searchChunk(
  file: DiscoveredFile,
  id: string,
  text: string,
  ordinal: number,
): SearchChunk {
  return {
    chunkId: id,
    fileId: file.fileId,
    relativePath: file.relativePath,
    ordinal,
    displayText: text,
    searchText: `Path: ${file.relativePath}\n${text}`,
    startLine: ordinal + 1,
    endLine: ordinal + 1,
    startOffset: ordinal * 10,
    endOffset: ordinal * 10 + text.length,
    headingTrail: ["Section"],
    symbols: [],
    contentHash: createHash("sha256").update(text).digest("hex"),
    tokenCount: text.split(/\s+/u).length,
    extractorVersion: DEFAULT_INDEX_CONFIG.extractorVersion,
    chunkerVersion: DEFAULT_INDEX_CONFIG.chunkerVersion,
  };
}

export function extracted(file: DiscoveredFile, chunks: readonly SearchChunk[]): ExtractedFile {
  return {
    document: {
      fileId: file.fileId,
      relativePath: file.relativePath,
      normalizedText: chunks.map((chunk) => chunk.displayText).join("\n"),
      metadata: {
        format: file.format,
        language: "Markdown",
        headings: ["Section"],
        symbols: [],
      },
      units: [],
      warnings: [],
      extractorVersion: DEFAULT_INDEX_CONFIG.extractorVersion,
    },
    chunks,
  };
}

export class FixtureExtractionPipeline implements ExtractionPipeline {
  readonly #byContentHash: ReadonlyMap<string, ExtractedFile>;
  calls = 0;

  constructor(entries: readonly (readonly [string, ExtractedFile])[]) {
    this.#byContentHash = new Map(entries);
  }

  async process(file: DiscoveredFile) {
    this.calls += 1;
    const value = this.#byContentHash.get(file.fingerprint.contentHash ?? "");
    if (!value) {
      return {
        ok: false as const,
        error: {
          code: "EXTRACTION_FAILED" as const,
          message: "The fixture extraction is unavailable.",
          fileId: file.fileId,
        },
      };
    }
    return ok(value);
  }
}
