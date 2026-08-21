import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config/index.ts";
import type { ChunkingOptions, Extractor } from "./contracts.ts";
import { plainTextExtractor } from "./extractors/plain.ts";
import { ExtractorRegistry } from "./registry.ts";
import { createExtractionPipeline, FileExtractionPipeline } from "./service.ts";
import { discoveredFile } from "./test-helpers.ts";
import { createUnicodeWordTokenCounter } from "./tokenizer.ts";

describe("file extraction pipeline", () => {
  let root: string;
  let outside: string;
  const chunking: ChunkingOptions = {
    tokenizer: createUnicodeWordTokenCounter(),
    maxTokens: 512,
    index: {
      chunkSizeTokens: 400,
      chunkOverlapTokens: 50,
      extractorVersion: 4,
      chunkerVersion: 6,
    },
  };

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "kbiss-extraction-root-")));
    outside = await realpath(await mkdtemp(join(tmpdir(), "kbiss-extraction-outside-")));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  function pipeline(options = chunking, registry?: ExtractorRegistry) {
    return new FileExtractionPipeline({ identity: "fixture-root", path: root }, options, registry);
  }

  test("revalidates, reads, normalizes, extracts, and chunks a ready discovery record", async () => {
    await mkdir(join(root, "guides"));
    const path = join(root, "guides", "gateway.md");
    await writeFile(path, "# Gateway\r\n\r\nLocal-only search.\r\n");
    const result = await pipeline().process(
      discoveredFile("guides/gateway.md", "markdown", { canonicalPath: path }),
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.value.document.warnings).toContainEqual(
      expect.objectContaining({ code: "LINE_ENDINGS_NORMALIZED" }),
    );
    expect(result.value.chunks[0]).toMatchObject({
      extractorVersion: 4,
      chunkerVersion: 6,
      startLine: 1,
      endLine: 3,
    });
  });

  test("decodes invalid UTF-8 predictably when a file changes after discovery", async () => {
    const path = join(root, "changed.txt");
    await writeFile(path, new Uint8Array([0x67, 0x61, 0x74, 0x65, 0xff, 0x77, 0x61, 0x79]));
    const result = await pipeline().process(
      discoveredFile("changed.txt", "text", { canonicalPath: path }),
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.value.document.normalizedText).toBe("gate\ufffdway");
    expect(result.value.document.warnings).toContainEqual(
      expect.objectContaining({ code: "INVALID_UNICODE_REPLACED" }),
    );
  });

  test("rejects records that are not ready or do not belong to the configured root", async () => {
    const notReady = await pipeline().process(
      discoveredFile("bad.bin", "unknown", { readStatus: "unsupported", indexStatus: "skipped" }),
    );
    expect(notReady).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "FILE_NOT_READY" }),
    });
    const wrongRoot = await pipeline().process(
      discoveredFile("file.txt", "text", { rootIdentity: "someone-else" }),
    );
    expect(wrongRoot).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "FILE_PATH_UNSAFE" }),
    });
    const traversal = await pipeline().process(discoveredFile("../file.txt", "text"));
    expect(traversal).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "FILE_PATH_UNSAFE" }),
    });
  });

  test("rejects symlinks that now resolve outside the root", async () => {
    await writeFile(join(outside, "private.txt"), "do not read");
    await symlink(join(outside, "private.txt"), join(root, "linked.txt"));
    const result = await pipeline().process(discoveredFile("linked.txt", "text"));
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "FILE_PATH_UNSAFE" }),
    });
  });

  test("isolates missing, unreadable, and non-file paths as per-file errors", async () => {
    const missing = await pipeline().process(discoveredFile("missing.txt", "text"));
    expect(missing).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "FILE_READ_FAILED", fileId: expect.any(String) }),
    });

    await mkdir(join(root, "directory.txt"));
    const directory = await pipeline().process(discoveredFile("directory.txt", "text"));
    expect(directory).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "FILE_READ_FAILED" }),
    });

    await writeFile(join(root, "code.py"), "pass");
    const noPython = new ExtractorRegistry([plainTextExtractor]);
    const unavailable = await pipeline(chunking, noPython).process(
      discoveredFile("code.py", "python"),
    );
    expect(unavailable).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "EXTRACTOR_UNAVAILABLE" }),
    });
  });

  test("turns an impossible model limit into a display-safe chunking error", async () => {
    await writeFile(join(root, "tiny.txt"), "content");
    const impossible: ChunkingOptions = {
      ...chunking,
      maxTokens: 5,
      index: { ...chunking.index, chunkSizeTokens: 5 },
    };
    const result = await pipeline(impossible).process(discoveredFile("tiny.txt", "text"));
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "CHUNKING_FAILED",
        message: expect.stringContaining("token"),
      }),
    });
  });

  test("uses the registry's safe fallback if an individual extractor throws", async () => {
    await writeFile(join(root, "broken.md"), "content survives");
    const broken: Extractor = {
      name: "broken",
      formats: ["markdown"],
      extract() {
        throw new Error("boom");
      },
    };
    const result = await pipeline(
      chunking,
      new ExtractorRegistry([broken], plainTextExtractor),
    ).process(discoveredFile("broken.md", "markdown"));
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.value.document.normalizedText).toBe("content survives");
    expect(result.value.document.warnings.at(-1)?.code).toBe("PARSER_FALLBACK");
  });

  test("composes the pipeline from the validated application configuration", async () => {
    await writeFile(join(root, "factory.txt"), "factory content");
    const config = {
      sourceRoots: [{ identity: "fixture-root", path: root }],
      index: chunking.index,
    } as unknown as AppConfig;
    const result = await createExtractionPipeline(config, chunking.tokenizer).process(
      discoveredFile("factory.txt", "text"),
    );
    expect(result.ok).toBeTrue();
  });
});
