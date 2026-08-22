# 14 - Mixed-Format Search Quality and Model Evaluation

## Outcome

Significantly improve natural-language retrieval across source code, Markdown/MDX, HTML, structured
configuration, and ordinary text while preserving exact filenames, paths, symbols, errors, and
configuration keys. Compare locally runnable embedding models on reviewed team queries and select the
final default/profile from reproducible quality, indexing, latency, memory, license, and operational
evidence.

This plan owns the post-Plan-11 search-quality decision. Public benchmark scores identify candidates;
only the real mixed-format corpus and reviewed judgments can select the application's model and
ranking defaults.

## Dependencies

Complete Plans 12 and 13. Freeze their model profiles, vector semantics, chunker version, and
production indexing implementation before starting comparative runs.

Retain BM25, dense vector similarity, explicit metadata matching, weighted reciprocal rank fusion,
and distinct-file aggregation. Do not introduce a remote service or neural reranker. Keep repository
content, queries, judgments, reports containing private paths, models, and indexes local as required
by the established benchmark privacy contract.

## Work

### Separate dense and lexical representations

Stop using one enriched `searchText` as both the embedding input and BM25 document. Define and version
separate fields:

- `denseText`: compact semantic context optimized for the selected embedding profile;
- `lexicalText`: exact and normalized terms optimized for BM25;
- `displayText`: unchanged source-derived text for result excerpts and viewer navigation.

For Markdown/MDX and HTML dense text, evaluate titles, heading trails, useful metadata, visible prose,
and nearby list/table context. Continue to omit scripts, styles, active content, and noisy markup.

For code dense text, evaluate language, enclosing symbols, signatures, docstrings/comments, and code
body in a stable naturalized layout. Do not fabricate behavior not present in the source. Test whether
full path/filename/format labels help or dilute semantic vectors; exact path behavior already has
dedicated lexical/metadata retrieval and must not be assumed to improve dense search.

For structured formats, retain readable key paths and values. For fallback text, preserve contiguous
source-derived passages and safe format context.

Lexical text should preserve raw paths, filenames, headings, symbols, exact code/configuration tokens,
error strings, and source text. Add deterministic aliases for camelCase, PascalCase, snake_case,
kebab-case, dotted identifiers, namespace separators, and path segments without removing the exact
original token. Version the normalization rules and test punctuation-sensitive queries.

Any dense-text change must update the embedding-input hash and index compatibility. Lexical-only
changes must rebuild/refresh the FTS representation without unnecessarily changing compatible dense
vectors when the schema supports safe separation.

### Natural-language query encoding

Use the selected profile's documented retrieval query encoding. For instruction-aware candidates,
benchmark a concise corpus-specific instruction such as retrieving relevant source code or technical
documentation that answers a repository question. Record the exact instruction in compatibility and
benchmark reports.

For models with separate general-retrieval and code-retrieval instructions, evaluate:

- one mixed repository instruction;
- conservative query-intent routing between general and code retrieval;
- two query embeddings whose independent vector candidate lists are fused with RRF.

Document vectors must use the model's documented compatible document encoding. Query routing must be
deterministic, inexpensive, local, and unable to suppress BM25 or exact metadata results. Do not
adopt dual-query retrieval unless judged code queries improve materially without meaningful prose or
latency regressions.

### Candidate diversity before file aggregation

The product returns files, so prevent a few large files from consuming the entire chunk candidate
pool before aggregation. Benchmark:

- candidate counts derived from requested file count with explicit upper bounds;
- broader vector/BM25 over-retrieval followed by a per-file chunk cap;
- source-local per-file diversification before RRF;
- existing post-fusion supplemental score caps and diverse excerpt selection.

Preserve strong exact filename/path/symbol ordering. A per-file cap must not discard multiple
independently relevant sections needed for correct file scoring or excerpts. Keep stale-search
cancellation and format filters correct.

### Query-aware hybrid tuning

Evaluate deterministic query features that distinguish likely exact identifiers/paths/errors from
natural-language conceptual requests. If retained, use them only to select reviewed candidate counts,
source weights, or query instructions from a small explicit configuration; do not build an opaque
learned reranker.

Tune BM25, vector, and metadata RRF weights on a development judgment set while protecting a held-out
set from overfitting. Exact identifier quality, distinct-file diversity, and critical team queries are
hard constraints even when aggregate semantic metrics improve.

### Expanded reviewed judgments

Expand the real-corpus judgment set from the original ten queries to at least 50-100 reviewable team
queries, with enough examples per category to expose tradeoffs:

- natural-language request to implementation/code;
- architectural or conceptual documentation questions;
- technical question answering across code and prose;
- exact filename, relative path, symbol, configuration key, and identifier;
- quoted and paraphrased errors;
- synonyms with little lexical overlap;
- mixed semantic and exact constraints;
- HTML-visible-content questions;
- ambiguous queries with multiple relevant files/sections;
- deliberately misleading keyword overlap and large-file distractors.

Assign graded file relevance where possible and section/chunk relevance where navigation quality
matters. Record query category, criticality, expected files, optional expected sections, and judgment
rationale without committing private corpus content or paths. Have team members review important
queries rather than generating all labels automatically.

Split judgments into development and held-out evaluation sets before tuning. Keep the controlled
public fixture for deterministic CI, but do not treat its perfect score as evidence that real semantic
quality is solved.

### Metrics and decision thresholds

Report overall and per-category:

- Recall@5 and Recall@10;
- MRR and nDCG@10 using graded judgments;
- critical-query success/failure counts;
- relevant-section hit rate and first relevant excerpt rank;
- distinct-file ratio and duplicate/large-file concentration;
- exact filename/path/symbol top-1 accuracy;
- qualitative important misses fixed, introduced, or merely reordered.

Define success before inspecting final results. A candidate should normally require an absolute or
relative 5-10% improvement in the primary natural-language Recall@5/nDCG@10 measure, or fix important
repeated team-query misses, while introducing no critical exact-match regression. Use bootstrap
confidence intervals or paired per-query analysis where the judgment count supports it; never call a
one-query change significant without qualitative justification.

### Embedding model matrix

Build separate compatible indexes and run the identical held-out evaluation for:

1. BGE-small with the retained Plan 11 execution profile as the speed/quality baseline.
2. GTE ModernBERT base as the primary balanced candidate.
3. EmbeddingGemma 300M at its eligible q8/full dimension and at one evidence-backed Matryoshka
   dimension such as 256 or 512.
4. Qwen3 Embedding 0.6B at full 1,024 dimensions and, if indexing/storage cost is excessive, one
   approved Matryoshka dimension.
5. CodeRankEmbed if Plan 12 produced a verified local profile, especially for code-query strata.
6. Jina embeddings v2 base code as the compatible code-focused comparator.

Use each model's correct pooling, prompts, padding, normalization, and supported dtype rather than
forcing identical invalid inference settings. Keep extraction, chunk policy, dense/lexical
representation version, candidate logic, and ranking configuration identical during the initial
model-only comparison. Run later representation/ranking experiments against the leading candidates,
not every possible combination, and clearly label interaction effects.

Do not adopt CC-BY-NC-only candidates for the production default. Do not download or execute unreviewed
remote custom code. Do not select a model from MTEB/CoIR scores alone.

### Performance and operational comparison

For every finalist, record on matched hardware and corpus revision:

- cached model load and offline restart time;
- full initial indexing wall time, chunks/second, and stage breakdown;
- useful/padded token throughput and selected batch policy;
- peak and steady RSS and accelerator/device failures;
- verified model cache and LanceDB sizes;
- no-change reconciliation and representative incremental-edit latency;
- warm query embedding and total search p50/p95/p99;
- vector, BM25, metadata, fusion, and aggregation timings;
- first-run asset acquisition size and clean failure/fallback behavior.

Run enough repetitions to avoid single-run conclusions. Keep exact vector search unless measured
chunk count and latency justify ANN under the existing threshold policy.

### Device and precision equivalence

For each finalist/device profile, compare a reviewed reference execution with the production
device/dtype path. Measure vector cosine agreement, ranking overlap, aggregate relevance, critical
query differences, failures, and latency. Specifically cover CPU/q8 versus Apple accelerator paths
where both are supported.

The default test suite may keep large real models opt-in, but the full release gate for this plan must
run the selected model's real cached-assets smoke and relevance evaluation. A deterministic fake
provider cannot validate pooling, prompts, ONNX output selection, quantization, or WebGPU ranking
equivalence.

### Final selection and modes

Select one documented default only after quality and operational evidence is complete. If no
candidate materially beats BGE-small on reviewed natural-language queries, retain BGE-small and keep
the representation/ranking improvements rather than adopting a larger model by reputation.

If evidence supports multiple useful tradeoffs, the product may expose a small explicit set such as
`fast`, `balanced`, and `quality`, provided each maps to a complete immutable model profile, separate
state namespace, clear disk/time estimates, and tested rebuild/switch behavior. Do not make users
manually coordinate model ID, pooling, dimension, prompts, and dtype.

Document the final model, model revision, pooling, prompts, dimension, dtype/device policy, chunk
policy, dense/lexical normalization, candidate counts, fusion weights, ANN threshold, known misses,
and the evidence behind every retained default.

## Testing requirements

Add deterministic unit tests for dense/lexical representation generation across Markdown, HTML,
code, structured data, and fallback text. Cover identifier splitting, exact-token preservation,
unsafe HTML omission, path context variants, versioning, and embedding-input hashes.

Add retrieval tests proving per-file candidate caps and over-retrieval improve distinct-file
availability without losing relevant sections or exact metadata winners. Cover query categories,
format filters, dual-query fusion if used, source weights, cancellation, stable ties, and large-file
distractors.

Extend judgment parsing and metrics tests for categories, graded relevance, held-out partitions,
nDCG, section/excerpt rank, critical-query accounting, paired comparisons, and confidence reporting.
Keep all tests deterministic and ensure private judgments/reports remain outside the repository.

Run end-to-end temporary-repository tests that index and search Markdown, HTML, Python, JavaScript,
TypeScript, structured configuration, and text through the production representation and hybrid
retrieval path. Preserve path security, sanitization, read-only source handling, and exact viewer
navigation.

For each model candidate, run the Plan 12 real local-asset smoke plus the matched model benchmark. For
finalists, run full real-model relevance, performance, device/precision equivalence, no-change, and
incremental tests. Re-run the complete controlled suite after every retained representation,
candidate, or fusion change.

Maintain approximately 93% line and function coverage for new representation, query routing,
retrieval, aggregation, metric, and decision logic. The final gate must include coverage, typecheck,
lint, production build, Playwright, operations smoke, controlled relevance, integrated mutation,
selected-model local ONNX smoke, private real-corpus evaluation validation, matched performance
reports, and native compatibility checks.

## Acceptance criteria

- Dense vectors and BM25 use separately versioned, purpose-built text representations.
- Code identifiers retain exact lexical forms and useful deterministic split aliases.
- Natural-language code, documentation, HTML, and mixed queries improve materially on held-out
  reviewed judgments without critical exact-match regressions.
- Large files cannot monopolize candidate pools before distinct-file aggregation.
- At least BGE-small, GTE ModernBERT, EmbeddingGemma, and Qwen3 0.6B are either compared through valid
  local profiles or excluded with a documented concrete runtime/license failure.
- Every comparison uses correct model-specific pooling, prompts, padding, dimensions, and dtype.
- The selected default meets the predeclared relevance threshold or BGE-small is explicitly retained.
- Full indexing speed, memory, disk, startup, incremental, and query-latency costs accompany the
  quality decision.
- Production device/precision relevance is checked against a reference execution using the real
  model, not only a fake provider.
- Final model/ranking decisions are reproducible, documented, private, and require no paid or remote
  inference service.
- All existing correctness, security, privacy, viewer-navigation, and approximately 93% coverage
  requirements remain satisfied.

## Handoff

The application is ready for a new release baseline. Record completion notes and updated contracts in
`docs/`, retain machine-readable non-private benchmark definitions, and make future model or ranking
changes repeat this plan's held-out evaluation and compatibility process.
