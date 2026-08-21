import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { FileFingerprint, FileReadStatus } from "./contracts.ts";
import { type FormatDescriptor, inspectTextBytes } from "./formats.ts";

const READ_BUFFER_BYTES = 64 * 1024;
const INSPECTION_BYTES = 8 * 1024;

function timestampPrecisionMs(nanoseconds: bigint): number {
  if (nanoseconds % 1_000_000_000n === 0n) return 1_000;
  if (nanoseconds % 1_000_000n === 0n) return 1;
  if (nanoseconds % 1_000n === 0n) return 0.001;
  return 0.000001;
}

export function fingerprintMetadata(stats: BigIntStats, contentHash?: string): FileFingerprint {
  const fingerprint: FileFingerprint = {
    size: Number(stats.size),
    modifiedAtMs: Number(stats.mtimeNs) / 1_000_000,
    modifiedAtNs: stats.mtimeNs.toString(),
    changedAtNs: stats.ctimeNs.toString(),
    timestampPrecisionMs: timestampPrecisionMs(stats.mtimeNs),
    deviceId: stats.dev.toString(),
    inode: stats.ino.toString(),
    ...(contentHash === undefined ? {} : { contentHash }),
  };
  return fingerprint;
}

export function metadataMatches(left: FileFingerprint, right: FileFingerprint): boolean {
  return (
    left.size === right.size &&
    left.modifiedAtNs === right.modifiedAtNs &&
    left.changedAtNs === right.changedAtNs &&
    left.deviceId === right.deviceId &&
    left.inode === right.inode
  );
}

export interface FingerprintResult {
  readonly fingerprint: FileFingerprint;
  readonly descriptor: FormatDescriptor;
  readonly status: FileReadStatus;
  readonly error?: string;
  readonly chunksRead: number;
}

/** Hashes through a file handle so large files are never buffered in their entirety. */
export async function fingerprintFile(
  sourcePath: string,
  expectedCanonicalPath: string,
  knownFormat?: FormatDescriptor,
): Promise<FingerprintResult> {
  const handle = await open(expectedCanonicalPath, "r");
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile())
      throw Object.assign(new Error("The path is no longer a regular file."), { code: "ESTALE" });

    const canonicalAfterOpen = await realpath(sourcePath);
    if (canonicalAfterOpen !== expectedCanonicalPath) {
      throw Object.assign(new Error("The file target changed while it was being inspected."), {
        code: "ESTALE",
      });
    }

    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    const sample = new Uint8Array(INSPECTION_BYTES);
    let sampleLength = 0;
    let position = 0;
    let utf8Valid = true;
    let chunksRead = 0;

    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      chunksRead += 1;
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      const sampleBytes = Math.min(bytesRead, sample.length - sampleLength);
      if (sampleBytes > 0) {
        sample.set(chunk.subarray(0, sampleBytes), sampleLength);
        sampleLength += sampleBytes;
      }
      if (utf8Valid) {
        try {
          decoder.decode(chunk, { stream: true });
        } catch {
          utf8Valid = false;
        }
      }
    }
    if (utf8Valid) {
      try {
        decoder.decode();
      } catch {
        utf8Valid = false;
      }
    }

    const inspection = inspectTextBytes(sample.subarray(0, sampleLength), utf8Valid, knownFormat);
    const result: FingerprintResult = {
      fingerprint: fingerprintMetadata(stats, hash.digest("hex")),
      descriptor: inspection.descriptor,
      status: inspection.status,
      chunksRead,
      ...(inspection.error === undefined ? {} : { error: inspection.error }),
    };
    return result;
  } finally {
    await handle.close();
  }
}

export function safeFileError(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    switch (String(error.code)) {
      case "EACCES":
      case "EPERM":
        return "The file is not readable.";
      case "ENOENT":
        return "The file disappeared while it was being scanned.";
      case "ELOOP":
        return "The file is part of a symbolic-link cycle.";
      case "ESTALE":
        return error.message;
      default:
        break;
    }
  }
  return "The file could not be inspected.";
}
