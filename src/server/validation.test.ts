import { describe, expect, test } from "bun:test";
import {
  readJsonBody,
  validateActionBody,
  validateFileId,
  validateSearchBody,
} from "./validation.ts";

describe("API validation", () => {
  test("reads only bounded JSON bodies", async () => {
    expect(
      await readJsonBody(new Request("http://local", { method: "POST", body: "{}" })),
    ).toMatchObject({ ok: false, error: { code: "CONTENT_TYPE_INVALID" } });
    expect(
      await readJsonBody(
        new Request("http://local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "REQUEST_BODY_INVALID" } });
    expect(
      await readJsonBody(
        new Request("http://local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"ok":true}',
        }),
      ),
    ).toEqual({ ok: true, value: { ok: true } });
    expect(
      await readJsonBody(
        new Request("http://local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: "oversized" }),
        }),
        4,
      ),
    ).toMatchObject({ ok: false, error: { code: "REQUEST_TOO_LARGE" } });
    expect(
      await readJsonBody(
        new Request("http://local", {
          method: "POST",
          headers: { "Content-Length": "10", "Content-Type": "application/json" },
          body: "{}",
        }),
        4,
      ),
    ).toMatchObject({ ok: false, error: { code: "REQUEST_TOO_LARGE" } });
    expect(
      await readJsonBody(
        new Request("http://local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "REQUEST_BODY_INVALID" } });
    const broken = new ReadableStream({
      pull() {
        throw new Error("broken request stream");
      },
    });
    expect(
      await readJsonBody(
        new Request("http://local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: broken,
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "REQUEST_BODY_INVALID" } });
  });

  test("validates exact search and action shapes", () => {
    expect(validateSearchBody(null).ok).toBe(false);
    expect(validateSearchBody({ query: 1 }).ok).toBe(false);
    expect(validateSearchBody({ query: "x", fileCount: "2" }).ok).toBe(false);
    expect(validateSearchBody({ query: "x", formats: [1] }).ok).toBe(false);
    expect(validateSearchBody({ query: "x", extra: true }).ok).toBe(false);
    expect(validateSearchBody({ query: "x", fileCount: 2, formats: ["markdown"] })).toEqual({
      ok: true,
      value: { query: "x", fileCount: 2, formats: ["markdown"] },
    });
    expect(validateActionBody({ mode: "reconcile" })).toEqual({ ok: true, value: "reconcile" });
    expect(validateActionBody({ mode: "reindex" })).toEqual({ ok: true, value: "reindex" });
    expect(validateActionBody({ mode: "delete" }).ok).toBe(false);
    expect(validateActionBody({ mode: "reindex", extra: true }).ok).toBe(false);
  });

  test("accepts only opaque lowercase SHA-256 file IDs", () => {
    expect(validateFileId("a".repeat(64))).toBe(true);
    expect(validateFileId("A".repeat(64))).toBe(false);
    expect(validateFileId("a".repeat(63))).toBe(false);
    expect(validateFileId(`../${"a".repeat(64)}`)).toBe(false);
    expect(validateFileId(`%00${"a".repeat(64)}`)).toBe(false);
  });
});
