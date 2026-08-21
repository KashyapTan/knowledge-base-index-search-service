# Plan 6 hybrid search contract

Plan 6 provides one cancellable, typed, local search service over the compatible Plan 5 index. Its
public API is exported from `src/search/index.ts`. Plan 7 should expose this service rather than
reimplementing query validation, database retrieval, ranking, grouping, or excerpt selection.

```ts
const opened = await openLanceCandidateRetriever(config);
if (opened.ok) {
  const search = createSearchService({ embeddings, retriever: opened.value });
  const response = await search.search(
    { query: 'timeout_ms "gateway timeout"', fileCount: 10, formats: ["yaml"] },
    { signal: requestSignal },
  );
  opened.value.close();
}
```

The embedding provider is shared with indexing and must already be warm. Search calls
`EmbeddingProvider.embedQuery` exactly once with the conservatively normalized query, so query
encoding always follows the document/query convention of the active model. BGE v1.5 currently adds
no synthetic query instruction; Plan 11 owns any evidence-based change to that paired policy.

## Query and response boundary

`SearchRequest` contains the query, optional requested file count, and optional format identifiers.
Normalization trims only surrounding whitespace. It deliberately preserves casing, punctuation,
paths, code identifiers, configuration keys, and quotes. Empty input, input over 4,096 characters,
invalid format identifiers, more than 20 distinct format filters, and file counts outside 1-50 are
rejected before inference.

`SearchResponse` repeats the normalized query, requested count, normalized filters, and an elapsed
timing breakdown for embedding, total/vector/BM25/metadata retrieval, fusion, aggregation, and the
entire request. Its public result unit is `SearchFileResult`, never a raw database row. Each file has
an ordering score, source labels, and at most three excerpts. Scores are explicitly uncalibrated and
must not be displayed as relevance percentages.

Excerpts contain only persisted `display_text`, inclusive one-based line ranges, half-open source
offsets, headings, symbols, match-source labels, and literal highlight terms that actually occur in
the display text. Neither vectors, LanceDB scores/rows, file content hashes, nor synthetic enrichment
prefixes cross the service boundary.

Public failures use `SearchError` codes for invalid query/request, cancellation, embedding failure,
unavailable/incompatible index, and retrieval failure. They do not expose a local absolute path or a
native stack trace.

## Retrieval and index readiness

`LanceCandidateRetriever` opens `files` and `chunks` only after compatibility validation. It regards
an `indexed`/`extracted` files row and a matching file-content hash as the authoritative commit
boundary. Staged, failed, deleted, or interrupted chunk generations are excluded. If stale rows are
present, database candidate limits are expanded only enough to prevent those rows from displacing
the independently configured valid candidate pool.

The retriever maintains a lightweight metadata catalog containing IDs, relative paths, filenames,
formats, headings, symbols, and commit hashes—never vectors or display text. Lance table versions
invalidate it after index updates. Metadata hits are hydrated from the table only after the bounded
pool has been selected. An initialized empty index returns an empty successful search without trying
to use absent native indexes.

The three independent candidate channels are:

- cosine vector search, with a default maximum distance of 0.9 to avoid manufacturing unrelated
  results; the query does not use `fastSearch`, so newly committed unindexed fragments remain visible;
- native BM25 over `search_text`, using positional phrase queries for quoted strings and ordinary
  match queries for other text;
- case-insensitive exact, prefix, substring, and bounded Levenshtein matches over filename, path,
  headings, and individual symbols.

Plan 5's FTS index now explicitly stores token positions, retains stop words, and disables stemming.
That makes quoted error messages deterministic while keeping identifiers intact.

## Fusion, file aggregation, and defaults

Each source is ranked independently before weighted reciprocal rank fusion, so cosine distance,
BM25 score, and metadata strength are never compared as though they shared a scale. Equal source
scores receive competition ranks; duplicate chunk IDs in one source retain the best score; and the
same chunk from multiple sources accumulates RRF contributions.

Metadata is a third weighted ranked list. The default metadata weight of 2 lets exact filenames,
paths, and identifiers overcome a weak semantic conflict without adding an unbounded raw-score
bonus. Stable path/chunk-ID tie breaks make equal scores reproducible.

File aggregation begins with the strongest chunk. Supplemental chunks use geometrically decayed
scores and can add at most 15% of the strongest score, so a large file with many mediocre chunks
cannot swamp a smaller file with one better match. Excerpts choose distinct heading/symbol contexts
first, then fill any remaining slots by score.

The exported `DEFAULT_SEARCH_CONFIG` uses:

- 10 default and 50 maximum result files;
- 100 vector, 100 BM25, and 100 metadata candidates, with at most three metadata chunks per file;
- RRF constant 60 and source weights vector=1, BM25=1, metadata=2;
- three excerpts per file, 0.25 supplemental decay, and a 0.15 maximum supplemental ratio;
- metadata edit distance at most two and cosine distance at most 0.9.

`createSearchConfig` validates every override. Plan 11 can exercise these candidate counts,
constants, weights, distance threshold, and aggregation values without editing ranking code.

## Cancellation and Plan 7 handoff

The request `AbortSignal` reaches query embedding and retrieval. Cancellation is checked before and
after inference, catalog loading, each bounded native query, fusion, and aggregation. Queued model
work is cancelled by the provider; a native LanceDB call already executing may finish internally,
but its bounded result is discarded and can never replace a newer UI response.

Plan 7 should own `LanceCandidateRetriever.close()` during graceful shutdown, keep ownership of the
shared embedding provider in the application lifecycle, map `SearchError` to structured HTTP errors,
and propagate the HTTP request signal to `SearchService.search`. It should not log raw queries or
returned excerpts by default.
