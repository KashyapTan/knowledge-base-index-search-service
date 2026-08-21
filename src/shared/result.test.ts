import { describe, expect, test } from "bun:test";
import { err, ok } from "./result.ts";

describe("Result", () => {
  test("represents successful values", () => {
    expect(ok({ ready: true })).toEqual({ ok: true, value: { ready: true } });
  });

  test("represents display-safe errors", () => {
    expect(err({ code: "NOT_READY", message: "The service is not ready." })).toEqual({
      ok: false,
      error: { code: "NOT_READY", message: "The service is not ready." },
    });
  });
});
