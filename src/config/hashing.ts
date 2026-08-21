import { createHash } from "node:crypto";

export function stableHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function shortStableHash(value: string): string {
  return stableHash(value).slice(0, 20);
}
