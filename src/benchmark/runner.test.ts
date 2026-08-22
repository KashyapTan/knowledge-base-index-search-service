import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBenchmarkDefinition, validateBenchmarkPaths } from "./runner.ts";

describe("large-repository benchmark safety and definitions", () => {
  test("accepts only reproducible definitions with repeated warm runs", () => {
    const definition = parseBenchmarkDefinition({
      schemaVersion: 1,
      ignorePatterns: ["node_modules/"],
      queries: ["configuration"],
      warmRuns: 20,
      annThreshold: 50_000,
    });
    expect(definition.warmRuns).toBe(20);
    for (const invalid of [
      null,
      {},
      { ...definition, warmRuns: 1 },
      { ...definition, queries: [] },
    ]) {
      expect(() => parseBenchmarkDefinition(invalid)).toThrow();
    }
  });

  test("requires every generated path outside both repositories", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "kbiss-benchmark-paths-"));
    try {
      const root = join(temporary, "source");
      const project = join(temporary, "project");
      await Promise.all([mkdir(root), mkdir(project)]);
      await expect(
        validateBenchmarkPaths({
          root,
          projectDir: project,
          stateDir: join(temporary, "state"),
          cacheDir: join(temporary, "cache"),
          outputPath: join(temporary, "reports", "report.json"),
        }),
      ).resolves.toBeUndefined();
      await expect(
        validateBenchmarkPaths({
          root,
          projectDir: project,
          stateDir: join(root, ".kbiss"),
          cacheDir: join(temporary, "cache"),
          outputPath: join(temporary, "report.json"),
        }),
      ).rejects.toThrow(/outside/u);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
