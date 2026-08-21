import { describe, expect, test } from "bun:test";
import {
  isExpectedHost,
  isExpectedOrigin,
  isWithinRoot,
  requestSecurityError,
  withSecurityHeaders,
} from "./security.ts";

function request(headers: HeadersInit = {}): Request {
  return new Request("http://127.0.0.1:3210/", { headers: { Host: "127.0.0.1:3210", ...headers } });
}

describe("localhost request security", () => {
  test("accepts only explicit local names on the selected port", () => {
    expect(isExpectedHost(request(), 3210)).toBe(true);
    expect(isExpectedHost(request({ Host: "localhost:3210" }), 3210)).toBe(true);
    expect(isExpectedHost(request({ Host: "[::1]:3210" }), 3210)).toBe(true);
    expect(isExpectedHost(request({ Host: "127.0.0.1:9999" }), 3210)).toBe(false);
    expect(isExpectedHost(request({ Host: "evil.example:3210" }), 3210)).toBe(false);
    expect(isExpectedHost(request({ Host: "localhost" }), 3210)).toBe(false);
  });

  test("allows same-origin and non-browser requests but rejects cross-site origins", () => {
    expect(isExpectedOrigin(request(), 3210)).toBe(true);
    expect(isExpectedOrigin(request({ Origin: "http://localhost:3210" }), 3210)).toBe(true);
    expect(isExpectedOrigin(request({ Origin: "http://127.0.0.1:3210" }), 3210)).toBe(true);
    expect(isExpectedOrigin(request({ Origin: "null" }), 3210)).toBe(false);
    expect(isExpectedOrigin(request({ Origin: "https://localhost:3210" }), 3210)).toBe(false);
    expect(isExpectedOrigin(request({ "Sec-Fetch-Site": "cross-site" }), 3210)).toBe(false);
    expect(requestSecurityError(request({ Host: "bad:3210" }), 3210)?.code).toBe(
      "HOST_NOT_ALLOWED",
    );
    expect(requestSecurityError(request({ Origin: "https://bad.example" }), 3210)?.code).toBe(
      "ORIGIN_NOT_ALLOWED",
    );
  });

  test("uses path-segment containment and applies restrictive headers", () => {
    expect(isWithinRoot("/root/repo", "/root/repo/docs/a.md")).toBe(true);
    expect(isWithinRoot("/root/repo", "/root/repository/secret")).toBe(false);
    expect(isWithinRoot("/root/repo", "/root/repo")).toBe(true);
    const headers = withSecurityHeaders({ "Content-Type": "text/plain" });
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("content-type")).toBe("text/plain");
  });
});
