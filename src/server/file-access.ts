import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { SourceRoot } from "../config/index.ts";
import type { FileManifest } from "../discovery/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type { ApiError, FileMetadataResponse } from "./contracts.ts";
import { MAX_FILE_BYTES } from "./contracts.ts";
import { isWithinRoot, withSecurityHeaders } from "./security.ts";

function fileError(code: ApiError["code"], message: string, status: number): ApiError {
  return { code, message, status };
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export class SafeFileAccess {
  readonly #root: SourceRoot;
  readonly #manifest: FileManifest;
  readonly #maxBytes: number;
  readonly #beforeOpen: (() => void | Promise<void>) | undefined;

  constructor(
    root: SourceRoot,
    manifest: FileManifest,
    options: { readonly maxBytes?: number; readonly beforeOpen?: () => void | Promise<void> } = {},
  ) {
    this.#root = root;
    this.#manifest = manifest;
    this.#maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
    this.#beforeOpen = options.beforeOpen;
  }

  metadata(fileId: string): Result<FileMetadataResponse, ApiError> {
    const file = this.#manifest.get(fileId);
    if (!file) {
      return err(fileError("FILE_NOT_FOUND", "The requested file is not indexed.", 404));
    }
    return ok({
      fileId: file.fileId,
      relativePath: file.relativePath,
      filename: file.filename,
      format: file.format,
      mimeFamily: file.mimeFamily,
      size: file.fingerprint.size,
      modifiedAtMs: file.fingerprint.modifiedAtMs,
      readStatus: file.readStatus,
    });
  }

  async content(fileId: string): Promise<Result<Response, ApiError>> {
    const file = this.#manifest.get(fileId);
    if (!file) {
      return err(fileError("FILE_NOT_FOUND", "The requested file is not indexed.", 404));
    }
    if (file.rootIdentity !== this.#root.identity) {
      return err(fileError("FILE_UNSAFE", "The requested file identity is not trusted.", 403));
    }
    const sourcePath = resolve(this.#root.path, file.relativePath);
    if (!isWithinRoot(this.#root.path, sourcePath)) {
      return err(fileError("FILE_UNSAFE", "The requested file path is not safe.", 403));
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(sourcePath);
    } catch (error) {
      return err(
        isMissing(error)
          ? fileError("FILE_NOT_FOUND", "The requested file no longer exists.", 404)
          : fileError("FILE_READ_FAILED", "The requested file could not be opened.", 500),
      );
    }
    if (!isWithinRoot(this.#root.path, canonicalPath)) {
      return err(
        fileError("FILE_UNSAFE", "The requested file now resolves outside the source root.", 403),
      );
    }

    await this.#beforeOpen?.();
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(canonicalPath, "r");
    } catch (error) {
      return err(
        isMissing(error)
          ? fileError("FILE_NOT_FOUND", "The requested file no longer exists.", 404)
          : fileError("FILE_READ_FAILED", "The requested file could not be opened.", 500),
      );
    }

    try {
      const [currentCanonical, stats] = await Promise.all([realpath(sourcePath), handle.stat()]);
      if (currentCanonical !== canonicalPath || !isWithinRoot(this.#root.path, currentCanonical)) {
        await handle.close();
        return err(fileError("FILE_UNSAFE", "The requested file path changed during access.", 403));
      }
      if (!stats.isFile()) {
        await handle.close();
        return err(fileError("FILE_NOT_REGULAR", "The requested path is not a regular file.", 409));
      }
      if (stats.size > this.#maxBytes) {
        await handle.close();
        return err(
          fileError("FILE_TOO_LARGE", "The requested file is too large to view safely.", 413),
        );
      }

      let position = 0;
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await handle.close();
      };
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const buffer = new Uint8Array(Math.min(64 * 1024, stats.size - position));
            if (buffer.byteLength === 0) {
              await close();
              controller.close();
              return;
            }
            const read = await handle.read(buffer, 0, buffer.byteLength, position);
            if (read.bytesRead === 0) {
              await close();
              controller.close();
              return;
            }
            position += read.bytesRead;
            controller.enqueue(buffer.subarray(0, read.bytesRead));
          } catch {
            await close();
            controller.error(new Error("The file stream could not be read."));
          }
        },
        async cancel() {
          await close();
        },
      });
      return ok(
        new Response(stream, {
          headers: withSecurityHeaders({
            "Cache-Control": "no-store",
            "Content-Length": String(stats.size),
            "Content-Type": "text/plain; charset=utf-8",
          }),
        }),
      );
    } catch (error) {
      await handle.close();
      return err(
        isMissing(error)
          ? fileError("FILE_NOT_FOUND", "The requested file no longer exists.", 404)
          : fileError("FILE_READ_FAILED", "The requested file could not be read.", 500),
      );
    }
  }
}
