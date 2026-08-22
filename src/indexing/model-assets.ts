import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { err, ok, type Result } from "../shared/result.ts";
import type { EmbeddingError, EmbeddingIdentity } from "./contracts.ts";

const ASSET_MANIFEST_VERSION = 2;
const MANIFEST_NAME = "kbiss-model-assets.json";

interface AssetRecord {
  readonly path: string;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly sha256: string;
}

interface AssetManifest {
  readonly version: typeof ASSET_MANIFEST_VERSION;
  readonly assetProvenance: string;
  readonly device: string;
  readonly documentEncodingId: string;
  readonly modelId: string;
  readonly outputDimension: number;
  readonly outputTensor: string;
  readonly poolingStrategy: string;
  readonly profileVersion: number;
  readonly quantization: string;
  readonly queryEncodingId: string;
  readonly revision: string;
  readonly selectedOutputFiles: readonly string[];
  readonly files: readonly AssetRecord[];
}

export type ModelAssetInspection =
  | { readonly state: "missing"; readonly message: string }
  | { readonly state: "ready"; readonly files: number }
  | { readonly state: "corrupt"; readonly message: string };

function failure(message: string): Result<never, EmbeddingError> {
  return err({ code: "MODEL_ASSETS_INVALID", message });
}

function isInside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function listAssets(root: string): Promise<AssetRecord[]> {
  const records: AssetRecord[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        entry.name === MANIFEST_NAME ||
        entry.name === `${MANIFEST_NAME}.pending` ||
        entry.name.endsWith(".lock")
      )
        continue;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("Model caches may not contain symbolic links.");
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) {
        records.push({
          path: relative(root, path).split(sep).join("/"),
          size: info.size,
          modifiedAtMs: info.mtimeMs,
          sha256: await hashFile(path),
        });
      }
    }
  }
  await walk(root);
  return records;
}

function parseManifest(text: string): AssetManifest | undefined {
  try {
    const value = JSON.parse(text) as Partial<AssetManifest>;
    if (
      value.version !== ASSET_MANIFEST_VERSION ||
      typeof value.assetProvenance !== "string" ||
      typeof value.device !== "string" ||
      typeof value.documentEncodingId !== "string" ||
      typeof value.modelId !== "string" ||
      typeof value.outputDimension !== "number" ||
      typeof value.outputTensor !== "string" ||
      typeof value.poolingStrategy !== "string" ||
      typeof value.profileVersion !== "number" ||
      typeof value.quantization !== "string" ||
      typeof value.queryEncodingId !== "string" ||
      typeof value.revision !== "string" ||
      !Array.isArray(value.selectedOutputFiles) ||
      !value.selectedOutputFiles.every((path) => typeof path === "string") ||
      !Array.isArray(value.files) ||
      !value.files.every(
        (file) =>
          typeof file.path === "string" &&
          typeof file.size === "number" &&
          typeof file.modifiedAtMs === "number" &&
          typeof file.sha256 === "string",
      )
    )
      return undefined;
    return value as AssetManifest;
  } catch {
    return undefined;
  }
}

async function verifyManifest(
  root: string,
  manifest: AssetManifest,
  identity: EmbeddingIdentity,
): Promise<Result<void, EmbeddingError>> {
  if (
    manifest.assetProvenance !== identity.profile.assetProvenance ||
    manifest.device !== identity.device ||
    manifest.documentEncodingId !== identity.profile.documentEncoding.id ||
    manifest.modelId !== identity.modelId ||
    manifest.outputDimension !== identity.vectorDimension ||
    manifest.outputTensor !== identity.profile.pooling.outputTensor ||
    manifest.poolingStrategy !== identity.profile.pooling.strategy ||
    manifest.profileVersion !== identity.profile.profileVersion ||
    manifest.quantization !== identity.quantization ||
    manifest.queryEncodingId !== identity.profile.queryEncoding.id ||
    manifest.revision !== identity.profile.revision ||
    manifest.selectedOutputFiles.length === 0 ||
    JSON.stringify(manifest.selectedOutputFiles) !==
      JSON.stringify(selectedOutputFiles(manifest.files, identity.quantization)) ||
    manifest.files.length === 0
  ) {
    return failure("The cached model asset manifest does not match the configured model.");
  }
  try {
    const canonicalRoot = await realpath(root);
    for (const asset of manifest.files) {
      const path = resolve(root, asset.path);
      if (!isInside(root, path))
        return failure("The model asset manifest contains an unsafe path.");
      const info = await lstat(path);
      const canonicalPath = await realpath(path);
      if (
        info.isSymbolicLink() ||
        !isInside(canonicalRoot, canonicalPath) ||
        !info.isFile() ||
        info.size !== asset.size
      ) {
        return failure("A cached model asset is missing or has an unexpected size.");
      }
      if (info.mtimeMs !== asset.modifiedAtMs && (await hashFile(path)) !== asset.sha256) {
        return failure("A cached model asset failed its integrity check.");
      }
    }
    return ok(undefined);
  } catch {
    return failure("The cached model assets could not be verified.");
  }
}

function selectedOutputFiles(files: readonly AssetRecord[], quantization: string): string[] {
  const file =
    quantization === "fp32" || quantization === "auto"
      ? "model.onnx"
      : quantization === "q8"
        ? "model_quantized.onnx"
        : `model_${quantization}.onnx`;
  return files
    .map((asset) => asset.path)
    .filter(
      (path) =>
        path === `onnx/${file}` ||
        path === `onnx/${file}_data` ||
        path.endsWith(`/onnx/${file}`) ||
        path.endsWith(`/onnx/${file}_data`),
    );
}

export async function inspectModelAssets(
  cacheDir: string,
  identity: EmbeddingIdentity,
): Promise<ModelAssetInspection> {
  const manifestPath = join(cacheDir, MANIFEST_NAME);
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? {
          state: "missing",
          message: "Local model assets have not been prepared yet.",
        }
      : {
          state: "corrupt",
          message: "The cached model asset manifest could not be read.",
        };
  }
  const manifest = parseManifest(text);
  if (!manifest) {
    return { state: "corrupt", message: "The cached model asset manifest is malformed." };
  }
  const verified = await verifyManifest(cacheDir, manifest, identity);
  return verified.ok
    ? { state: "ready", files: manifest.files.length }
    : { state: "corrupt", message: verified.error.message };
}

export async function quarantineModelCache(
  cacheDir: string,
): Promise<Result<string | undefined, EmbeddingError>> {
  try {
    const info = await lstat(cacheDir).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) {
      await mkdir(cacheDir, { recursive: true });
      return ok(undefined);
    }
    const backup = join(
      dirname(cacheDir),
      `${basename(cacheDir)}.corrupt-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${crypto.randomUUID()}`,
    );
    await rename(cacheDir, backup);
    await mkdir(cacheDir, { recursive: true });
    return ok(backup);
  } catch {
    return failure("The corrupt model cache could not be preserved for recovery.");
  }
}

export async function verifyOrWriteModelAssetManifest(
  cacheDir: string,
  identity: EmbeddingIdentity,
  mode: "verify" | "write-if-missing",
): Promise<Result<void, EmbeddingError>> {
  const manifestPath = join(cacheDir, MANIFEST_NAME);
  const inspection = await inspectModelAssets(cacheDir, identity);
  if (inspection.state === "ready") return ok(undefined);
  if (inspection.state === "corrupt") return failure(inspection.message);
  if (mode === "verify") return ok(undefined);
  try {
    await mkdir(cacheDir, { recursive: true });
    const files = await listAssets(cacheDir);
    if (files.length === 0) return failure("No local model assets were found after model setup.");
    const outputFiles = selectedOutputFiles(files, identity.quantization);
    if (outputFiles.length === 0)
      return failure(
        "The selected dtype's ONNX output file is missing from the local model cache.",
      );
    const manifest: AssetManifest = {
      version: ASSET_MANIFEST_VERSION,
      assetProvenance: identity.profile.assetProvenance,
      device: identity.device,
      documentEncodingId: identity.profile.documentEncoding.id,
      modelId: identity.modelId,
      outputDimension: identity.vectorDimension,
      outputTensor: identity.profile.pooling.outputTensor,
      poolingStrategy: identity.profile.pooling.strategy,
      profileVersion: identity.profile.profileVersion,
      quantization: identity.quantization,
      queryEncodingId: identity.profile.queryEncoding.id,
      revision: identity.profile.revision,
      selectedOutputFiles: outputFiles,
      files,
    };
    const temporary = `${manifestPath}.pending`;
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, manifestPath);
    return ok(undefined);
  } catch {
    return failure("The local model asset manifest could not be created.");
  }
}
