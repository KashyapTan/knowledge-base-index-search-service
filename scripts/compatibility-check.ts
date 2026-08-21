import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { PROVISIONAL_EMBEDDING_MODEL } from "../src/indexing/embedding-protocol.ts";
import { EmbeddingWorkerClient } from "../src/indexing/embedding-worker-client.ts";
import { createFoundationServer } from "../src/server/index.ts";

const HEALTH_RESPONSE_DEADLINE_MS = 5_000;
const NORMALIZATION_TOLERANCE = 0.001;
const REQUIRED_BUN_VERSION = "1.4.0";

interface HealthProbe {
  readonly elapsedMilliseconds: number;
  readonly status: string;
}

async function probeHealth(baseUrl: URL): Promise<HealthProbe> {
  const startedAt = performance.now();
  const response = await fetch(new URL("/api/health", baseUrl), {
    signal: AbortSignal.timeout(HEALTH_RESPONSE_DEADLINE_MS),
  });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.deepEqual(body, { service: "kbiss", status: "ok" });
  return { elapsedMilliseconds: performance.now() - startedAt, status: "ok" };
}

async function verifyUiAsset(baseUrl: URL): Promise<void> {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<div id="root"><\/div>/);
}

async function verifyLanceDb(databaseDirectory: string): Promise<void> {
  const writeConnection = await lancedb.connect(databaseDirectory);
  try {
    const table = await writeConnection.createTable("compatibility_vectors", [
      { id: "near", label: "nearest record", vector: [1, 0, 0] },
      { id: "far", label: "distant record", vector: [0, 1, 0] },
    ]);
    table.close();
  } finally {
    writeConnection.close();
  }

  const readConnection = await lancedb.connect(databaseDirectory);
  const table = await readConnection.openTable("compatibility_vectors");
  try {
    const rows = await table.vectorSearch([0.99, 0.01, 0]).limit(1).toArray();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, "near");
  } finally {
    table.close();
    readConnection.close();
  }
}

function vectorNorm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

async function main(): Promise<void> {
  const compatibilityDirectory = await mkdtemp(join(tmpdir(), "kbiss-compatibility-"));
  let worker: EmbeddingWorkerClient | undefined;
  let server: Bun.Server<undefined> | undefined;
  let failure: unknown;

  try {
    assert.equal(
      Bun.version,
      REQUIRED_BUN_VERSION,
      `Run this check with the pinned Bun ${REQUIRED_BUN_VERSION} runtime.`,
    );
    console.info(`✓ Running the pinned Bun ${Bun.version} runtime`);

    worker = new EmbeddingWorkerClient();
    server = createFoundationServer({ port: 0 });

    await verifyLanceDb(join(compatibilityDirectory, "lancedb"));
    console.info("✓ LanceDB created, queried, and closed a temporary vector table");

    await verifyUiAsset(server.url);
    console.info("✓ Bun.serve returned the compiled Vite entry asset");

    const initialization = worker.initialize({
      modelId: PROVISIONAL_EMBEDDING_MODEL.id,
      dtype: PROVISIONAL_EMBEDDING_MODEL.dtype,
      expectedDimension: PROVISIONAL_EMBEDDING_MODEL.dimension,
      cacheDir: join(compatibilityDirectory, "models"),
      localFilesOnly: false,
    });
    const healthWhileLoading = await probeHealth(server.url);
    await initialization;
    console.info(
      `✓ Bun Worker loaded ${PROVISIONAL_EMBEDDING_MODEL.id} while health responded in ${healthWhileLoading.elapsedMilliseconds.toFixed(1)} ms`,
    );

    const inference = worker.embed([
      "Local private search across a software repository.",
      "Exact identifiers and semantic questions should both work.",
    ]);
    const healthWhileEmbedding = await probeHealth(server.url);
    const vectors = await inference;

    assert.equal(vectors.length, 2);
    for (const vector of vectors) {
      assert.equal(vector.length, PROVISIONAL_EMBEDDING_MODEL.dimension);
      assert.ok(
        Math.abs(vectorNorm(vector) - 1) < NORMALIZATION_TOLERANCE,
        "Expected an L2-normalized embedding.",
      );
    }
    console.info(
      `✓ q8 BGE-small produced normalized ${PROVISIONAL_EMBEDDING_MODEL.dimension}-dimension embeddings while health responded in ${healthWhileEmbedding.elapsedMilliseconds.toFixed(1)} ms`,
    );
  } catch (error) {
    failure = error;
  } finally {
    const shutdowns = await Promise.allSettled([worker?.close(), server?.stop(true)]);
    await rm(compatibilityDirectory, { recursive: true, force: true });
    const failedShutdown = shutdowns.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failedShutdown && failure === undefined) failure = failedShutdown.reason;
  }

  if (failure !== undefined) throw failure;
  console.info("Compatibility check passed; temporary database and model data were removed.");
}

await main();
