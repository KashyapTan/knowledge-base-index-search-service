# 11 - Testing, Relevance Evaluation, and Benchmarking

## Outcome

Finish the build with comprehensive automated testing, security regression coverage, corpus-specific relevance evaluation, and reproducible performance benchmarks using both controlled fixtures and the user's large external repository.

This is intentionally the final implementation plan. Plans 02-10 already add phase-specific tests; this phase closes remaining coverage gaps, validates the integrated behavior, and feeds only evidence-backed tuning changes back into the product.

## Dependencies

Complete Plans 01-10. The application must already support root overrides and keep all state outside the indexed repository.

The exact path of the user's large project may be supplied at execution time. Never hardcode a personal absolute path in committed tests or configuration.

## Work

### Test layers

Build a balanced suite using Bun's test runner where appropriate and Playwright for browser behavior:

### Coverage governance

Generate a suite-wide coverage report and bring non-trivial, testable application code to approximately 93% line and function coverage, with meaningful branch coverage for decision-heavy code. Treat this as a quality target rather than a reason to add low-value tests or manipulate source layout.

Review all exclusions added by earlier phases. Allow only narrow exclusions for generated code, type-only declarations, static assets/styles, native third-party internals, and minimal bootstrap glue; document why each excluded path cannot provide useful application-level coverage. Do not exclude difficult security, error-recovery, concurrency, or ranking branches merely to reach the number.

Use the report to identify behavior gaps, then add tests that assert outcomes and invariants. Critical path-safety, sanitization, incremental-index correctness, ranking, cancellation, and destructive-operation safeguards require direct tests regardless of aggregate coverage.

#### Unit coverage

- Configuration precedence and path resolution.
- Root namespace and compatibility-version generation.
- Text-file detection and ignore rules.
- Fingerprinting/change classification.
- Markdown, HTML, code, structured-text, and fallback extractors.
- Token-bound chunking, stable IDs, overlap, and line mapping.
- RRF, path boosts, file grouping, excerpt selection, and cancellation.
- Grep literal/regex/case behavior, including invalid and zero-width expressions.
- URL/path validation and security helpers.

#### Integration coverage

- Initial scan through extraction, embedding, LanceDB persistence, and search.
- No-op second scan.
- Add/edit/delete/rename and atomic editor saves.
- Interruption and resume without duplicate or partial records.
- Model/chunker/schema incompatibility and controlled rebuild.
- Watcher reconciliation after simulated missed events.
- Search during background indexing.
- Full-file reads by ID and stale/deleted-file handling.
- Offline startup with a populated model cache.

Use a tiny deterministic local embedding fixture/provider for most correctness tests when it improves speed, while retaining dedicated real-ONNX integration coverage so the production path is exercised.

#### End-to-end browser coverage

- Startup and progress presentation.
- Search submission, debouncing, and stale-response cancellation.
- Top-X distinct-file results and expanded excerpts.
- Markdown, HTML, code, and text viewers.
- Result-to-source-line navigation.
- Viewer grep controls and keyboard shortcuts.
- Back/Escape/focus restoration.
- Partial-index, empty, per-file error, and fatal startup states.
- Accessibility checks for core flows.

#### Security regression coverage

- Path traversal and forged IDs.
- In-root symlinks changed to out-of-root targets.
- Unexpected Host headers and cross-origin requests.
- Malicious Markdown and HTML containing scripts, event handlers, forms, popups, remote resources, and unsafe URL schemes.
- Regex denial-of-service mitigations or bounded execution behavior.
- State-reset target validation.

### Controlled relevance corpus

Create a compact fixture repository representing the real mix: mostly Markdown plus HTML, Python, JavaScript, and TypeScript. Include ambiguous concepts, repeated identifiers, exact error strings, misleading keyword overlap, and multiple relevant chunks in one file.

Define query judgments mapping each query to one or more expected files and, where useful, relevant sections. Include:

- Exact filename/path queries.
- Symbols and configuration keys.
- Error messages.
- Natural-language conceptual questions.
- Synonyms whose words do not exactly appear.
- Mixed exact and semantic queries.

Measure at least Recall@5, Recall@10, mean reciprocal rank, and distinct-file diversity. Keep judgments reviewable by humans.

### Large-repository benchmark

Point the application, through its supported root override, at the user's designated huge repository. Treat it as read-only. Write the database, model cache, temporary output, and benchmark reports outside that repository.

Capture corpus characteristics:

- Supported file count and total bytes.
- Format distribution.
- Extracted chunk count and token distribution.
- Changed/skipped/failed counts with reasons.

Measure:

- Cold startup to browser-ready.
- Model load time.
- Full initial indexing wall time and chunks/second.
- Peak and steady memory.
- Database/vector-index size.
- No-change restart/reconciliation time.
- Single-file incremental update latency.
- Delete/rename propagation latency.
- Warm query p50/p95/p99 latency.
- Vector, BM25, fusion, and query-embedding timing breakdown.
- File-viewer open time and grep time for small and unusually large files.

Run warm measurements enough times to avoid drawing conclusions from one sample. Record hardware, OS, Bun version, dependency versions, model, quantization, chunk policy, and corpus revision so results are reproducible.

### BGE small versus BGE base

Build separate compatible indexes for quantized BGE small and BGE base using identical extraction/chunking and ranking settings. Do not overwrite one model's index with the other.

Compare:

- Recall@5/10 and mean reciprocal rank on judged queries.
- Important qualitative misses fixed or introduced.
- Full indexing throughput.
- Warm query latency.
- Model load time and memory.
- LanceDB size.

Keep BGE small unless base provides a meaningful corpus-specific benefit, such as a roughly 5-10% Recall@5 improvement or fixes important team queries that small consistently misses. Do not choose base solely because its generic MTEB score is higher. Record the final decision and evidence in project documentation and index compatibility metadata.

Do not adopt BGE large in the initial release unless both smaller models fail an important documented relevance requirement and the large-model cost is separately benchmarked and accepted.

### Performance tuning loop

Use profiles and timing breakdowns to tune only demonstrated bottlenecks. Candidate changes include embedding batch size, worker boundary, chunk size/overlap, RRF candidate counts, filename/path boosts, LanceDB FTS/index maintenance, ANN threshold, frontend virtualization, and watcher debounce.

Re-run correctness and relevance checks after each meaningful tuning change. Do not trade away exact-match quality, result diversity, or incremental correctness for a synthetic throughput number.

### Release gate and reporting

Commit machine-readable benchmark/evaluation definitions and a concise human-readable baseline report. Large corpus contents and local absolute paths must not be committed.

The release gate should require:

- All automated correctness and security suites pass.
- Supported native runtime combinations pass smoke tests.
- No repository content leaves the machine during offline verification.
- No-op and incremental indexing behavior are correct.
- Core accessibility flows pass.
- Relevance metrics and known limitations are documented.
- Performance measurements have no unexplained severe regression.
- The final embedding model decision is recorded with evidence.
- The final report shows approximately 93% line and function coverage for non-trivial, testable application code, with every exclusion reviewed and justified.

## Acceptance criteria

- Automated unit, integration, end-to-end, and security coverage exercises every critical workflow.
- The user-designated large repository is indexed and benchmarked read-only with all generated data stored elsewhere.
- Search relevance is measured against reviewed expected-file judgments, not anecdotes alone.
- BGE small and base are compared under identical corpus/chunk/ranking conditions.
- The final model, chunk policy, fusion settings, and index strategy are selected from recorded results.
- A repeatable baseline report and release gate exist for future agents.
- Suite-wide coverage is approximately 93% for non-trivial code without low-value padding, and critical branches have explicit behavioral tests.
