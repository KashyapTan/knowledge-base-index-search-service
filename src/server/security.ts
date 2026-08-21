import { isAbsolute, relative } from "node:path";
import type { ApiError } from "./contracts.ts";

const LOCAL_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const);

function splitHost(
  value: string,
): { readonly hostname: string; readonly port: number } | undefined {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/u.exec(value.trim().toLowerCase());
  if (!match) return undefined;
  const hostname = match[1];
  const port = Number(match[2]);
  return hostname && Number.isInteger(port) ? { hostname, port } : undefined;
}

export function isExpectedHost(request: Request, port: number): boolean {
  const parsed = splitHost(request.headers.get("host") ?? "");
  return parsed !== undefined && parsed.port === port && LOCAL_NAMES.has(parsed.hostname);
}

export function isExpectedOrigin(request: Request, port: number): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") !== "cross-site";
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "http:" &&
      parsed.port === String(port) &&
      LOCAL_NAMES.has(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export function requestSecurityError(request: Request, port: number): ApiError | undefined {
  if (!isExpectedHost(request, port)) {
    return { code: "HOST_NOT_ALLOWED", message: "The request Host is not allowed.", status: 403 };
  }
  if (!isExpectedOrigin(request, port)) {
    return {
      code: "ORIGIN_NOT_ALLOWED",
      message: "Cross-origin requests are not allowed.",
      status: 403,
    };
  }
  return undefined;
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

export function withSecurityHeaders(headers: HeadersInit = {}): Headers {
  const secured = new Headers(headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.set(name, value);
  return secured;
}
