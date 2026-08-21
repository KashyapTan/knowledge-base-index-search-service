# 05 - Local Embeddings and LanceDB Indexing

## Outcome

Build the resumable indexing pipeline that turns extracted chunks into normalized local vectors and persists searchable file/chunk records in embedded LanceDB without blocking the application server.

## Dependencies

Complete Plans 01-04. Use the proven Bun inference boundary, resolved local paths, discovery changes, and deterministic chunk contracts.

## Work

### Embedding provider abstraction

Define a provider interface with model identity, vector dimension, maximum tokens, document encoding, query encoding, normalization, batching, warm-up, and shutdown behavior.

Implement quantized `bge-small-en-v1.5` as the provisional provider through Transformers.js/ONNX. Keep BGE base selectable for the final evaluation without spreading model-specific conditions throughout the codebase.

Download/cache the model only in the configured local model directory, verify expected assets/checksums where possible, and disable remote model loading once local assets are ready. A missing model should yield a clear setup/progress state rather than silently contacting arbitrary endpoints.

### Non-blocking inference

Run document embedding outside the Bun HTTP event loop using the boundary chosen in Plan 01. Keep the model warm. Batch chunks according to measured memory and throughput, use bounded queues, and expose cancellation/shutdown semantics.

Do not spawn one inference worker per file. Prefer one controlled model instance initially; additional workers must be justified by measured throughput and memory.

### LanceDB schema

Create explicit `files` and `chunks` tables or equivalent normalized tables.

The files table should include file identity, relative path, format, fingerprint, size/mtime, extraction/index status, content hash, and versions.

The chunks table should include chunk identity, file ID, raw/display text, enriched search text, vector, line/offset metadata, section/symbol context, content hash, and versions.

Enforce the configured vector dimension at schema creation. Store compatibility metadata before declaring the index ready.

### Incremental update semantics

For an added/changed file:

1. Extract and chunk the current content.
2. Reuse unchanged chunk embeddings when stable IDs/content hashes permit.
3. Embed remaining chunks in batches.
4. Replace that file's searchable records as one logical commit.
5. Update the file manifest/status only after the new records are usable.

For deleted files, remove both file and chunk records. Make retries idempotent and recover safely after interruption. Avoid a window where half of a newly processed file is presented as fully indexed.

### Search indexes

Prepare full-text indexing on searchable text and metadata required by Plan 06. Start with exact vector scanning if corpus scale makes it faster/simpler. Add or refresh an ANN index only above a measured threshold; newly changed rows must remain searchable.

### Progress and errors

Publish phase, file counts, chunk counts, batching progress, estimated completion when credible, and per-file error summaries. Never include entire file contents in logs/events.

## Acceptance criteria

- Indexing uses only local model inference after model setup.
- The server remains responsive during sustained embedding work.
- Re-running an unchanged corpus performs no new embeddings.
- Editing one file updates only its affected records; deleting it removes all stale results.
- Interrupted work can resume without duplicate or half-committed file state.
- Model/dimension/chunker incompatibility triggers a controlled rebuild path.
- LanceDB state remains outside both repositories.

## Handoff

Plan 06 builds retrieval and ranking over the persisted file/chunk schema and query-embedding provider.

