import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import type { DiscoveredFile, FileFormat } from "../discovery/index.ts";
import type { ExtractedDocument, ExtractorContext } from "./contracts.ts";
import { normalizeSourceText } from "./normalization.ts";
import { createDefaultExtractorRegistry, type ExtractorRegistry } from "./registry.ts";

const MIME: Readonly<Record<FileFormat, string>> = {
  markdown: "text/markdown",
  html: "text/html",
  python: "text/x-python",
  javascript: "text/javascript",
  typescript: "text/typescript",
  json: "application/json",
  yaml: "application/yaml",
  toml: "application/toml",
  stylesheet: "text/css",
  shell: "text/x-shellscript",
  sql: "application/sql",
  xml: "application/xml",
  csv: "text/csv",
  text: "text/plain",
  unknown: "application/octet-stream",
};

export function discoveredFile(
  relativePath: string,
  format: FileFormat,
  overrides: Partial<DiscoveredFile> = {},
): DiscoveredFile {
  return {
    fileId: createHash("sha256").update(relativePath).digest("hex"),
    rootIdentity: "fixture-root",
    relativePath,
    canonicalPath: `/fixture/${relativePath}`,
    filename: basename(relativePath),
    extension: extname(relativePath).toLowerCase(),
    format,
    mimeFamily: MIME[format],
    fingerprint: {
      size: 0,
      modifiedAtMs: 0,
      modifiedAtNs: "0",
      changedAtNs: "0",
      timestampPrecisionMs: 1,
      contentHash: "fixture-hash",
    },
    readStatus: "ready",
    indexStatus: "pending",
    ...overrides,
  };
}

export function extractionContext(
  relativePath: string,
  format: FileFormat,
  text: string,
): ExtractorContext {
  return {
    file: discoveredFile(relativePath, format),
    source: normalizeSourceText(text),
    extractorVersion: 1,
  };
}

export function extractText(
  relativePath: string,
  format: FileFormat,
  text: string,
  registry: ExtractorRegistry = createDefaultExtractorRegistry(),
): ExtractedDocument {
  return registry.extract(extractionContext(relativePath, format, text));
}

export async function fixture(name: string): Promise<string> {
  return Bun.file(`${import.meta.dir}/fixtures/${name}`).text();
}
