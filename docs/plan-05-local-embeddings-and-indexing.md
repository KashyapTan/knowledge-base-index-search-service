# Plan 5 local embeddings and LanceDB indexing contract

Plan 5 turns successful Plan 4 chunks into normalized local vectors and persists them under the
external `ResolvedPaths.lanceDbDir`. Its public API is exported from `src/indexing/index.ts`.

```ts
const embeddings = createTransformersEmbeddingProvider(config);
const store = await openLanceIndex(config);
if (store.ok) {
  const indexing = createIndexingService(config, {
    extraction,
    embeddings,
    store: store.value,
  });
  await indexing.indexFiles(discovery.manifest.snapshot());
}
```

The Plan 7 lifecycle will compose these already-bounded services. Plan 5 does not start discovery,
the HTTP server, or the browser.

## Embedding provider and model assets

`EmbeddingProvider` owns model identity, quantization, vector dimensions, the 512-token maximum,
document/query encoding, L2 normalization, batching, warm-up, cancellation, and shutdown. BGE-small
(`Xenova/bge-small-en-v1.5`, q8, 384 dimensions) remains the default. BGE-base has a centralized
profile (`Xenova/bge-base-en-v1.5`, 768 dimensions), so Plan 11 can select it through configuration
without model-specific indexer branches. BGE v1.5 inputs currently use no query instruction; Plan 11
owns the corpus-specific decision to introduce one.

Plan 10 operationalized this contract: `bun run model:setup` remains the explicit preparation path,
and an online first `bun run serve` now also authorizes acquisition so the documented two-command
teammate flow is complete. Both paths first attempt a local-only load. When acquisition is authorized
and assets are absent, Transformers.js fetches only the configured Hugging Face model into
`ResolvedPaths.modelCacheDir`, then disables remote loading before inference. `--offline`,
`KBISS_OFFLINE`, or config `offline:true` never opts into a download and returns an actionable
`MODEL_ASSETS_MISSING`/`MODEL_ASSETS_INVALID` result. See the Plan 10 operations contract for retry,
corrupt-cache quarantine, and verified air-gapped import behavior.

After the first successful load, KBISS writes `kbiss-model-assets.json` in the model cache. It records
the selected model/quantization plus size, modification time, and SHA-256 for every regular cached
asset. Subsequent startups reject malformed, mismatched, missing, symlinked, resized, or changed
assets. Hashing uses cheap metadata first and rehashes a file when its metadata changes.

One Bun Worker owns the Transformers.js pipeline and ONNX runtime. The provider splits requests into
16-document batches by default, serializes them through a bounded queue of eight jobs, and keeps the
model warm. A full queue returns `EMBEDDING_QUEUE_FULL`. Aborted queued work never reaches inference;
an active ONNX call is allowed to finish but its result is discarded. Shutdown rejects queued work,
waits for the active call, sends the typed Worker shutdown handshake, disposes the pipeline, and then
terminates the Worker. This keeps CPU-heavy inference outside the Bun HTTP event loop without one
model instance per file.

## LanceDB tables

`openLanceIndex` opens exactly two normalized tables and validates their Arrow schemas before use.
Every field is explicit and non-null. The `vector` field is a fixed-size Float32 list whose size is
the configured embedding dimension.

The `files` table contains:

- `file_id`, root-relative path, filename, format, and MIME family;
- a stable fingerprint hash plus size and modification/change timestamp metadata;
- extraction/index status, current content hash, and a display-safe last error;
- chunk count, extractor/chunker/index-schema versions, and indexed timestamp.

The `chunks` table contains:

- `chunk_id`, `file_id`, path, filename, format, and ordinal;
- separate `display_text` and enriched `search_text`;
- the fixed-dimension normalized `vector`;
- inclusive line and half-open source-offset ranges;
- JSON heading/symbol arrays plus searchable flattened heading/symbol text;
- chunk and file content hashes, token count, and all relevant versions.

Compatibility metadata is assessed before table use and written atomically only after both schemas
validate. A fresh empty namespace initializes automatically. Corrupt metadata, incompatible inputs,
partially missing tables, or an existing database without metadata returns
`INDEX_REBUILD_REQUIRED`. Callers must opt into `rebuildIfNeeded: true` to drop and recreate the two
tables; no mismatched database is silently opened.

## Incremental commits and recovery

For each ready file, `RepositoryIndexingService` compares the current content hash and every relevant
version with the committed file row. Fully unchanged input skips extraction and inference.
Metadata-only changes update the file metadata without embedding. Content changes are extracted and
chunked, then prior vectors are reused only when chunk ID, chunk content hash, dimensions, extractor
version, and chunker version match. Remaining `searchText` values are embedded in provider batches.

The complete new chunk set is applied with one LanceDB `mergeInsert`: matching rows update, new rows
insert, and prior rows for that file that are absent from the source are deleted in the same table
commit. Only after that atomic chunk replacement succeeds does the indexer advance the `files` row,
which is the file-level commit marker. Therefore:

- interruption before the chunk commit leaves the prior complete file version;
- interruption after the chunk commit leaves a complete new chunk version and an old/missing file
  marker;
- retry reads those chunks, reuses their vectors, and idempotently completes the marker without
  duplicates or repeat inference.

Empty files atomically remove prior chunks and commit a zero-chunk file. Extraction/inference failure
removes stale chunks and records a display-safe failed file row. Deletion removes chunks first and
then the file marker; retry is idempotent.

## Search indexes and progress

At run completion, the store creates or refreshes native LanceDB full-text indexing on
`search_text` for Plan 6 BM25 retrieval and B-tree indexes on file ID, chunk ID, relative path, and
filename. The default keeps exact vector scanning below 50,000 chunks. At or above the configurable
threshold, it adds an IVF-Flat cosine index. Plan 6 must continue to include unindexed/new fragments
when using ANN so recent commits stay searchable.

`IndexingProgress` publishes `preparing`, `extracting`, `embedding`, `committing`, `deleting`,
`finalizing`, `complete`, and `cancelled` phases. It includes total/processed/unchanged/failed/deleted
files, total/embedded/reused/committed chunks, completed batches, a conservative ETA after measured
progress as an epoch-millisecond completion estimate, and file-scoped error summaries. Events never
contain file contents or queries.

## Plan 6 handoff

Plan 6 should open `files` and `chunks` from the same validated LanceDB namespace, embed queries
through `EmbeddingProvider.embedQuery`, and search `search_text` plus the fixed-size `vector`. It can
use `relative_path`, `filename`, `heading_text`, and `symbol_text` for deterministic exact/prefix
boosts. `display_text` is the excerpt source; synthetic enrichment must never be shown as file text.
Group candidates by `file_id`, and treat the files table's `index_status` and compatibility metadata
as the authoritative readiness/version boundary.
