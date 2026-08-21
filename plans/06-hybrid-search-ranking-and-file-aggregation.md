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

## Testing requirements

Add table-driven unit tests for query preservation/validation, RRF math, tied ranks, empty candidate lists, configurable constants, filename/path/symbol boosts, score ordering, file grouping, excerpt diversity, result limits, filters, and cancellation. Include adversarial cases where one file owns many mediocre chunks, exact identifiers conflict with semantic rank, duplicate candidates arrive from several sources, and raw score scales differ.

Use a deterministic embedding provider and a temporary fixture LanceDB index for integration tests covering semantic-only, BM25-only, exact filename/path, quoted error, mixed, and no-result queries. Assert top-X means distinct files and every returned excerpt maps to correct source metadata. Keep relevance-quality benchmarking on the real corpus in Plan 11, while functional ranking correctness belongs here.

Target approximately 93% line and function coverage for non-trivial query, candidate, fusion, boost, grouping, excerpt, timing, and cancellation logic, with strong branch coverage for ranking edge cases. Run coverage, typecheck, lint, and existing checks before handoff.

## Acceptance criteria

- Search returns at most the requested number of distinct files.
- Exact identifiers and filenames can rank strongly even when vector similarity is weak.
- Natural-language queries benefit from vector retrieval.
- Multiple chunks from one file do not crowd out file diversity.
- Every excerpt maps to the correct file and line range.
- Fusion parameters are explicit and can be exercised by the final benchmark.
- Warm searches do not trigger document re-indexing or remote requests.
- Search and ranking tests meet the approximately 93% meaningful coverage target for non-trivial code.

## Handoff

Plan 07 exposes the search service, file access, progress state, and lifecycle through a secure loopback-only Bun API.

## Completion notes (2026-08-21)

- Added typed request, response, result-file, excerpt, timing, cancellation, error, candidate, and
  retriever contracts. Query normalization trims only surrounding whitespace and validates bounded
  counts/filters while preserving quotes, casing, punctuation, paths, and code identifiers.
- Added explicit validated search tuning for independent vector/BM25/metadata pools, vector distance,
  metadata fuzziness, RRF constant/source weights, excerpt limits, and capped file-score contribution.
- Added a compatibility-gated LanceDB retriever with cosine vector search, native BM25 and positional
  phrase queries, a version-invalidated lightweight metadata catalog, exact/prefix/substring/fuzzy
  filename/path/heading/symbol matching, format filters, committed-file hash validation, and empty-index
  handling. Vector search deliberately includes unindexed fragments.
- Updated Plan 5 FTS refresh to store token positions so quoted error messages use real phrase search.
- Added source-scale-independent weighted RRF, competition ranks for ties, duplicate-source handling,
  stable tie breaks, file grouping, strongest-chunk-first scoring, a bounded anti-crowding bonus, and
  diverse display-only excerpts with accurate navigation metadata and safe literal highlight terms.
- Added cancellation propagation through query inference and retrieval, with checks that prevent stale
  results from reaching callers even when a bounded native query finishes after cancellation.
- Added 48 Plan 6 tests covering query preservation/validation, tuning validation, RRF math/ties/empty
  pools/raw-scale conflicts, exact metadata boosts, adversarial large files, distinct-file limits,
  diverse excerpts, filters, cancellation, and real temporary-LanceDB semantic/BM25/exact/quoted/mixed/
  no-result behavior. Search logic reports 100% line coverage and 97.6-100% function coverage.
- The complete public contract, defaults, ranking rules, lifecycle ownership, and Plan 7 handoff are
  recorded in `docs/plan-06-hybrid-search.md`.
