import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AppConfig, SourceRoot } from "../config/index.ts";
import type { DiscoveredFile } from "../discovery/index.ts";
import { normalizeRelativePath } from "../discovery/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import { chunkDocument } from "./chunker.ts";
import type {
  ChunkingOptions,
  ExtractedDocument,
  ExtractedFile,
  ExtractionError,
  ExtractionPipeline,
} from "./contracts.ts";
import { normalizeSourceText } from "./normalization.ts";
import { createDefaultExtractorRegistry, type ExtractorRegistry } from "./registry.ts";

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function failure(
  file: DiscoveredFile,
  code: ExtractionError["code"],
  message: string,
): Result<never, ExtractionError> {
  return err({ code, message, fileId: file.fileId });
}

async function readRevalidatedFile(
  root: SourceRoot,
  file: DiscoveredFile,
): Promise<Result<{ readonly text: string; readonly invalidUtf8: boolean }, ExtractionError>> {
  if (file.readStatus !== "ready") {
    return failure(
      file,
      "FILE_NOT_READY",
      "The discovered file is not marked ready for extraction.",
    );
  }
  if (
    file.rootIdentity !== root.identity ||
    normalizeRelativePath(root.path, resolve(root.path, file.relativePath)) !== file.relativePath
  ) {
    return failure(file, "FILE_PATH_UNSAFE", "The file identity or root-relative path is invalid.");
  }
  try {
    const sourcePath = resolve(root.path, file.relativePath);
    const canonicalPath = await realpath(sourcePath);
    if (!isWithin(root.path, canonicalPath)) {
      return failure(
        file,
        "FILE_PATH_UNSAFE",
        "The file now resolves outside the configured source root.",
      );
    }
    const handle = await open(canonicalPath, "r");
    try {
      const currentCanonical = await realpath(sourcePath);
      if (currentCanonical !== canonicalPath || !isWithin(root.path, currentCanonical)) {
        return failure(
          file,
          "FILE_PATH_UNSAFE",
          "The file path changed while it was being opened.",
        );
      }
      const stats = await handle.stat();
      if (!stats.isFile())
        return failure(
          file,
          "FILE_READ_FAILED",
          "The discovered path is no longer a regular file.",
        );
      const bytes = await handle.readFile();
      try {
        return ok({
          text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          invalidUtf8: false,
        });
      } catch {
        return ok({
          text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
          invalidUtf8: true,
        });
      }
    } finally {
      await handle.close();
    }
  } catch {
    return failure(file, "FILE_READ_FAILED", "The file could not be read for extraction.");
  }
}

export class FileExtractionPipeline implements ExtractionPipeline {
  readonly #root: SourceRoot;
  readonly #registry: ExtractorRegistry;
  readonly #chunking: ChunkingOptions;

  constructor(
    root: SourceRoot,
    chunking: ChunkingOptions,
    registry = createDefaultExtractorRegistry(),
  ) {
    this.#root = root;
    this.#chunking = chunking;
    this.#registry = registry;
  }

  async process(file: DiscoveredFile): Promise<Result<ExtractedFile, ExtractionError>> {
    const read = await readRevalidatedFile(this.#root, file);
    if (!read.ok) return read;
    const source = normalizeSourceText(read.value.text);
    let document: ExtractedDocument;
    try {
      document = this.#registry.extract({
        file,
        source,
        extractorVersion: this.#chunking.index.extractorVersion,
      });
      if (read.value.invalidUtf8) {
        document = {
          ...document,
          warnings: [
            ...document.warnings,
            {
              code: "INVALID_UNICODE_REPLACED",
              message: "Invalid UTF-8 byte sequences were replaced with U+FFFD.",
            },
          ],
        };
      }
    } catch {
      return failure(
        file,
        "EXTRACTOR_UNAVAILABLE",
        "No safe extractor is available for this file format.",
      );
    }
    try {
      return ok({ document, chunks: chunkDocument(document, this.#chunking) });
    } catch {
      return failure(
        file,
        "CHUNKING_FAILED",
        "The extracted content could not fit the configured token limits.",
      );
    }
  }
}

export function createExtractionPipeline(
  config: AppConfig,
  tokenizer: ChunkingOptions["tokenizer"],
  maxTokens = 512,
  registry?: ExtractorRegistry,
): FileExtractionPipeline {
  return new FileExtractionPipeline(
    config.sourceRoots[0],
    { index: config.index, tokenizer, maxTokens },
    registry,
  );
}
