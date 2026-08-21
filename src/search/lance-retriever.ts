import * as lancedb from "@lancedb/lancedb";
import type { AppConfig } from "../config/index.ts";
import { readCompatibilityMetadata } from "../config/index.ts";
import { CHUNKS_TABLE, FILES_TABLE } from "../indexing/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type {
  CandidateRetriever,
  MetadataMatch,
  RetrievedCandidatePools,
  SearchCandidate,
  SearchConfig,
  SearchError,
  SearchMatchSource,
  SearchOptions,
} from "./contracts.ts";
import { bestMetadataMatch } from "./metadata.ts";
import { quotedPhrases } from "./query.ts";

const CANDIDATE_COLUMNS = [
  "chunk_id",
  "file_id",
  "relative_path",
  "filename",
  "format",
  "display_text",
  "start_line",
  "end_line",
  "start_offset",
  "end_offset",
  "heading_trail",
  "symbols",
  "file_content_hash",
];

interface CatalogChunk {
  readonly chunkId: string;
  readonly fileId: string;
  readonly relativePath: string;
  readonly filename: string;
  readonly format: string;
  readonly headingTrail: readonly string[];
  readonly symbols: readonly string[];
  readonly fileContentHash: string;
}

interface CatalogCache {
  readonly filesVersion: number;
  readonly chunksVersion: number;
  readonly readyContentHashes: ReadonlyMap<string, string>;
  readonly chunks: readonly CatalogChunk[];
  readonly staleChunkCount: number;
}

class RetrievalCancelledError extends Error {}

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RetrievalCancelledError("Search retrieval was cancelled.");
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function formatPredicate(formats: readonly string[]): string | undefined {
  return formats.length > 0 ? `format IN (${formats.map(sqlString).join(", ")})` : undefined;
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

function catalogChunk(row: Record<string, unknown>): CatalogChunk {
  return {
    chunkId: String(row.chunk_id),
    fileId: String(row.file_id),
    relativePath: String(row.relative_path),
    filename: String(row.filename),
    format: String(row.format),
    headingTrail: parseStringArray(row.heading_trail),
    symbols: parseStringArray(row.symbols),
    fileContentHash: String(row.file_content_hash),
  };
}

function candidateFromRow(
  row: Record<string, unknown>,
  source: SearchMatchSource,
  rawScore: number,
  metadataMatch?: MetadataMatch,
): SearchCandidate {
  return {
    chunkId: String(row.chunk_id),
    fileId: String(row.file_id),
    relativePath: String(row.relative_path),
    filename: String(row.filename),
    format: String(row.format),
    displayText: String(row.display_text),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    headingTrail: parseStringArray(row.heading_trail),
    symbols: parseStringArray(row.symbols),
    source,
    rawScore,
    ...(metadataMatch ? { metadataMatch } : {}),
  };
}

function isCommitted(
  row: Record<string, unknown>,
  readyContentHashes: ReadonlyMap<string, string>,
): boolean {
  return readyContentHashes.get(String(row.file_id)) === String(row.file_content_hash);
}

function fullTextQuery(query: string): string | lancedb.FullTextQuery {
  const phrases = quotedPhrases(query);
  if (phrases.length === 0) return new lancedb.MatchQuery(query, "search_text");
  const remainder = query.replaceAll(/"([^"\r\n]+)"/gu, " ").trim();
  if (!remainder && phrases.length === 1) {
    return new lancedb.PhraseQuery(phrases[0] ?? "", "search_text");
  }
  const clauses: [lancedb.Occur, lancedb.FullTextQuery][] = phrases.map((phrase) => [
    lancedb.Occur.Should,
    new lancedb.PhraseQuery(phrase, "search_text"),
  ]);
  if (remainder) {
    clauses.push([lancedb.Occur.Should, new lancedb.MatchQuery(remainder, "search_text")]);
  }
  return new lancedb.BooleanQuery(clauses);
}

function retrievalFailure(error: unknown): Result<never, SearchError> {
  if (error instanceof RetrievalCancelledError) {
    return err({ code: "SEARCH_CANCELLED", message: error.message });
  }
  return err({
    code: "SEARCH_RETRIEVAL_FAILED",
    message: "The local index could not complete search retrieval.",
  });
}

export class LanceCandidateRetriever implements CandidateRetriever {
  readonly #connection: lancedb.Connection;
  readonly #files: lancedb.Table;
  readonly #chunks: lancedb.Table;
  #catalog: CatalogCache | undefined;

  private constructor(connection: lancedb.Connection, files: lancedb.Table, chunks: lancedb.Table) {
    this.#connection = connection;
    this.#files = files;
    this.#chunks = chunks;
  }

  static async open(config: AppConfig): Promise<Result<LanceCandidateRetriever, SearchError>> {
    const compatibility = await readCompatibilityMetadata(
      config.paths.compatibilityFile,
      config.compatibility,
    );
    if (
      !compatibility.ok ||
      (compatibility.value.status !== "compatible" &&
        compatibility.value.status !== "migration-required")
    ) {
      return err({
        code: "SEARCH_INDEX_UNAVAILABLE",
        message: "A compatible local index is required before searching.",
      });
    }
    let connection: lancedb.Connection | undefined;
    let files: lancedb.Table | undefined;
    let chunks: lancedb.Table | undefined;
    try {
      connection = await lancedb.connect(config.paths.lanceDbDir);
      const names = await connection.tableNames();
      if (!names.includes(FILES_TABLE) || !names.includes(CHUNKS_TABLE)) {
        connection.close();
        return err({
          code: "SEARCH_INDEX_UNAVAILABLE",
          message: "The local index has not been initialized for search.",
        });
      }
      [files, chunks] = await Promise.all([
        connection.openTable(FILES_TABLE),
        connection.openTable(CHUNKS_TABLE),
      ]);
      const chunksSchema = await chunks.schema();
      const vectorField = chunksSchema.fields.find((field) => field.name === "vector");
      if (!vectorField?.type.toString().includes(`[${config.embedding.vectorDimension}]`)) {
        files.close();
        chunks.close();
        connection.close();
        return err({
          code: "SEARCH_INDEX_UNAVAILABLE",
          message: "The local search index does not match the active embedding dimension.",
        });
      }
      return ok(new LanceCandidateRetriever(connection, files, chunks));
    } catch {
      files?.close();
      chunks?.close();
      connection?.close();
      return err({
        code: "SEARCH_INDEX_UNAVAILABLE",
        message: "The local index could not be opened for search.",
      });
    }
  }

  async retrieve(
    query: string,
    vector: readonly number[],
    formats: readonly string[],
    config: SearchConfig,
    options: SearchOptions = {},
  ): Promise<Result<RetrievedCandidatePools, SearchError>> {
    const startedAt = performance.now();
    try {
      checkCancellation(options.signal);
      const catalog = await this.#loadCatalog(options.signal);
      checkCancellation(options.signal);
      if (catalog.chunks.length === 0) {
        const totalMs = performance.now() - startedAt;
        return ok({
          vector: [],
          bm25: [],
          metadata: [],
          timing: { totalMs, vectorMs: 0, bm25Ms: 0, metadataMs: 0 },
        });
      }
      const vectorPromise = this.#retrieveVector(
        vector,
        formats,
        config.vectorCandidates,
        config.maxVectorDistance,
        catalog.staleChunkCount,
        catalog.readyContentHashes,
        options.signal,
      );
      const bm25Promise = this.#retrieveBm25(
        query,
        formats,
        config.bm25Candidates,
        catalog.staleChunkCount,
        catalog.readyContentHashes,
        options.signal,
      );
      const metadataPromise = this.#retrieveMetadata(
        query,
        formats,
        config,
        catalog,
        options.signal,
      );
      const [vectorResult, bm25Result, metadataResult] = await Promise.all([
        vectorPromise,
        bm25Promise,
        metadataPromise,
      ]);
      checkCancellation(options.signal);
      return ok({
        vector: vectorResult.candidates,
        bm25: bm25Result.candidates,
        metadata: metadataResult.candidates,
        timing: {
          totalMs: performance.now() - startedAt,
          vectorMs: vectorResult.elapsedMs,
          bm25Ms: bm25Result.elapsedMs,
          metadataMs: metadataResult.elapsedMs,
        },
      });
    } catch (error) {
      return retrievalFailure(error);
    }
  }

  async #loadCatalog(signal?: AbortSignal): Promise<CatalogCache> {
    checkCancellation(signal);
    const [filesVersion, chunksVersion] = await Promise.all([
      this.#files.version(),
      this.#chunks.version(),
    ]);
    if (
      this.#catalog?.filesVersion === filesVersion &&
      this.#catalog.chunksVersion === chunksVersion
    ) {
      return this.#catalog;
    }
    const [fileRows, chunkRows] = (await Promise.all([
      this.#files
        .query()
        .where("index_status = 'indexed' AND extraction_status = 'extracted'")
        .select(["file_id", "content_hash"])
        .toArray(),
      this.#chunks
        .query()
        .select([
          "chunk_id",
          "file_id",
          "relative_path",
          "filename",
          "format",
          "heading_trail",
          "symbols",
          "file_content_hash",
        ])
        .toArray(),
    ])) as [Record<string, unknown>[], Record<string, unknown>[]];
    checkCancellation(signal);
    const readyContentHashes = new Map(
      fileRows.map((row) => [String(row.file_id), String(row.content_hash)]),
    );
    const chunks = chunkRows.map(catalogChunk).filter((chunk) => {
      return readyContentHashes.get(chunk.fileId) === chunk.fileContentHash;
    });
    const catalog: CatalogCache = {
      filesVersion,
      chunksVersion,
      readyContentHashes,
      chunks,
      staleChunkCount: chunkRows.length - chunks.length,
    };
    this.#catalog = catalog;
    return catalog;
  }

  async #retrieveVector(
    vector: readonly number[],
    formats: readonly string[],
    limit: number,
    maxDistance: number,
    staleChunkCount: number,
    readyContentHashes: ReadonlyMap<string, string>,
    signal?: AbortSignal,
  ): Promise<{ readonly candidates: readonly SearchCandidate[]; readonly elapsedMs: number }> {
    const startedAt = performance.now();
    checkCancellation(signal);
    let builder = this.#chunks
      .query()
      .nearestTo([...vector])
      .column("vector")
      .distanceType("cosine")
      .distanceRange(undefined, maxDistance)
      .select([...CANDIDATE_COLUMNS, "_distance"])
      .limit(limit + staleChunkCount);
    const predicate = formatPredicate(formats);
    if (predicate) builder = builder.where(predicate);
    const rows = (await builder.toArray()) as Record<string, unknown>[];
    checkCancellation(signal);
    const candidates = rows
      .filter((row) => isCommitted(row, readyContentHashes))
      .slice(0, limit)
      .map((row) => candidateFromRow(row, "vector", 1 - Number(row._distance)));
    return { candidates, elapsedMs: performance.now() - startedAt };
  }

  async #retrieveBm25(
    query: string,
    formats: readonly string[],
    limit: number,
    staleChunkCount: number,
    readyContentHashes: ReadonlyMap<string, string>,
    signal?: AbortSignal,
  ): Promise<{ readonly candidates: readonly SearchCandidate[]; readonly elapsedMs: number }> {
    const startedAt = performance.now();
    checkCancellation(signal);
    let builder = this.#chunks
      .query()
      .fullTextSearch(fullTextQuery(query), { columns: "search_text" })
      .select([...CANDIDATE_COLUMNS, "_score"])
      .limit(limit + staleChunkCount);
    const predicate = formatPredicate(formats);
    if (predicate) builder = builder.where(predicate);
    const rows = (await builder.toArray()) as Record<string, unknown>[];
    checkCancellation(signal);
    const candidates = rows
      .filter((row) => isCommitted(row, readyContentHashes))
      .slice(0, limit)
      .map((row) => candidateFromRow(row, "bm25", Number(row._score)));
    return { candidates, elapsedMs: performance.now() - startedAt };
  }

  async #retrieveMetadata(
    query: string,
    formats: readonly string[],
    config: SearchConfig,
    catalog: CatalogCache,
    signal?: AbortSignal,
  ): Promise<{ readonly candidates: readonly SearchCandidate[]; readonly elapsedMs: number }> {
    const startedAt = performance.now();
    const allowedFormats = new Set(formats);
    const perFile = new Map<string, number>();
    const matches = catalog.chunks
      .filter((chunk) => allowedFormats.size === 0 || allowedFormats.has(chunk.format))
      .map((chunk) => ({
        chunk,
        match: bestMetadataMatch(chunk, query, config),
      }))
      .filter(
        (entry): entry is { readonly chunk: CatalogChunk; readonly match: MetadataMatch } =>
          entry.match !== undefined,
      )
      .sort(
        (left, right) =>
          right.match.strength - left.match.strength ||
          left.chunk.relativePath.localeCompare(right.chunk.relativePath) ||
          left.chunk.chunkId.localeCompare(right.chunk.chunkId),
      )
      .filter(({ chunk }) => {
        const count = perFile.get(chunk.fileId) ?? 0;
        if (count >= config.metadataChunksPerFile) return false;
        perFile.set(chunk.fileId, count + 1);
        return true;
      })
      .slice(0, config.metadataCandidates);
    checkCancellation(signal);
    if (matches.length === 0) {
      return { candidates: [], elapsedMs: performance.now() - startedAt };
    }
    const predicate = `chunk_id IN (${matches.map(({ chunk }) => sqlString(chunk.chunkId)).join(", ")})`;
    const rows = (await this.#chunks
      .query()
      .where(predicate)
      .select(CANDIDATE_COLUMNS)
      .toArray()) as Record<string, unknown>[];
    checkCancellation(signal);
    const rowById = new Map(rows.map((row) => [String(row.chunk_id), row]));
    const candidates = matches.flatMap(({ chunk, match }) => {
      const row = rowById.get(chunk.chunkId);
      return row && isCommitted(row, catalog.readyContentHashes)
        ? [candidateFromRow(row, "metadata", match.strength, match)]
        : [];
    });
    return { candidates, elapsedMs: performance.now() - startedAt };
  }

  close(): void {
    this.#files.close();
    this.#chunks.close();
    this.#connection.close();
  }
}

export function openLanceCandidateRetriever(
  config: AppConfig,
): Promise<Result<LanceCandidateRetriever, SearchError>> {
  return LanceCandidateRetriever.open(config);
}
