import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DataType } from "@huggingface/transformers";
import { err, ok, type Result } from "../shared/result.ts";
import type {
  CompatibilityAssessment,
  CompatibilityError,
  EmbeddingConfig,
  IndexCompatibility,
  IndexConfig,
} from "./contracts.ts";
import {
  APPLICATION_VERSION,
  COMPATIBILITY_DESCRIPTOR_VERSION,
  SUPPORTED_QUANTIZATIONS,
} from "./defaults.ts";

export interface CompatibilityInput {
  readonly applicationVersion?: string;
  readonly embedding: EmbeddingConfig;
  readonly index: IndexConfig;
  readonly rootIdentity: string;
}

export function createIndexCompatibility(input: CompatibilityInput): IndexCompatibility {
  return {
    applicationVersion: input.applicationVersion ?? APPLICATION_VERSION,
    chunking: {
      overlapTokens: input.index.chunkOverlapTokens,
      sizeTokens: input.index.chunkSizeTokens,
      version: input.index.chunkerVersion,
    },
    descriptorVersion: COMPATIBILITY_DESCRIPTOR_VERSION,
    embedding: { ...input.embedding },
    extractorVersion: input.index.extractorVersion,
    indexSchemaVersion: input.index.schemaVersion,
    rootIdentity: input.rootIdentity,
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseCompatibility(value: unknown): IndexCompatibility | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const embedding = candidate.embedding as Record<string, unknown> | undefined;
  const chunking = candidate.chunking as Record<string, unknown> | undefined;
  if (
    typeof candidate.applicationVersion !== "string" ||
    !candidate.applicationVersion ||
    !isPositiveInteger(candidate.descriptorVersion) ||
    !isPositiveInteger(candidate.extractorVersion) ||
    !isPositiveInteger(candidate.indexSchemaVersion) ||
    typeof candidate.rootIdentity !== "string" ||
    !candidate.rootIdentity ||
    !embedding ||
    typeof embedding.modelId !== "string" ||
    !embedding.modelId ||
    embedding.normalization !== "l2" ||
    typeof embedding.quantization !== "string" ||
    !SUPPORTED_QUANTIZATIONS.has(embedding.quantization as DataType) ||
    !isPositiveInteger(embedding.vectorDimension) ||
    !chunking ||
    !isNonNegativeInteger(chunking.overlapTokens) ||
    !isPositiveInteger(chunking.sizeTokens) ||
    !isPositiveInteger(chunking.version) ||
    chunking.overlapTokens >= chunking.sizeTokens
  ) {
    return undefined;
  }
  return value as IndexCompatibility;
}

function equalIndexInputs(left: IndexCompatibility, right: IndexCompatibility): string[] {
  const differences: string[] = [];
  if (left.rootIdentity !== right.rootIdentity) differences.push("canonical root identity changed");
  if (left.indexSchemaVersion !== right.indexSchemaVersion)
    differences.push("index schema changed");
  if (left.embedding.modelId !== right.embedding.modelId)
    differences.push("embedding model changed");
  if (left.embedding.quantization !== right.embedding.quantization)
    differences.push("embedding quantization changed");
  if (left.embedding.vectorDimension !== right.embedding.vectorDimension)
    differences.push("vector dimension changed");
  if (left.embedding.normalization !== right.embedding.normalization)
    differences.push("normalization policy changed");
  if (left.extractorVersion !== right.extractorVersion) differences.push("extractor changed");
  if (left.chunking.version !== right.chunking.version) differences.push("chunker changed");
  if (left.chunking.sizeTokens !== right.chunking.sizeTokens)
    differences.push("chunk size changed");
  if (left.chunking.overlapTokens !== right.chunking.overlapTokens)
    differences.push("chunk overlap changed");
  return differences;
}

export function classifyIndexCompatibility(
  stored: IndexCompatibility | undefined,
  expected: IndexCompatibility,
): CompatibilityAssessment {
  if (!stored) {
    return { status: "rebuild-required", reasons: ["compatibility metadata is missing"] };
  }
  const rebuildReasons = equalIndexInputs(stored, expected);
  if (rebuildReasons.length > 0) {
    return { status: "rebuild-required", reasons: rebuildReasons, stored };
  }
  const migrationReasons: string[] = [];
  if (stored.descriptorVersion !== expected.descriptorVersion)
    migrationReasons.push("compatibility descriptor version changed");
  if (stored.applicationVersion !== expected.applicationVersion)
    migrationReasons.push("application version changed");
  if (migrationReasons.length > 0) {
    return { status: "migration-required", reasons: migrationReasons, stored };
  }
  return { status: "compatible", reasons: [], stored };
}

export async function readCompatibilityMetadata(
  path: string,
  expected: IndexCompatibility,
): Promise<Result<CompatibilityAssessment, CompatibilityError>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return ok(classifyIndexCompatibility(undefined, expected));
    }
    return err({
      code: "COMPATIBILITY_METADATA_UNREADABLE",
      message: "The index compatibility metadata could not be read.",
    });
  }

  try {
    const parsed = parseCompatibility(JSON.parse(text));
    if (!parsed) throw new TypeError("Invalid compatibility descriptor");
    return ok(classifyIndexCompatibility(parsed, expected));
  } catch {
    return ok({
      status: "corrupt",
      reasons: ["compatibility metadata is malformed or incomplete"],
    });
  }
}

export async function writeCompatibilityMetadata(
  path: string,
  compatibility: IndexCompatibility,
): Promise<Result<void, CompatibilityError>> {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(compatibility, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    return ok(undefined);
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    return err({
      code: "COMPATIBILITY_METADATA_WRITE_FAILED",
      message: "The index compatibility metadata could not be saved.",
    });
  }
}
