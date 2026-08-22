import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyIndexCompatibility,
  createIndexCompatibility,
  readCompatibilityMetadata,
  writeCompatibilityMetadata,
} from "./compatibility.ts";
import type { IndexCompatibility } from "./contracts.ts";
import { DEFAULT_EMBEDDING_CONFIG, DEFAULT_INDEX_CONFIG } from "./defaults.ts";

let fixtureDir = "";

beforeEach(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "kbiss-compatibility-test-"));
});

afterEach(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

function expected(): IndexCompatibility {
  return createIndexCompatibility({
    applicationVersion: "2.0.0",
    embedding: DEFAULT_EMBEDDING_CONFIG,
    index: DEFAULT_INDEX_CONFIG,
    rootIdentity: "a".repeat(64),
  });
}

describe("compatibility classification", () => {
  test("requires a rebuild when metadata is absent", () => {
    expect(classifyIndexCompatibility(undefined, expected())).toEqual({
      status: "rebuild-required",
      reasons: ["compatibility metadata is missing"],
    });
  });

  test("accepts an exact descriptor", () => {
    const descriptor = expected();
    expect(classifyIndexCompatibility(descriptor, descriptor)).toEqual({
      status: "compatible",
      reasons: [],
      stored: descriptor,
    });
  });

  test.each([
    [
      "application version",
      (value: IndexCompatibility) => ({ ...value, applicationVersion: "1.0.0" }),
    ],
    ["descriptor version", (value: IndexCompatibility) => ({ ...value, descriptorVersion: 4 })],
  ] as const)("requires migration for %s drift", (_name, mutate) => {
    expect(classifyIndexCompatibility(mutate(expected()), expected()).status).toBe(
      "migration-required",
    );
  });

  test.each([
    ["root", (value: IndexCompatibility) => ({ ...value, rootIdentity: "other" })],
    [
      "schema",
      (value: IndexCompatibility) => ({
        ...value,
        indexSchemaVersion: value.indexSchemaVersion + 1,
      }),
    ],
    [
      "model",
      (value: IndexCompatibility) => ({
        ...value,
        embedding: { ...value.embedding, modelId: "other" },
      }),
    ],
    [
      "device",
      (value: IndexCompatibility) => ({
        ...value,
        embedding: { ...value.embedding, device: "webgpu" as const },
      }),
    ],
    [
      "quantization",
      (value: IndexCompatibility) => ({
        ...value,
        embedding: { ...value.embedding, quantization: "q4" as const },
      }),
    ],
    [
      "dimension",
      (value: IndexCompatibility) => ({
        ...value,
        embedding: { ...value.embedding, vectorDimension: 768 },
      }),
    ],
    [
      "native dimension",
      (value: IndexCompatibility) => ({
        ...value,
        embedding: { ...value.embedding, nativeDimension: 768 },
      }),
    ],
    [
      "revision",
      (value: IndexCompatibility) => ({
        ...value,
        embedding: {
          ...value.embedding,
          profile: { ...value.embedding.profile, revision: "b".repeat(40) },
        },
      }),
    ],
    [
      "profile version",
      (value: IndexCompatibility) => ({
        ...value,
        embedding: {
          ...value.embedding,
          profile: {
            ...value.embedding.profile,
            profileVersion: value.embedding.profile.profileVersion + 1,
          },
        },
      }),
    ],
    [
      "pooling",
      (value: IndexCompatibility) => ({
        ...value,
        embedding: {
          ...value.embedding,
          profile: {
            ...value.embedding.profile,
            pooling: { ...value.embedding.profile.pooling, strategy: "cls" as const },
          },
        },
      }),
    ],
    ...(["documentEncoding", "queryEncoding", "tokenizer"] as const).map(
      (field) =>
        [
          field,
          (value: IndexCompatibility) => ({
            ...value,
            embedding: {
              ...value.embedding,
              profile: {
                ...value.embedding.profile,
                [field]:
                  field === "tokenizer"
                    ? {
                        ...value.embedding.profile.tokenizer,
                        specialTokenPolicyVersion:
                          value.embedding.profile.tokenizer.specialTokenPolicyVersion + 1,
                      }
                    : {
                        ...value.embedding.profile[field],
                        prefix: `${value.embedding.profile[field].prefix}changed: `,
                      },
              },
            },
          }),
        ] as const,
    ),
    ["extractor", (value: IndexCompatibility) => ({ ...value, extractorVersion: 2 })],
    [
      "chunker",
      (value: IndexCompatibility) => ({
        ...value,
        chunking: { ...value.chunking, version: value.chunking.version + 1 },
      }),
    ],
    [
      "chunk size",
      (value: IndexCompatibility) => ({
        ...value,
        chunking: { ...value.chunking, sizeTokens: 500 },
      }),
    ],
    [
      "overlap",
      (value: IndexCompatibility) => ({
        ...value,
        chunking: { ...value.chunking, overlapTokens: 75 },
      }),
    ],
  ] as const)("requires rebuild for %s drift", (_name, mutate) => {
    const assessment = classifyIndexCompatibility(mutate(expected()), expected());
    expect(assessment.status).toBe("rebuild-required");
    expect(assessment.reasons).not.toHaveLength(0);
  });

  test("detects normalization drift defensively", () => {
    const stored = {
      ...expected(),
      embedding: { ...expected().embedding, normalization: "none" },
    } as unknown as IndexCompatibility;
    expect(classifyIndexCompatibility(stored, expected()).reasons).toContain(
      "normalization policy changed",
    );
  });
});

describe("persisted compatibility metadata", () => {
  test("writes atomically and reads a real descriptor", async () => {
    const path = join(fixtureDir, "nested", "compatibility.json");
    const descriptor = expected();
    expect(await writeCompatibilityMetadata(path, descriptor)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await readCompatibilityMetadata(path, descriptor)).toEqual({
      ok: true,
      value: { status: "compatible", reasons: [], stored: descriptor },
    });
    expect((await Bun.file(path).text()).endsWith("\n")).toBe(true);
  });

  test("classifies a missing file as rebuild-required", async () => {
    const result = await readCompatibilityMetadata(join(fixtureDir, "missing.json"), expected());
    expect(result).toMatchObject({ ok: true, value: { status: "rebuild-required" } });
  });

  test.each([
    ["not json"],
    ["{}"],
    [JSON.stringify({ ...expected(), embedding: { ...expected().embedding, vectorDimension: 0 } })],
    [JSON.stringify({ ...expected(), chunking: { ...expected().chunking, overlapTokens: 500 } })],
  ])("classifies corrupt metadata %#", async (contents) => {
    const path = join(fixtureDir, "corrupt.json");
    await writeFile(path, contents);
    const result = await readCompatibilityMetadata(path, expected());
    expect(result).toMatchObject({ ok: true, value: { status: "corrupt" } });
  });

  test("reports metadata read failures", async () => {
    const result = await readCompatibilityMetadata(fixtureDir, expected());
    expect(result).toMatchObject({
      ok: false,
      error: { code: "COMPATIBILITY_METADATA_UNREADABLE" },
    });
  });

  test("reports metadata write failures and cleans temporary output", async () => {
    const blockingFile = join(fixtureDir, "blocking-file");
    await writeFile(blockingFile, "not a directory");
    const path = join(blockingFile, "compatibility.json");
    const result = await writeCompatibilityMetadata(path, expected());
    expect(result).toMatchObject({
      ok: false,
      error: { code: "COMPATIBILITY_METADATA_WRITE_FAILED" },
    });
  });

  test("accepts a structurally valid descriptor with a newer metadata version", async () => {
    const path = join(fixtureDir, "newer.json");
    await mkdir(join(fixtureDir, "unused"));
    await writeFile(path, JSON.stringify({ ...expected(), descriptorVersion: 4 }));
    const result = await readCompatibilityMetadata(path, expected());
    expect(result).toMatchObject({ ok: true, value: { status: "migration-required" } });
  });
});
