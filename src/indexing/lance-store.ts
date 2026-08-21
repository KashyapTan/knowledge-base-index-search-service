import * as lancedb from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Float64, Int32, Schema, Utf8 } from "apache-arrow";
import type { AppConfig } from "../config/index.ts";
import { readCompatibilityMetadata, writeCompatibilityMetadata } from "../config/index.ts";
import type { DiscoveredFile } from "../discovery/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type {
  IndexedChunkRecord,
  IndexedFileRecord,
  IndexStore,
  IndexStoreError,
} from "./contracts.ts";

export const FILES_TABLE = "files";
export const CHUNKS_TABLE = "chunks";

function required(name: string, type: ConstructorParameters<typeof Field>[1]): Field {
  return new Field(name, type, false);
}

export function createFilesSchema(): Schema {
  return new Schema([
    required("file_id", new Utf8()),
    required("relative_path", new Utf8()),
    required("filename", new Utf8()),
    required("format", new Utf8()),
    required("mime_family", new Utf8()),
    required("fingerprint_hash", new Utf8()),
    required("size", new Float64()),
    required("modified_at_ms", new Float64()),
    required("modified_at_ns", new Utf8()),
    required("changed_at_ns", new Utf8()),
    required("timestamp_precision_ms", new Float64()),
    required("extraction_status", new Utf8()),
    required("index_status", new Utf8()),
    required("content_hash", new Utf8()),
    required("last_error", new Utf8()),
    required("chunk_count", new Int32()),
    required("extractor_version", new Int32()),
    required("chunker_version", new Int32()),
    required("index_schema_version", new Int32()),
    required("indexed_at_ms", new Float64()),
  ]);
}

export function createChunksSchema(vectorDimension: number): Schema {
  return new Schema([
    required("chunk_id", new Utf8()),
    required("file_id", new Utf8()),
    required("relative_path", new Utf8()),
    required("filename", new Utf8()),
    required("format", new Utf8()),
    required("ordinal", new Int32()),
    required("display_text", new Utf8()),
    required("search_text", new Utf8()),
    required("vector", new FixedSizeList(vectorDimension, required("item", new Float32()))),
    required("start_line", new Int32()),
    required("end_line", new Int32()),
    required("start_offset", new Float64()),
    required("end_offset", new Float64()),
    required("heading_trail", new Utf8()),
    required("symbols", new Utf8()),
    required("heading_text", new Utf8()),
    required("symbol_text", new Utf8()),
    required("content_hash", new Utf8()),
    required("file_content_hash", new Utf8()),
    required("token_count", new Int32()),
    required("extractor_version", new Int32()),
    required("chunker_version", new Int32()),
    required("index_schema_version", new Int32()),
  ]);
}

function storeFailure(
  code: IndexStoreError["code"],
  message: string,
): Result<never, IndexStoreError> {
  return err({ code, message });
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function fileToRow(file: IndexedFileRecord): Record<string, unknown> {
  return {
    file_id: file.fileId,
    relative_path: file.relativePath,
    filename: file.filename,
    format: file.format,
    mime_family: file.mimeFamily,
    fingerprint_hash: file.fingerprintHash,
    size: file.size,
    modified_at_ms: file.modifiedAtMs,
    modified_at_ns: file.modifiedAtNs,
    changed_at_ns: file.changedAtNs,
    timestamp_precision_ms: file.timestampPrecisionMs,
    extraction_status: file.extractionStatus,
    index_status: file.indexStatus,
    content_hash: file.contentHash,
    last_error: file.lastError,
    chunk_count: file.chunkCount,
    extractor_version: file.extractorVersion,
    chunker_version: file.chunkerVersion,
    index_schema_version: file.indexSchemaVersion,
    indexed_at_ms: file.indexedAtMs,
  };
}

function chunkToRow(chunk: IndexedChunkRecord): Record<string, unknown> {
  return {
    chunk_id: chunk.chunkId,
    file_id: chunk.fileId,
    relative_path: chunk.relativePath,
    filename: chunk.filename,
    format: chunk.format,
    ordinal: chunk.ordinal,
    display_text: chunk.displayText,
    search_text: chunk.searchText,
    vector: [...chunk.vector],
    start_line: chunk.startLine,
    end_line: chunk.endLine,
    start_offset: chunk.startOffset,
    end_offset: chunk.endOffset,
    heading_trail: JSON.stringify(chunk.headingTrail),
    symbols: JSON.stringify(chunk.symbols),
    heading_text: chunk.headingText,
    symbol_text: chunk.symbolText,
    content_hash: chunk.contentHash,
    file_content_hash: chunk.fileContentHash,
    token_count: chunk.tokenCount,
    extractor_version: chunk.extractorVersion,
    chunker_version: chunk.chunkerVersion,
    index_schema_version: chunk.indexSchemaVersion,
  };
}

function parseStringArray(value: unknown): readonly string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function toFile(row: Record<string, unknown>): IndexedFileRecord {
  return {
    fileId: String(row.file_id),
    relativePath: String(row.relative_path),
    filename: String(row.filename),
    format: String(row.format),
    mimeFamily: String(row.mime_family),
    fingerprintHash: String(row.fingerprint_hash),
    size: Number(row.size),
    modifiedAtMs: Number(row.modified_at_ms),
    modifiedAtNs: String(row.modified_at_ns),
    changedAtNs: String(row.changed_at_ns),
    timestampPrecisionMs: Number(row.timestamp_precision_ms),
    extractionStatus: row.extraction_status === "extracted" ? "extracted" : "failed",
    indexStatus: row.index_status === "indexed" ? "indexed" : "failed",
    contentHash: String(row.content_hash),
    lastError: String(row.last_error),
    chunkCount: Number(row.chunk_count),
    extractorVersion: Number(row.extractor_version),
    chunkerVersion: Number(row.chunker_version),
    indexSchemaVersion: Number(row.index_schema_version),
    indexedAtMs: Number(row.indexed_at_ms),
  };
}

function toChunk(row: Record<string, unknown>): IndexedChunkRecord {
  const vectorValue = row.vector;
  const vector = Array.isArray(vectorValue)
    ? vectorValue.map(Number)
    : vectorValue && typeof vectorValue === "object" && Symbol.iterator in vectorValue
      ? Array.from(vectorValue as Iterable<unknown>, Number)
      : [];
  const headingTrail = parseStringArray(row.heading_trail);
  const symbols = parseStringArray(row.symbols);
  return {
    chunkId: String(row.chunk_id),
    fileId: String(row.file_id),
    relativePath: String(row.relative_path),
    filename: String(row.filename),
    format: String(row.format),
    ordinal: Number(row.ordinal),
    displayText: String(row.display_text),
    searchText: String(row.search_text),
    vector,
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    headingTrail,
    symbols,
    headingText: String(row.heading_text),
    symbolText: String(row.symbol_text),
    contentHash: String(row.content_hash),
    fileContentHash: String(row.file_content_hash),
    tokenCount: Number(row.token_count),
    extractorVersion: Number(row.extractor_version),
    chunkerVersion: Number(row.chunker_version),
    indexSchemaVersion: Number(row.index_schema_version),
  };
}

function schemaMatches(actual: Schema, expected: Schema): boolean {
  if (actual.fields.length !== expected.fields.length) return false;
  return actual.fields.every((field, index) => {
    const expectedField = expected.fields[index];
    return (
      expectedField !== undefined &&
      field.name === expectedField.name &&
      field.type.toString() === expectedField.type.toString()
    );
  });
}

export interface OpenLanceIndexOptions {
  readonly rebuildIfNeeded?: boolean;
  readonly annThreshold?: number;
  /** Deterministic crash-boundary injection for integration tests. */
  readonly beforeFileCommit?: () => Promise<void>;
}

export class LanceIndexStore implements IndexStore {
  readonly #connection: lancedb.Connection;
  readonly #files: lancedb.Table;
  readonly #chunks: lancedb.Table;
  readonly #config: AppConfig;
  readonly #annThreshold: number;
  readonly #beforeFileCommit: (() => Promise<void>) | undefined;

  private constructor(
    connection: lancedb.Connection,
    files: lancedb.Table,
    chunks: lancedb.Table,
    config: AppConfig,
    annThreshold: number,
    beforeFileCommit: (() => Promise<void>) | undefined,
  ) {
    this.#connection = connection;
    this.#files = files;
    this.#chunks = chunks;
    this.#config = config;
    this.#annThreshold = annThreshold;
    this.#beforeFileCommit = beforeFileCommit;
  }

  static async open(
    config: AppConfig,
    options: OpenLanceIndexOptions = {},
  ): Promise<Result<LanceIndexStore, IndexStoreError>> {
    const assessment = await readCompatibilityMetadata(
      config.paths.compatibilityFile,
      config.compatibility,
    );
    if (!assessment.ok) {
      return storeFailure("INDEX_OPEN_FAILED", assessment.error.message);
    }
    let connection: lancedb.Connection | undefined;
    try {
      connection = await lancedb.connect(config.paths.lanceDbDir);
      let names = await connection.tableNames();
      const hasTables = names.includes(FILES_TABLE) || names.includes(CHUNKS_TABLE);
      const hasCompleteSchema = names.includes(FILES_TABLE) && names.includes(CHUNKS_TABLE);
      const incompleteCompatibleIndex =
        (assessment.value.status === "compatible" ||
          assessment.value.status === "migration-required") &&
        !hasCompleteSchema;
      const needsRebuild =
        assessment.value.status === "corrupt" ||
        (assessment.value.status === "rebuild-required" && hasTables) ||
        incompleteCompatibleIndex;
      if (needsRebuild && !options.rebuildIfNeeded) {
        connection.close();
        return storeFailure(
          "INDEX_REBUILD_REQUIRED",
          `The local index requires a controlled rebuild: ${
            incompleteCompatibleIndex
              ? "one or more required LanceDB tables are missing"
              : assessment.value.reasons.join(", ")
          }. Run bun run rebuild with the same root/configuration options; KBISS will preserve the previous index before replacing it.`,
        );
      }
      if (needsRebuild) {
        for (const tableName of [FILES_TABLE, CHUNKS_TABLE]) {
          if (names.includes(tableName)) await connection.dropTable(tableName);
        }
        names = await connection.tableNames();
      }

      let files = names.includes(FILES_TABLE)
        ? await connection.openTable(FILES_TABLE)
        : await connection.createEmptyTable(FILES_TABLE, createFilesSchema());
      let chunks = names.includes(CHUNKS_TABLE)
        ? await connection.openTable(CHUNKS_TABLE)
        : await connection.createEmptyTable(
            CHUNKS_TABLE,
            createChunksSchema(config.embedding.vectorDimension),
          );

      let [filesSchema, chunksSchema] = await Promise.all([files.schema(), chunks.schema()]);
      const schemasMatch = () =>
        schemaMatches(filesSchema, createFilesSchema()) &&
        schemaMatches(chunksSchema, createChunksSchema(config.embedding.vectorDimension));
      if (!schemasMatch() && options.rebuildIfNeeded) {
        files.close();
        chunks.close();
        await Promise.all([connection.dropTable(FILES_TABLE), connection.dropTable(CHUNKS_TABLE)]);
        files = await connection.createEmptyTable(FILES_TABLE, createFilesSchema());
        chunks = await connection.createEmptyTable(
          CHUNKS_TABLE,
          createChunksSchema(config.embedding.vectorDimension),
        );
        [filesSchema, chunksSchema] = await Promise.all([files.schema(), chunks.schema()]);
      }
      if (!schemasMatch()) {
        files.close();
        chunks.close();
        connection.close();
        return storeFailure(
          "INDEX_SCHEMA_INVALID",
          "The LanceDB tables do not match the configured schema and vector dimension. Run bun run rebuild with the same root/configuration options; KBISS will preserve the previous index.",
        );
      }

      const compatibility = await writeCompatibilityMetadata(
        config.paths.compatibilityFile,
        config.compatibility,
      );
      if (!compatibility.ok) {
        files.close();
        chunks.close();
        connection.close();
        return storeFailure("INDEX_COMPATIBILITY_WRITE_FAILED", compatibility.error.message);
      }
      return ok(
        new LanceIndexStore(
          connection,
          files,
          chunks,
          config,
          options.annThreshold ?? 50_000,
          options.beforeFileCommit,
        ),
      );
    } catch {
      connection?.close();
      return storeFailure("INDEX_OPEN_FAILED", "The local LanceDB index could not be opened.");
    }
  }

  async getFile(fileId: string): Promise<Result<IndexedFileRecord | undefined, IndexStoreError>> {
    try {
      const rows = (await this.#files
        .query()
        .where(`file_id = ${sqlString(fileId)}`)
        .limit(1)
        .toArray()) as Record<string, unknown>[];
      return ok(rows[0] ? toFile(rows[0]) : undefined);
    } catch {
      return storeFailure("INDEX_READ_FAILED", "The indexed file record could not be read.");
    }
  }

  async getChunks(fileId: string): Promise<Result<readonly IndexedChunkRecord[], IndexStoreError>> {
    try {
      const rows = (await this.#chunks
        .query()
        .where(`file_id = ${sqlString(fileId)}`)
        .toArray()) as Record<string, unknown>[];
      return ok(rows.map(toChunk).sort((left, right) => left.ordinal - right.ordinal));
    } catch {
      return storeFailure("INDEX_READ_FAILED", "The indexed chunk records could not be read.");
    }
  }

  async replaceFile(
    file: IndexedFileRecord,
    chunks: readonly IndexedChunkRecord[],
  ): Promise<Result<void, IndexStoreError>> {
    if (chunks.some((chunk) => chunk.vector.length !== this.#config.embedding.vectorDimension)) {
      return storeFailure(
        "INDEX_SCHEMA_INVALID",
        `Every vector must contain ${this.#config.embedding.vectorDimension} values.`,
      );
    }
    try {
      if (chunks.length === 0) {
        await this.#chunks.delete(`file_id = ${sqlString(file.fileId)}`);
      } else {
        await this.#chunks
          .mergeInsert("chunk_id")
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .whenNotMatchedBySourceDelete({ where: `file_id = ${sqlString(file.fileId)}` })
          .execute(chunks.map(chunkToRow));
      }
      // This commit marker advances only after the complete searchable chunk set is usable.
      await this.#beforeFileCommit?.();
      await this.#files
        .mergeInsert("file_id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute([fileToRow(file)]);
      return ok(undefined);
    } catch {
      return storeFailure(
        "INDEX_WRITE_FAILED",
        "The file could not be committed to the local index.",
      );
    }
  }

  async markFileFailed(
    file: DiscoveredFile,
    error: { readonly code: string; readonly message: string },
  ): Promise<Result<void, IndexStoreError>> {
    const failed: IndexedFileRecord = {
      fileId: file.fileId,
      relativePath: file.relativePath,
      filename: file.filename,
      format: file.format,
      mimeFamily: file.mimeFamily,
      fingerprintHash: file.fingerprint.contentHash ?? "",
      size: file.fingerprint.size,
      modifiedAtMs: file.fingerprint.modifiedAtMs,
      modifiedAtNs: file.fingerprint.modifiedAtNs,
      changedAtNs: file.fingerprint.changedAtNs,
      timestampPrecisionMs: file.fingerprint.timestampPrecisionMs,
      extractionStatus: "failed",
      indexStatus: "failed",
      contentHash: file.fingerprint.contentHash ?? "",
      lastError: `${error.code}: ${error.message}`,
      chunkCount: 0,
      extractorVersion: this.#config.index.extractorVersion,
      chunkerVersion: this.#config.index.chunkerVersion,
      indexSchemaVersion: this.#config.index.schemaVersion,
      indexedAtMs: Date.now(),
    };
    return this.replaceFile(failed, []);
  }

  async deleteFile(fileId: string): Promise<Result<void, IndexStoreError>> {
    try {
      await this.#chunks.delete(`file_id = ${sqlString(fileId)}`);
      await this.#files.delete(`file_id = ${sqlString(fileId)}`);
      return ok(undefined);
    } catch {
      return storeFailure(
        "INDEX_WRITE_FAILED",
        "The deleted file could not be removed from the index.",
      );
    }
  }

  async refreshSearchIndexes(): Promise<Result<void, IndexStoreError>> {
    try {
      const count = await this.#chunks.countRows();
      if (count === 0) return ok(undefined);
      await this.#chunks.createIndex("search_text", {
        config: lancedb.Index.fts({
          withPosition: true,
          stem: false,
          removeStopWords: false,
        }),
        replace: true,
      });
      for (const column of ["file_id", "chunk_id", "relative_path", "filename"]) {
        await this.#chunks.createIndex(column, { config: lancedb.Index.btree(), replace: true });
      }
      if (count >= this.#annThreshold) {
        await this.#chunks.createIndex("vector", {
          config: lancedb.Index.ivfFlat({ distanceType: "cosine" }),
          replace: true,
        });
      }
      return ok(undefined);
    } catch {
      return storeFailure("INDEX_WRITE_FAILED", "The local search indexes could not be refreshed.");
    }
  }

  close(): void {
    this.#files.close();
    this.#chunks.close();
    this.#connection.close();
  }
}

export function openLanceIndex(
  config: AppConfig,
  options?: OpenLanceIndexOptions,
): Promise<Result<LanceIndexStore, IndexStoreError>> {
  return LanceIndexStore.open(config, options);
}
