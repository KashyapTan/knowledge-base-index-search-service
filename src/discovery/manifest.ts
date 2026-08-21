import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { err, ok, type Result } from "../shared/result.ts";
import type {
  DiscoveredFile,
  DiscoveryError,
  FileChange,
  FileChangeListener,
  FileManifest,
} from "./contracts.ts";

const MANIFEST_VERSION = 1;

interface PersistedManifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly rootIdentity: string;
  readonly files: readonly DiscoveredFile[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validFingerprint(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.size === "number" &&
    typeof value.modifiedAtMs === "number" &&
    typeof value.modifiedAtNs === "string" &&
    typeof value.changedAtNs === "string" &&
    typeof value.timestampPrecisionMs === "number" &&
    (value.contentHash === undefined || typeof value.contentHash === "string")
  );
}

function validFile(value: unknown, rootIdentity: string): value is DiscoveredFile {
  return (
    isObject(value) &&
    value.rootIdentity === rootIdentity &&
    typeof value.fileId === "string" &&
    typeof value.relativePath === "string" &&
    typeof value.canonicalPath === "string" &&
    typeof value.filename === "string" &&
    typeof value.extension === "string" &&
    typeof value.format === "string" &&
    typeof value.mimeFamily === "string" &&
    typeof value.readStatus === "string" &&
    typeof value.indexStatus === "string" &&
    validFingerprint(value.fingerprint)
  );
}

function parseManifest(contents: string, rootIdentity: string): PersistedManifest | undefined {
  try {
    const value: unknown = JSON.parse(contents);
    if (
      !isObject(value) ||
      value.version !== MANIFEST_VERSION ||
      value.rootIdentity !== rootIdentity ||
      !Array.isArray(value.files) ||
      !value.files.every((file) => validFile(file, rootIdentity))
    ) {
      return undefined;
    }
    return value as unknown as PersistedManifest;
  } catch {
    return undefined;
  }
}

async function readCandidate(
  path: string,
  rootIdentity: string,
): Promise<PersistedManifest | undefined> {
  try {
    return parseManifest(await readFile(path, "utf8"), rootIdentity);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export class JsonFileManifest implements FileManifest {
  readonly rootIdentity: string;
  readonly #path: string;
  readonly #listeners = new Set<FileChangeListener>();
  #files = new Map<string, DiscoveredFile>();

  private constructor(path: string, rootIdentity: string, files: readonly DiscoveredFile[]) {
    this.#path = path;
    this.rootIdentity = rootIdentity;
    for (const file of files) this.#files.set(file.fileId, file);
  }

  static async open(
    path: string,
    rootIdentity: string,
  ): Promise<Result<JsonFileManifest, DiscoveryError>> {
    const pendingPath = `${path}.pending`;
    try {
      const current = await readCandidate(path, rootIdentity);
      if (current) {
        await rm(pendingPath, { force: true });
        return ok(new JsonFileManifest(path, rootIdentity, current.files));
      }

      const pending = await readCandidate(pendingPath, rootIdentity);
      if (pending) {
        await mkdir(dirname(path), { recursive: true });
        await rename(pendingPath, path);
        return ok(new JsonFileManifest(path, rootIdentity, pending.files));
      }

      // A partial pending write or corrupt prior manifest is safe to rebuild from a full scan.
      await rm(pendingPath, { force: true });
      return ok(new JsonFileManifest(path, rootIdentity, []));
    } catch {
      return err({
        code: "MANIFEST_READ_FAILED",
        message: "The discovery manifest could not be loaded.",
      });
    }
  }

  snapshot(): readonly DiscoveredFile[] {
    return [...this.#files.values()].sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
    );
  }

  get(fileId: string): DiscoveredFile | undefined {
    return this.#files.get(fileId);
  }

  async replace(
    files: readonly DiscoveredFile[],
    changes: readonly FileChange[],
  ): Promise<Result<void, DiscoveryError>> {
    const sorted = [...files].sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
    );
    const persisted: PersistedManifest = {
      version: MANIFEST_VERSION,
      rootIdentity: this.rootIdentity,
      files: sorted,
    };
    const pendingPath = `${this.#path}.pending`;
    try {
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFile(pendingPath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
      await chmod(pendingPath, 0o600);
      await rename(pendingPath, this.#path);
    } catch {
      await rm(pendingPath, { force: true }).catch(() => undefined);
      return err({
        code: "MANIFEST_WRITE_FAILED",
        message: "The discovery manifest could not be saved.",
      });
    }

    this.#files = new Map(sorted.map((file) => [file.fileId, file]));
    if (changes.length > 0) {
      for (const listener of this.#listeners) listener(changes);
    }
    return ok(undefined);
  }

  subscribe(listener: FileChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
