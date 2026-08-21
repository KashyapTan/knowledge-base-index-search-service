# Project Guide for Agents

## Mission

Build a simple, fast, private search application that lets anyone on the team find files in the local `card-gateway-artifacts` repository using natural-language or exact-term queries. The application must run entirely on the user's machine, require no paid service or API key, and never send repository content to a remote service.

The repository is greenfield. Follow the numbered plans in `plans/` in order. Each plan owns a bounded portion of the implementation and records the contracts needed by later plans.

## Intended user experience

After cloning this repository and installing dependencies, a teammate runs:

```text
bun run serve
```

The command starts one loopback-only server, opens a localhost page, loads or resumes the local index, and indexes new or changed files in the background. The UI shows indexing progress and becomes searchable as data is committed.

The main page has a search bar and returns the top X distinct files, with the best matching chunks beneath each file. Exact identifiers, filenames, and paths must work well alongside semantic queries. Selecting a result opens a full-file viewer. Markdown is rendered, HTML is shown safely, and code/text receives syntax-aware presentation. An in-viewer grep control highlights matches and supports navigating between them.

## Finalized technical direction

- Runtime, package manager, scripts, and test runner: Bun.
- Local HTTP server: `Bun.serve()` and its native routing. Do not add Fastify or Express without a demonstrated requirement.
- UI: React, TypeScript, and Vite.
- Database: embedded LanceDB OSS stored locally; do not introduce a database server.
- Search: BM25 full-text search plus vector similarity, fused with reciprocal rank fusion (RRF), plus explicit filename/path boosting.
- Embeddings: quantized `bge-small-en-v1.5` through Transformers.js/ONNX is the provisional default.
- Embedding choice must remain configurable and versioned. The final plan compares BGE small against BGE base on the real corpus before locking the default.
- Normal execution is `bun run`; do not rely on `bun build --compile`. Transformers.js and native shared libraries currently make single-executable packaging unnecessarily fragile.
- Use Bun Workers or a proven equivalent boundary for CPU-heavy embedding work so indexing cannot block the local HTTP/UI process.

## Corpus and supported formats

The target corpus is overwhelmingly Markdown, with HTML, Python, JavaScript, and other ordinary source/text files. First-class support should cover at least:

- `.md`, `.mdx`, `.markdown`
- `.html`, `.htm`
- `.py`
- `.js`, `.jsx`, `.mjs`, `.cjs`
- `.ts`, `.tsx`, `.mts`, `.cts`
- `.json`, `.jsonc`
- `.yaml`, `.yml`, `.toml`
- `.css`, `.scss`, `.sass`, `.less`
- `.sh`, `.bash`, `.zsh`
- `.sql`, `.xml`, `.csv`, `.txt`, `.log`
- Other files positively detected as ordinary UTF-8 text, using a safe fallback extractor

Images, OCR, office documents, archives, compiled binaries, and proprietary formats are out of scope unless the user explicitly expands the project later. Unsupported files must not crash or stall indexing.

## Source and local data locations

- Default source root: `~/dev/card-gateway-artifacts`.
- Allow an explicit CLI/configuration override; never assume another user's absolute home path.
- Resolve `~` from the operating system home directory, not by string concatenation.
- Keep LanceDB data, downloaded model assets, manifests, and application state in an OS-appropriate per-user application-data/cache location outside both this repository and the indexed repository.
- Namespace local state by a stable hash of the canonical source root and by index/model schema version.
- Never modify the indexed repository during scanning, benchmarking, or search.

## Core architecture and contracts

The implementation is divided into these logical components:

```text
scanner + watcher
      -> extractor registry
      -> structure-aware chunker
      -> batched local embedding worker
      -> LanceDB files/chunks tables

browser
      -> Bun HTTP API
      -> hybrid retrieval + RRF + path boost
      -> file-level result aggregation
      -> safe full-file viewer + grep
```

Maintain a file-level record and chunk-level records. Stable IDs must not depend on machine-specific absolute paths when a root-relative path is sufficient. Chunks must retain file ID, relative path, section/symbol context, content hash, and accurate line/offset information so results can navigate into the full viewer.

Search returns distinct files, not merely top chunks. Retrieve a broader candidate set, fuse the rankings, group by file, and return a small number of best excerpts per file.

## Indexing principles

- Initial indexing is incremental and resumable.
- Use cheap metadata checks first and content hashing only when needed.
- Re-embed only new or changed chunks; remove records for deleted files.
- Batch inference and apply bounded concurrency/backpressure.
- Preserve responsiveness while indexing and report progress/errors through structured events.
- Markdown chunks should respect headings and paragraphs.
- HTML search text should represent visible content, titles, headings, and useful metadata; omit scripts and styles.
- Code chunks should prefer functions, classes, and logical declarations, with a deterministic line-window fallback.
- Use approximately 350-450 embedding tokens with modest overlap as the starting policy, then tune from benchmark evidence.
- Treat model ID, vector dimensions, chunker version, extractor version, and normalization rules as index-schema inputs. A change must trigger a controlled rebuild or a separate compatible index.

## Search principles

- Semantic search alone is insufficient for source repositories.
- BM25 must cover chunk text and useful textual metadata.
- Exact and prefix matches in filename/path/symbol data receive deterministic boosts.
- Use RRF for the first implementation; do not add a remote or neural reranker.
- Apply the BGE retrieval query instruction consistently if benchmark evidence supports it; documents must use the matching documented encoding convention.
- Make candidate counts, result count, and fusion weights explicit configuration with sensible defaults.
- Cancel or disregard stale searches when the browser submits a newer query.

## Viewer and security requirements

- Bind only to `127.0.0.1` by default.
- Reject unexpected Host headers, do not enable permissive CORS, and validate all request inputs.
- Resolve file access from opaque/stable file IDs. Canonicalize and verify every path remains within the configured root before reading it.
- Do not follow symlinks outside the source root.
- Sanitize rendered Markdown.
- Render repository HTML in a restricted sandboxed iframe with scripts, same-origin privileges, and unwanted remote loads disabled.
- Treat all indexed content as untrusted, even though it is local.
- Open external links only for validated `http:` or `https:` destinations and use `noopener`/`noreferrer` behavior.
- Avoid logging file contents, queries containing sensitive information, or large excerpts by default.

## Performance expectations

“Blazing fast” must be measured rather than asserted. Optimize the dominant work: extraction, tokenization, embedding inference, and file watching. Bun HTTP overhead is unlikely to be the bottleneck for a single local user.

Keep the embedding model warm, batch document embeddings, use bounded concurrency, cache only where correctness is clear, and avoid unnecessary re-indexing. Start with exact/brute-force vector search if the corpus is below the scale at which an ANN index helps; make that decision from measured chunk count and latency.

## Testing and coverage policy

Testing belongs in every implementation phase beginning with Plan 02; do not defer subsystem tests until Plan 11. Each plan must add or update tests for the behavior it introduces and must leave the repository's existing checks passing.

- Target approximately 93% line and function coverage for non-trivial, testable application code, with meaningful branch coverage for decision-heavy logic.
- Treat 93% as a quality target, not an invitation to pad coverage with assertions that do not verify behavior. Critical configuration, path-security, indexing, ranking, and content-sanitization branches should be covered even when aggregate coverage is already above the target.
- Exclude only genuinely trivial or non-testable material such as generated code, type-only declarations, static styling/assets, and minimal process/bootstrap glue. Every coverage exclusion must be narrow, justified, and visible in configuration or documentation.
- Prefer deterministic unit tests for pure logic, integration tests at database/filesystem/process boundaries, and focused browser tests for user interactions. Do not mock away the boundary that a test is meant to validate.
- Use temporary directories and fixture repositories. Tests must not read, index, modify, or depend on a developer's personal repositories unless running the explicit opt-in benchmark in Plan 11.
- Tests must not require network access. Exercise the real ONNX model only in a dedicated local-assets integration/smoke suite; use a deterministic fake embedder for most indexing and ranking tests.
- Every bug fix must include a regression test when the failure is non-trivial and reproducible.
- At the end of each plan, run the relevant Bun tests with coverage plus the existing typecheck, lint, and build checks. Record any intentional gap or deferred cross-system scenario in that plan's completion notes.
- Plan 11 remains responsible for closing suite-wide gaps, end-to-end release validation, relevance evaluation, security regression review, and large-corpus benchmarking; it is not the first point at which features receive tests.

## Plan execution rules

1. Read this file and the active numbered plan completely before implementation.
2. Read the completion notes or relevant contracts from all preceding plans.
3. Stay within the active plan's scope. Do not opportunistically implement later UI, packaging, or benchmark work.
4. Preserve user changes and inspect the worktree before editing.
5. Use Bun commands and maintain a committed Bun lockfile once dependencies exist.
6. Keep TypeScript strict and data contracts explicit across server, worker, database, and UI boundaries.
7. Do not add cloud services, telemetry, API keys, ChromaDB, or a second runtime.
8. Do not hardcode one developer's absolute paths or machine characteristics.
9. Record important implementation decisions in the relevant plan or project documentation so later agents inherit them.
10. Implement phase-specific tests alongside every plan from Plan 02 onward and maintain approximately 93% coverage of non-trivial, testable code. Plan 11 completes cross-system validation, relevance evaluation, and large-corpus benchmarking.

## Ordered implementation plans

1. `plans/01-project-foundation-and-bun-compatibility.md`
2. `plans/02-runtime-configuration-and-local-state.md`
3. `plans/03-file-discovery-manifest-and-watching.md`
4. `plans/04-text-extraction-and-structure-aware-chunking.md`
5. `plans/05-local-embeddings-and-lancedb-indexing.md`
6. `plans/06-hybrid-search-ranking-and-file-aggregation.md`
7. `plans/07-local-api-lifecycle-progress-and-security.md`
8. `plans/08-react-search-experience.md`
9. `plans/09-file-viewer-renderers-and-grep.md`
10. `plans/10-local-distribution-operations-and-polish.md`
11. `plans/11-testing-relevance-evaluation-and-benchmarking.md`
