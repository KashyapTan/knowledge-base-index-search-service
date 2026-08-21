import type { SearchRequest } from "../search/index.ts";
import type { ApiError } from "./contracts.ts";
import { MAX_REQUEST_BYTES } from "./contracts.ts";

function invalidBody(message: string): ApiError {
  return { code: "REQUEST_BODY_INVALID", message, status: 400 };
}

export async function readJsonBody(
  request: Request,
  maxBytes = MAX_REQUEST_BYTES,
): Promise<
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: ApiError }
> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return {
      ok: false,
      error: {
        code: "CONTENT_TYPE_INVALID",
        message: "Requests with a body must use application/json.",
        status: 415,
      },
    };
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return {
      ok: false,
      error: { code: "REQUEST_TOO_LARGE", message: "The request body is too large.", status: 413 },
    };
  }
  if (!request.body) return { ok: false, error: invalidBody("A JSON request body is required.") };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return {
          ok: false,
          error: {
            code: "REQUEST_TOO_LARGE",
            message: "The request body is too large.",
            status: 413,
          },
        };
      }
      chunks.push(next.value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return { ok: true, value: JSON.parse(new TextDecoder().decode(body)) as unknown };
    } catch {
      return { ok: false, error: invalidBody("The request body is not valid JSON.") };
    }
  } catch {
    return { ok: false, error: invalidBody("The request body could not be read.") };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

export function validateSearchBody(
  value: unknown,
):
  | { readonly ok: true; readonly value: SearchRequest }
  | { readonly ok: false; readonly error: ApiError } {
  if (!isRecord(value) || !hasOnlyKeys(value, ["query", "fileCount", "formats"])) {
    return { ok: false, error: invalidBody("The search request has an invalid shape.") };
  }
  if (typeof value.query !== "string") {
    return { ok: false, error: invalidBody("query must be a string.") };
  }
  if (value.fileCount !== undefined && typeof value.fileCount !== "number") {
    return { ok: false, error: invalidBody("fileCount must be a number.") };
  }
  if (
    value.formats !== undefined &&
    (!Array.isArray(value.formats) || !value.formats.every((format) => typeof format === "string"))
  ) {
    return { ok: false, error: invalidBody("formats must be an array of strings.") };
  }
  return {
    ok: true,
    value: {
      query: value.query,
      ...(value.fileCount === undefined ? {} : { fileCount: value.fileCount }),
      ...(value.formats === undefined ? {} : { formats: value.formats as string[] }),
    },
  };
}

export function validateActionBody(
  value: unknown,
):
  | { readonly ok: true; readonly value: "reconcile" | "reindex" }
  | { readonly ok: false; readonly error: ApiError } {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["mode"]) ||
    (value.mode !== "reconcile" && value.mode !== "reindex")
  ) {
    return {
      ok: false,
      error: {
        code: "ACTION_INVALID",
        message: "mode must be either reconcile or reindex.",
        status: 400,
      },
    };
  }
  return { ok: true, value: value.mode };
}

export function validateFileId(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}
