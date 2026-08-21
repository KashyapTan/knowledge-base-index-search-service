# 06 - Hybrid Search, Ranking, and File Aggregation

## Outcome

Implement low-latency retrieval that combines semantic similarity, BM25 exact-term relevance, and filename/path/symbol boosts, then returns the top X distinct files with their best excerpts.

## Dependencies

Complete Plans 01-05. Search must use the exact query-encoding convention paired with the document embeddings in the active index.

## Work

### Query handling

Normalize queries conservatively: trim surrounding whitespace and reject empty or unreasonably large input, but preserve identifiers, punctuation, quoted strings, paths, and casing information needed by code search.

Generate one normalized query embedding using the active local provider. Apply the documented BGE retrieval instruction only as part of a consistent, benchmarked query encoding policy.

### Candidate retrieval

Retrieve independently sized candidate pools for:

- Vector similarity over chunk embeddings.
- BM25/full-text search over enriched searchable text.
- Exact/prefix/fuzzy filename, relative-path, heading, and symbol matches.

Do not let one candidate source's raw score scale dominate another.

### Reciprocal rank fusion

Fuse vector and BM25 rankings with RRF. Treat filename/path/symbol matching as a deterministic boost or additional ranked list. Keep candidate counts, RRF constant, and boost policy configurable and observable for the final benchmark.

Do not introduce a remote reranker or a second neural model in the first release.

### File-level aggregation

The public result unit is a file. Retrieve more chunks than the requested file count, group them by file ID, and compute a stable file score that rewards the strongest chunk without allowing many mediocre chunks from one large file to overwhelm the list.

Return a bounded number of diverse excerpts per file, ideally from distinct sections. Include accurate line ranges, heading/symbol context, match source, and highlight terms where safe. Do not expose synthetic embedding prefixes as source content.

### Ranking behavior

Ensure these query classes are handled deliberately:

- Exact filename or path fragments.
- Code identifiers and configuration keys.
- Error messages or quoted phrases.
- Natural-language descriptions of concepts.
- Mixed semantic and exact-term queries.

Result scores should primarily support ordering; avoid presenting a misleading percentage relevance unless it is calibrated.

### Search service contract

Define typed request/response contracts containing query, requested file count, optional format filters, elapsed timing breakdown, result files, and excerpt metadata. Keep internal raw vectors and database rows out of the API contract.

Support request cancellation so stale UI searches do not consume unbounded embedding/query work or replace newer results.

## Acceptance criteria

- Search returns at most the requested number of distinct files.
- Exact identifiers and filenames can rank strongly even when vector similarity is weak.
- Natural-language queries benefit from vector retrieval.
- Multiple chunks from one file do not crowd out file diversity.
- Every excerpt maps to the correct file and line range.
- Fusion parameters are explicit and can be exercised by the final benchmark.
- Warm searches do not trigger document re-indexing or remote requests.

## Handoff

Plan 07 exposes the search service, file access, progress state, and lifecycle through a secure loopback-only Bun API.

