# Plan 11 testing, relevance evaluation, and benchmarking baseline

Plan 11 closes the release with governed coverage, an integrated mutation test, browser/security
regressions, a controlled relevance corpus, a reproducible external-repository benchmark, and an
evidence-backed embedding decision. Machine-specific state, model assets, raw reports, private
judgments, absolute paths, and corpus content remain outside this repository.

## Release definitions

- `fixtures/relevance/judgments.json` is the reviewed, mixed-format controlled judgment set.
- `benchmarks/large-repository-definition.json` fixes source-oriented ignores, anonymized performance
  queries, 20 warm repetitions, and the 50,000-chunk ANN threshold.
- `benchmarks/release-thresholds.json` defines coverage, controlled relevance, correctness, read-only,
  and severe-latency gates.
- `bun run test:coverage` emits LCOV and enforces 93% line/function coverage for governed application
  code. The final baseline is 95.07% lines and 96.02% functions across 82 governed application files.
  Reviewed exclusions are documented in `docs/coverage-governance.md`.
- `bun run release:gate` runs the core suite. `--full` additionally validates external benchmark/model
  reports and runs BGE-small through the verified local-only ONNX cache.

## Controlled correctness and relevance

The default offline evaluation executes scanner → extractor → chunker → deterministic semantic
fixture → LanceDB → BM25/vector/metadata/RRF → distinct-file aggregation. It makes network access
fail closed during the test and verifies a complete no-op second pass.

Baseline: 6 files, 12 chunks, 8 judgments, Recall@5 1.000, Recall@10 1.000, MRR 1.000, distinct-file
ratio 1.000, and zero indexing failures. The corpus covers exact filenames/paths, symbols and config
keys, quoted errors, conceptual questions, synonym-only wording, misleading keyword overlap, and
multiple relevant chunks/files.

The integrated release test uses real temporary filesystem and LanceDB boundaries for atomic edit,
add, delete, rename, stale-record removal, and final no-change behavior. It found and now guards a
long-lived retriever bug: separate LanceDB table handles must checkout the latest committed snapshot
before version/catalog checks or background-indexed files remain invisible until restart.

## Xpdite benchmark baseline

The user-designated Xpdite repository was benchmarked read-only at Git revision
`d9b101508af4dc35c675341c02f524159f2e913d`. Git status was unchanged before/after both model runs.
All state and output lived in an external temporary directory. Runtime/user data, dependencies,
packaged builds, caches, media/demo assets, and VCS internals were excluded; this left the actual
code/documentation corpus.

Environment: Apple M5 Pro, 15 logical CPUs, 24 GiB RAM, macOS/Darwin 25.6, arm64, Bun 1.4.0,
Transformers.js 4.2.0, LanceDB 0.37.1, Arrow 18.1.0, 400-token target, 50-token overlap, and q8.

Corpus: 586 supported files, 6.6 MiB, and 13,003 chunks. Token counts were min 16, mean 282.8, p50
355, p95/p99/max 400. No supported file failed. At 13,003 chunks, exact vector scanning remains the
selected strategy; ANN would add maintenance without evidence of need.

### BGE comparison

| Metric | BGE small (384d) | BGE base (768d) |
| --- | ---: | ---: |
| Recall@5 | 0.400 | 0.400 |
| Recall@10 | 0.600 | 0.550 |
| MRR | 0.468 | 0.451 |
| Initial indexing | 409.4 s / 31.76 chunks/s | 708.5 s / 18.35 chunks/s |
| Warm query median across query medians | 76.3 ms | 79.3 ms |
| Warm query p95 range | 69.0–95.1 ms | 69.9–95.1 ms |
| Cached model load | 97.1 ms | 152.5 ms |
| Peak RSS | 2.6 GiB | 3.5 GiB |
| LanceDB index | 94.2 MiB | 113.3 MiB |
| Verified model cache | 33.1 MiB | 105.7 MiB |

The 10 local judgments were reviewed outside this repository and included exact, symbol/config,
quoted-error, conceptual, synonym, and mixed cases. They and the raw reports remain external to avoid
committing corpus-derived paths/content. Both models ranked exact filename, exact path, and a key
symbol first. BGE base fixed no important small-model miss, introduced an additional important miss,
and regressed Recall@10/MRR.

Decision: retain quantized `Xenova/bge-small-en-v1.5`, 384 dimensions, instruction-free BGE v1.5
query/document encoding, 400/50 chunking, existing RRF/path boosts, and exact vector search below
50,000 chunks. The model/dimension/quantization remain compatibility metadata, so a future base or
other-model index cannot overwrite the selected small index.

Known relevance limitation: exact metadata behavior is strong, but conceptual/synonym recall on this
code-heavy corpus remains modest. Base does not solve it. Future work should revise human judgments
and evaluate extraction/chunk/search tuning rather than paying base-model costs without benefit.

### Performance tuning evidence

The initial no-change reconciliation was about 21.5 seconds. Skipping search-index refresh alone did
not improve it, disproving the first hypothesis. Profiling isolated sequential per-file LanceDB reads
as the cost. A bounded `getFiles` batch contract replaced 586 queries with two batches.

After tuning, no-change reconciliation was 241.7 ms (about 89× faster), with all 586 files unchanged,
identical relevance metrics, zero failures, and unchanged source status. Warm query latency remained
stable. External-copy incremental propagation with BGE small measured 81.5 ms update, 58.0 ms delete,
and 63.9 ms rename. Viewer open/grep measured below 6 ms / 2 ms even for the 731 KiB large-file case.

### Post-baseline parallel indexing revision (2026-08-21)

The indexer now uses bounded 64-file preparation windows, bulk prior-chunk reads, corpus-wide model
batches, two warm ONNX workers on larger machines, a four-worker extraction/tokenization pool, and
one serialized LanceDB writer that commits each window with chunks first and file markers second.
This preserves the established interruption/reuse protocol while eliminating concurrent table
writes and hundreds of per-file fragments.

Read-only measurements on the same Xpdite revision, using external temporary state and the existing
verified q8 cache, produced the following evidence:

| Measurement | Before | After |
| --- | ---: | ---: |
| Real BGE-small throughput | 31.76 chunks/s release baseline | 59.78 chunks/s |
| 512-chunk inference sample | 42.69 chunks/s, one worker | 68.42 chunks/s, two workers |
| 10,269-chunk fake-inference full pass | 82.0 s | 27.8 s after batched DB; 23.2 s with extraction workers |
| No-change reconciliation | 241.7 ms release baseline | 37.4 ms on the current default-ignore corpus |

The combined production path indexed 10,269 real-model chunks across 882 ready files in 171.8
seconds with zero failures. Stage timing was 23.37 seconds preparation, 147.73 seconds embedding,
0.58 seconds commit, and 0.11 seconds finalization. The corpus selection differs from the narrower
586-file release benchmark, so wall times are not treated as a direct regression series; normalized
real-model throughput improved by about 88%. Xpdite Git status remained unchanged.

Batch-size trials retained 16: batch 32 improved the 512-chunk sample only about 1.5%, while batch
64 regressed and required more memory. Embedding inference remains the dominant cost, so a Rust file
parser rewrite is not supported by this evidence; future backend work should target measured model
inference throughput.

## Security and release status

Path traversal/forged IDs, symlink swaps, Host/Origin/CSRF checks, Markdown/HTML/SVG sanitization,
unsafe URLs/resources, and exact reset targets retain direct tests. Plan 11 adds conservative rejection
of nested-quantifier/backreference regexes and isolates every remaining browser regex in a disposable
worker with a one-second deadline. Playwright verifies the rejection in the real viewer.

The release gate accepts no unexplained source mutation, incomplete no-change pass, indexing failure
ratio above threshold, severe query/viewer regression, incomparable model run, or ungrounded model
selection. Supported native smoke evidence remains macOS arm64; Linux quality/native checks and the
scheduled macOS compatibility workflow remain configured, while other published native targets are
documented as supported-unverified.

The final full gate passed 353 automated tests plus the opt-in real-ONNX smoke, governed coverage,
the production build, the Playwright search/viewer flow, operations smoke, controlled relevance,
external benchmark/model-evidence validation, and the native compatibility check. The checked
Xpdite revision and Git status were unchanged after validation.
