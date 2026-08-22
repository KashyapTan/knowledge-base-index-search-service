# 13 - Pipelined Indexing Throughput and Incremental Reuse

## Outcome

Reduce initial and incremental indexing wall time and peak memory by overlapping extraction,
embedding, and persistence; eliminating unnecessary tokenizer, vector, and database work; and making
embedding reuse resilient to harmless source-line movement. Preserve responsiveness, exact vector
semantics, bounded resource use, resumability, and the chunks-first/file-marker recovery invariant.

This plan optimizes measured work. It must not change the selected embedding model or search ranking.

## Dependencies

Complete Plan 12. Read the Plan 3 scanner/fingerprint contract, Plan 4 extractor/chunker contract,
Plan 5 recovery contract, and Plan 11/12 performance evidence.

Capture a fresh, read-only baseline before implementation using the same pinned corpus revision,
ignore definition, model profile, device/dtype, chunk policy, and hardware. Record discovery,
preparation, embedding, commit, finalization, wall time, throughput, memory, no-change reconciliation,
and incremental edit measurements. Do not compare unmatched corpus selections as a regression series.

## Work

### Bounded cross-window pipeline

Replace the current window-at-a-time sequence with a bounded staged pipeline:

```text
discover/manifest
    -> prepare/extract window N+1
    -> embed window N
    -> serialized commit window N-1
```

Preparation for the next window should overlap accelerator inference for the current window, while a
single writer commits the prior completed window. Define explicit bounded capacities between stages
so prepared text and vectors cannot grow with corpus size. Backpressure must stop upstream work rather
than dropping files or returning ordinary queue-full failures during a healthy indexing run.

Preserve deterministic file ordering at commit/progress boundaries even when preparation completes
out of order. Define ownership of each window and release extracted text/vector buffers as soon as its
commit or failure handling finishes.

Cancellation must stop admission, cancel queued work, let unavoidable active native calls settle,
and avoid advancing a file marker for an incomplete window. A stage failure must retain per-file
isolation where possible and must not deadlock later shutdown. Keep one LanceDB writer and the
existing chunks-first, files-second recovery protocol.

Because stages overlap, distinguish stage busy time, queue wait/backpressure time, and wall time in
benchmark reporting. Do not imply that overlapping stage durations should sum to total wall time.

### Window-scoped projected prior-state reads

Do not load full prior chunk records for every changed file before the first window. Fetch prior state
for only the current/next bounded window, and project only fields required for the decision:

- file ID and commit-marker compatibility;
- embedding-input hash;
- vector and vector dimension;
- extractor, chunker, embedding-profile, and normalization versions;
- any minimal identity needed to handle duplicate embedding inputs deterministically.

Avoid reading display/search text, line ranges, headings, symbols, and unrelated metadata when only
vector reuse is required. Release projected prior vectors after their window commits.

Continue to batch ID predicates safely. Measure the best ID batch/window sizes on the real corpus;
do not assume 500 IDs and 64 files remain optimal after projection and pipelining.

### True metadata-only commits

Add a batched store operation that updates only `files` rows for files whose content and index schema
are already compatible. Metadata-only changes must not read, rewrite, merge, or version the chunks
table and must not trigger BM25/vector index maintenance.

Preserve the current file marker as the authoritative commit boundary. Test mass timestamp/metadata
changes so a branch checkout or file-copy operation cannot rewrite the entire vector table when
content hashes remain identical.

### Embedding-input identity and stronger reuse

Separate navigation/chunk identity from embedding identity. Retain location-aware chunk IDs for
stable viewer navigation and database replacement, but add a versioned embedding-input hash computed
from the exact profile-encoded document text after all semantic context/prefix decisions.

Reuse a prior vector when the embedding-input hash, model profile/revision, dimension, pooling,
normalization, extractor version, and relevant encoding versions match, even if line numbers or
offsets moved. Do not reuse solely by display-text hash when headings, symbols, path context, prompts,
or other embedded context changed.

Handle repeated identical chunks as a deterministic multiset so duplicate content neither steals a
vector from a semantically different context nor creates unstable assignments. A small edit near the
top of a large file should re-embed only chunks whose actual embedding input changed.

### Token-offset chunk construction

Remove repeated tokenization of progressively larger substrings in chunk splitting and merging.
Tokenize each enriched unit or document segment once with offsets when the selected tokenizer supports
reliable offset mapping, then build target and overlap ranges from token boundaries.

The optimized chunker must retain:

- the exact configured token ceiling including profile prompts and special tokens;
- heading/symbol boundaries and deterministic merging;
- approximately the configured target/overlap policy;
- accurate original line and half-open source-offset navigation;
- identical treatment of malformed/fallback text and Unicode;
- deterministic output across worker counts and machines.

If a tokenizer cannot provide dependable offsets, use a bounded cached-count fallback rather than
repeating uncached binary-search tokenization. Version the chunker if output boundaries change, and
measure resulting relevance in Plan 14 before retaining a new default policy.

### Accelerator batch utilization

Replace a universal document-count batch size with a measured token/shape budget per profile and
device. Benchmark bucket-specific batch sizes so short inputs can use larger batches without applying
the memory pressure observed for long batch-64 trials.

Generate accelerator buckets from the application indexing limit/profile rather than a fixed list
that jumps every input above 512 tokens to a model's full 8K/32K context. Preserve source ordering
after bucket scheduling. Record padded tokens, useful tokens, batch fill ratio, inference duration,
and memory so tuning minimizes wasted accelerator work instead of optimizing document count alone.

Keep safe defaults when evidence is absent. Device-specific tuning must be configurable and bounded;
do not hardcode one developer's processor or memory size.

### Typed vectors through persistence

Carry the transferable typed-vector representation from Plan 12 through window assembly and into the
Arrow/LanceDB boundary with the fewest safe copies. Avoid spreading vectors into JavaScript arrays
for validation or row construction. Validate ownership, dimension, and finite values before commit,
then release buffers after persistence.

Measure whether row-object construction or Arrow conversion becomes material after embedding is
accelerated. Do not redesign the store around an unmeasured serialization hypothesis.

### Measured secondary bottlenecks

After the preceding changes, profile the full run again. Optimize discovery traversal, path
canonicalization, hashing, extraction parsing, LanceDB index refresh, or worker counts only when the
new timing breakdown shows that stage is material. Preserve symlink containment and read-only source
behavior; never trade path security for fewer filesystem operations.

## Testing requirements

Build deterministic pipeline tests with controllable stage barriers and clocks. Prove that:

- preparation, embedding, and commit genuinely overlap across different windows;
- configured queue capacities bound prepared files, text, batches, and vector memory;
- commits remain ordered and use exactly one writer;
- backpressure waits rather than losing or falsely failing files;
- cancellation and failures at every stage drain without deadlock or partial file markers;
- interrupted chunks-first/files-second commits resume without duplicate inference or stale rows.

Add integration tests for projected window reads, large changed corpora, metadata-only file updates,
top-of-file edits, moved but semantically identical chunks, duplicate input hashes, profile/prompt
changes, and incompatible vectors. Assert database table versions where necessary to prove metadata
updates do not mutate chunks.

Add chunker equivalence/property tests covering every first-class format, large declarations,
Unicode, malformed input, overlap, model prompt overhead, exact token ceilings, and line/offset
navigation. Any intended chunk-boundary change requires reviewed fixtures and an explicit chunker
version bump.

Add batch-scheduler tests for mixed token distributions, partial buckets, long-context profiles,
result-order restoration, memory limits, cancellation, and device fallbacks. Add protocol/store tests
that detect accidental reintroduction of nested number-array copies where observable.

Run matched read-only benchmarks for:

- the current BGE WebGPU/fp16 baseline;
- cross-window pipelining alone;
- token-offset/cached chunking alone;
- projected prior reads and metadata-only commits;
- embedding-input reuse on representative edits;
- the selected bucket/batch policy;
- the combined production configuration.

Report full-index wall time and chunks/second, stage busy/wait time, useful versus padded tokens,
model utilization if observable, peak RSS, database size, no-change reconciliation, metadata-only
mass update, and single-file edits at the start/middle/end of a large file. Re-run correctness and
the existing controlled relevance suite after every retained change.

Maintain approximately 93% line and function coverage for new concurrency, reuse, chunking, and
storage logic. Run the complete coverage suite, typecheck, lint, build, cached real-model smoke,
integrated mutation flow, and matched large-corpus benchmark before handoff.

## Acceptance criteria

- At least two adjacent indexing stages demonstrably overlap under production-like load.
- Pipeline capacities bound in-flight extracted text and vector memory independently of corpus size.
- The serialized writer and chunks-first/file-marker recovery invariant remain intact.
- Prior vectors are fetched with a minimal projection per bounded window, not for the whole corpus.
- Metadata-only changes update file rows without reading or rewriting chunks.
- Line/offset movement alone does not force re-embedding when the exact embedding input is unchanged.
- Chunking avoids repeated uncached substring tokenization while preserving token and navigation
  correctness.
- Accelerator batches are selected from measured token/shape budgets and never pad modest inputs to
  an unrelated 8K/32K maximum.
- Typed vectors reach LanceDB without unnecessary nested number-array conversions.
- Full-index throughput improves materially over the matched Plan 11 WebGPU baseline without worse
  relevance, failures, responsiveness, read-only guarantees, or severe query latency.
- All retained performance claims include reproducible corpus, model, device, and hardware evidence.

## Handoff

Plan 14 freezes the optimized indexing implementation, separates dense and lexical search
representations, expands human judgments, compares the supported model profiles, tunes retrieval,
and selects the final default from quality/performance evidence.
