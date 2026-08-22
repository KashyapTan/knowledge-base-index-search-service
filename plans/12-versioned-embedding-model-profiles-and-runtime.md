# 12 - Versioned Embedding Model Profiles and Runtime

## Outcome

Make the local embedding runtime genuinely model-aware so supported embedding families produce the
correct vectors instead of assuming that every model uses BGE-style mean pooling and instruction-free
inputs. Preserve fully local execution, explicit compatibility/rebuild behavior, bounded workers, and
the existing BGE-small default until Plan 14 selects a replacement from corpus-specific evidence.

This plan establishes capability and correctness. It does not select a new default model or tune
search ranking.

## Dependencies

Complete Plans 01-11. Read the Plan 5 indexing contract, the Plan 6 retrieval contract, and the Plan
11 model/performance evidence before changing any embedding contract.

Preserve the following established constraints:

- inference and repository content remain entirely local after explicit model acquisition;
- Bun, Transformers.js/ONNX, LanceDB, and the existing Worker boundary remain the runtime stack;
- model changes create separate compatible state or require a controlled rebuild;
- no paid API, remote inference service, telemetry, or second normal-execution runtime is introduced;
- BGE-small remains usable as the release baseline throughout this plan.

## Work

### Typed, versioned model profiles

Replace the BGE-only profile map with an explicit `EmbeddingModelProfile` registry. A profile must
own every behavior that can change the resulting vector, including:

- canonical model ID and a pinned immutable Hub revision/commit;
- model-family/profile version and asset provenance;
- supported execution devices and device-specific dtypes/quantizations;
- native output dimension and any supported Matryoshka dimensions;
- model context limit and the application-approved indexing limit;
- pooling strategy: mean, CLS, last non-padding token, or named model output;
- expected output tensor name and whether the model already normalizes it;
- query and document prefixes/instructions, including task-specific alternatives;
- tokenizer padding side, truncation behavior, special-token policy, and prompt token overhead;
- batching constraints, accelerator shape policy, and any dtype restrictions;
- license identifier and whether the model is eligible for the application's intended team use.

Do not infer pooling from whichever output tensor happens to exist. Unsupported models, missing
profiles, invalid profile/device/dtype combinations, and unexpected tensors must fail with an
actionable setup/configuration error before indexing begins.

Configuration should derive safe defaults such as vector dimension and dtype from the selected
profile. Explicit overrides must be validated against that profile. A model ID with the default
384-dimensional BGE setting must not accidentally configure an incompatible model.

### Correct model-family inference

Extend the Worker protocol and embedding worker to execute each supported pooling contract exactly:

- mean pooling must apply the attention mask before normalization;
- CLS pooling must select the documented CLS/first-token representation;
- last-token pooling must correctly handle left and right padding using the attention mask;
- model-output pooling must read the profile's required sentence-embedding tensor directly;
- Matryoshka truncation, when selected, must happen at the documented stage and be followed by L2
  normalization;
- every path must validate count, finite values, dimension, and normalization before returning.

The query and document encoding methods must use the profile's distinct prompts. Token counts used
for chunk limits and accelerator buckets must include prompts and special tokens exactly as inference
does. A prompt change is an embedding-schema change, not a search-only setting.

Retain one accelerator session by default unless measurements prove that multiple sessions improve
throughput without unacceptable memory/device contention. Retain the measured CPU worker behavior as
an explicit fallback.

### Supported candidate profiles

Add profiles sufficient for controlled benchmarking in Plan 14, subject to local asset and runtime
validation:

1. `Xenova/bge-small-en-v1.5` as the current 384-dimensional speed baseline.
2. `Alibaba-NLP/gte-modernbert-base` as the first balanced text/code candidate: CLS pooling, 768
   dimensions, and an 8,192-token native limit.
3. `onnx-community/embeddinggemma-300m-ONNX` as an on-device mixed text/code candidate: named
   sentence output, retrieval/code prompts, 768 native dimensions, approved Matryoshka dimensions,
   and its documented restriction against fp16 activations.
4. `onnx-community/Qwen3-Embedding-0.6B-ONNX` as the higher-cost quality candidate: left padding,
   last-token pooling, query instructions, and approved Matryoshka dimensions up to 1,024.
5. `nomic-ai/CodeRankEmbed` as an optional code-specialist comparison if a verified Transformers.js
   ONNX asset path is available.
6. `jinaai/jina-embeddings-v2-base-code` as an Apache-2.0 mean-pooling compatibility comparator.

Do not enable a candidate merely because its architecture appears in Transformers.js. Verify its
actual ONNX artifact, tensor contract, pooling, prompts, device/dtype combination, license, and local
performance. Models whose licenses do not permit the intended team/commercial use, including
CC-BY-NC-only candidates, may be documented but must not become selectable production profiles.

### Reproducible and private model assets

Pin every profile to an immutable model revision. Include the revision and profile version in model
cache namespacing and the integrity manifest so two fresh installations cannot silently acquire
different weights under the same compatibility identity.

Continue to verify all cached files, reject symlinks and unsafe paths, and disable remote loading
before inference. Record artifact hashes and the selected output file/dtype. Never download arbitrary
custom code for execution; profiles must work through supported Transformers.js model definitions
and reviewed ONNX assets.

### Index compatibility

Extend the compatibility descriptor and namespace inputs to include at least:

- immutable model revision and model-profile version;
- pooling strategy and output tensor contract;
- query/document encoding versions and exact task/prompt identities;
- padding/truncation and special-token policies;
- selected output dimension/Matryoshka dimension;
- device and dtype when they can materially change the stored vector set.

Any change that can alter document vectors must create a separate index or trigger the existing
controlled rebuild flow. Query-only configuration may remain search-time compatible only when the
model documentation and tests prove that stored document vectors are unchanged.

### Worker transfer and startup ownership

Change the embedding Worker boundary to return contiguous typed vector storage with transferable
`ArrayBuffer` ownership instead of nested JavaScript number arrays where the LanceDB/Arrow boundary
can consume it safely. Avoid tensor-to-array-to-slice-to-array copies while preserving result order
and validation.

Remove the redundant main-process tokenizer load from production startup. Extraction workers should
own the tokenizers they use; service construction must not load an unused tokenizer on the Bun HTTP
thread. Startup cancellation, cleanup, offline acquisition, and display-safe errors must remain
correct at every failure point.

## Testing requirements

Add deterministic unit tests for profile validation, configuration derivation, revision pinning,
compatibility differences, prompt accounting, dtype/device restrictions, and every pooling strategy.
Use fixture tensors and attention masks that distinguish mean, CLS, last-token, and named-output
behavior; include left/right padding, empty/invalid masks, wrong tensors, invalid dimensions,
non-finite values, and Matryoshka renormalization.

Extend Worker protocol tests to prove transferable buffers preserve vector order, dimension, and
ownership without accepting detached or malformed storage. Retain bounded queue, cancellation,
crash, and active-work shutdown coverage.

For every production candidate profile, add an opt-in cached-assets smoke test that:

- loads the pinned revision locally through the real Bun Worker;
- disables network access during inference;
- produces the documented dimension and normalized vectors;
- verifies a known query ranks its matching document above a clear non-match;
- exercises the exact device/dtype/pooling/prompt path intended for Plan 14;
- disposes the model and terminates the Worker cleanly.

Add an integration test proving a prompt, pooling, profile-version, revision, or output-dimension
change cannot reuse an incompatible index. Update process/startup tests to prove no unused tokenizer
loads on the main process.

Maintain approximately 93% line and function coverage for new non-trivial profile, compatibility,
protocol, and orchestration logic. Run the complete Bun test suite with coverage, typecheck, lint,
production build, the BGE cached-assets smoke, and each locally available candidate smoke before
handoff. Network-free default tests must remain deterministic.

## Acceptance criteria

- BGE-small retains its established results and local/offline behavior.
- Every supported model uses its documented pooling, prompts, padding, output tensor, dimension, and
  normalization.
- Selecting an unsupported or incompatible model configuration fails before indexing.
- Fresh installations acquire a pinned immutable model revision, not a mutable model ID alone.
- All vector-affecting profile fields participate in compatibility and controlled rebuild behavior.
- The production startup path no longer loads an unused tokenizer on the main Bun process.
- Worker-to-main vector transfer avoids nested number-array copies and retains bounded memory.
- Candidate profiles needed by Plan 14 have passing real local-asset smoke evidence or are explicitly
  recorded as unavailable with a concrete runtime/license reason.
- No repository content or queries are sent to a remote service.

## Handoff

Plan 13 uses the versioned profile, exact token accounting, and typed-vector protocol to optimize the
full indexing pipeline without changing vector semantics. Plan 14 then evaluates search quality and
selects the final model/profile using real mixed-format judgments.

## Completion notes (2026-08-22)

Implemented on branch `plan-12-versioned-embedding-runtime`.

- Added a closed, deeply immutable `EmbeddingModelProfile` registry for BGE small/base, GTE
  ModernBERT, EmbeddingGemma, Qwen3 Embedding, and Jina code. Every profile pins a Hub commit and
  owns pooling/tensor, native and Matryoshka dimensions, prompt identities, exact tokenizer policy
  and overhead, context/application limits, reviewed device/dtype/batching paths, provenance, and
  license eligibility. Configuration now derives profile defaults and rejects unknown or
  incompatible selections before indexing.
- Recorded `nomic-ai/CodeRankEmbed` as unavailable because its pinned repository has no reviewed
  ONNX/Transformers.js artifact and requires custom code. BGE-small remains the default; no Plan 14
  relevance or default-model decision was pulled forward.
- Implemented masked mean, CLS, last-active-token, and required named-output pooling with strict
  tensor/mask/count/finite/dimension/normalization validation. Matryoshka truncation precedes fresh
  L2 normalization. Query and document prompts are composed independently once, and prompt-aware
  special-token counts drive extraction limits and accelerator buckets.
- Pinned both model and tokenizer acquisition. A Transformers.js 4.2 metadata probe ignores the
  tokenizer's revision/cache options, so explicit setup downloads only the two inert tokenizer JSON
  assets from the immutable commit and all later tokenizer loads target that exact local revision
  directory. Inference remains network-disabled and no custom code is fetched or executed.
- Extended model namespaces, asset manifest version 2, compatibility descriptor version 3, and
  controlled rebuild comparisons with every vector-affecting profile field. The manifest records
  revision/profile/provenance, selected ONNX output, tensor/pooling, prompt identities, dimension,
  device/dtype, and checksums while retaining symlink/path rejection.
- Replaced nested Worker number arrays with one transferable contiguous `Float32Array`; validated
  zero-copy row views flow through indexing, search, and LanceDB. Bounded queues, cancellation,
  crash handling, worker counts, result ordering, and graceful disposal remain covered.
- Removed the production main-process tokenizer load. Extraction workers own pinned local
  tokenizers, while the Bun HTTP thread only constructs the bounded worker pools.

Verification completed:

- `bun run typecheck`
- `bun run lint`
- `bun test`: 402 passed, 7 opt-in smokes skipped, 0 failed
- `bun run test:coverage`: governed gate passed at 94.93% lines and 95.82% functions; raw aggregate
  was 97.34% lines and 96.97% functions
- `bun run build`: production Vite build and final TypeScript check passed
- `bun run test:e2e`: Playwright keyboard-search flow passed
- `bun run smoke:operations`: controlled first setup and offline restart passed
- `bun run test:relevance`: controlled Recall@5/10 and MRR remained 1.0 with zero file failures
- pinned BGE-small CPU/q8 cached-assets smoke: 1 passed
- all selectable pinned CPU/q8 candidate smokes: 6 passed, including EmbeddingGemma at 256 and
  Qwen3 at 512 dimensions; every run was offline during inference and shut down cleanly

Detailed contracts, profile table, smoke variables, and Plan 13/14 handoff are recorded in
`docs/plan-12-versioned-embedding-model-profiles-and-runtime.md`.
