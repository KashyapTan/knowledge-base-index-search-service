# Plan 12 versioned embedding profiles and runtime

Plan 12 replaces the BGE-shaped runtime assumption with a closed, versioned model registry. The
default remains `Xenova/bge-small-en-v1.5`; Plan 14 owns any default-model change after matched
mixed-format evaluation on the real corpus.

## Reviewed profile registry

Every selectable model has a pinned 40-character Hub commit and an immutable profile version. The
profile is the source of truth for its tensor, pooling, tokenizer, prompts, dimensions, execution
matrix, batching, provenance, and license. Unknown model IDs and incompatible overrides fail during
configuration, before any index or inference worker is opened.

| Model | Commit | Pooling / required tensor | Dimensions | Context / app limit | Encoding and token overhead | Reviewed execution | License |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Xenova/bge-small-en-v1.5` | `ea104dacec62c0de699686887e3f920caeb4f3e3` | masked mean / `last_hidden_state` | 384 | 512 / 512 | Plan 11 instruction-free query and document; right padding; 2/2 tokens | CPU q8/fp32; WebGPU fp16/fp32 | MIT |
| `Xenova/bge-base-en-v1.5` | `4d6cd88e18e51a5e020c2c305726d76ada9c03cf` | masked mean / `last_hidden_state` | 768 | 512 / 512 | Plan 11 instruction-free query and document; right padding; 2/2 tokens | CPU q8/fp32; WebGPU fp16/fp32 | MIT |
| `Alibaba-NLP/gte-modernbert-base` | `e7f32e3c00f91d699e8c43b53106206bcc72bb22` | CLS / `last_hidden_state` | 768 | 8,192 / 512 | symmetric, no prompt; right padding; 2/2 tokens | CPU q8/fp32 | Apache-2.0 |
| `onnx-community/embeddinggemma-300m-ONNX` | `5090578d9565bb06545b4552f76e6bc2c93e4a66` | named output / `sentence_embedding` (already normalized) | 768, 512, 256, 128 | 2,048 / 512 | retrieval document/query prompts; right padding; 9/10 tokens | CPU q8/q4/fp32; fp16 prohibited | Gemma terms |
| `onnx-community/Qwen3-Embedding-0.6B-ONNX` | `c25a394dd583836952667c12f008335071b3f43d` | last non-padding token / `last_hidden_state` | 1,024, 768, 512, 256, 128, 64, 32 | 32,768 / 512 | instructed query, unprompted document; left padding; 20/1 tokens | CPU q8/fp32 | Apache-2.0 |
| `jinaai/jina-embeddings-v2-base-code` | `516f4baf13dec4ddddda8631e019b5737c8bc250` | masked mean / `last_hidden_state` | 768 | 8,192 / 512 | symmetric, no prompt; right padding; 2/2 tokens | CPU q8/fp32 | Apache-2.0 |

Token overhead is measured with each pinned tokenizer, its exact prompt, and special tokens. The
application indexing limit deliberately remains 512 for a matched Plan 14 comparison; native model
limits are recorded separately. EmbeddingGemma use remains subject to its model terms and prohibited
use policy. Its profile exposes no fp16 execution path.

`nomic-ai/CodeRankEmbed` at commit
`3c4b60807d71f79b43f3c4363786d9493691f8b1` is explicitly unavailable: the reviewed repository has
no ONNX/Transformers.js artifact and requires remote custom code. KBISS does not download or execute
arbitrary model code.

## Exact inference contract

The embedding worker loads `AutoModel` at the profile's pinned `revision`, then disables remote
loading for inference. Transformers.js 4.2 drops revision/cache options during tokenizer metadata
discovery, so explicit setup acquires only `tokenizer.json` and `tokenizer_config.json` from the same
immutable commit and atomically stores them in its revision directory. All tokenizer loads then use
that exact local directory. This avoids both the upstream cache-discovery defect and any fallback to
mutable `main`. The worker requests only the profile's required output tensor; there is no fallback
to whichever tensor happens to exist.

- Mean pooling masks padding before summing and dividing.
- CLS pooling selects the first active token.
- Last-token pooling finds the final active token from the attention mask, so both left and right
  padding are correct.
- Named-output pooling reads the exact sentence tensor and validates its declared normalization.
- Matryoshka output is truncated before a fresh L2 normalization.
- Every path validates tensor shape, row count, finite values, output dimension, non-zero magnitude,
  and normalization.

Query and document strings are composed independently and exactly once. Extraction workers load the
same pinned tokenizer locally and count the exact document prompt plus special tokens. Accelerator
bucket selection receives those prompt-aware counts. Production startup no longer loads a redundant
tokenizer on the Bun HTTP thread.

The reviewed CPU contract retains up to two warm sessions with dynamic batches of at most 16. BGE's
measured WebGPU path retains one session and fixed 64/128/256/384/512-token buckets. New candidate
accelerator paths remain disabled until measured rather than inferred from architecture support.

## Typed worker and storage boundary

An embedding response is one contiguous `Float32Array` plus row count and dimension. The worker
transfers its `ArrayBuffer` to the main process, which validates ownership and creates zero-copy row
views. Detached, offset, short, non-finite, wrong-count, and wrong-dimension buffers are rejected.
LanceDB accepts those typed row views directly, avoiding nested number-array copies while retaining
source order, bounded queues, cancellation, crash isolation, and graceful worker disposal.

## Assets, namespaces, and rebuilds

Model cache namespaces now include model ID, immutable revision, profile version, device, dtype,
dimension, and normalization. Asset manifest version 2 records:

- revision, profile version, and asset provenance;
- device, dtype, and selected ONNX output file;
- pooling strategy and required tensor;
- exact query/document encoding identities and output dimension;
- every regular asset's relative path, size, modification time, and SHA-256.

Symlinks, unsafe paths, incomplete selected outputs, changed hashes, and identity mismatches remain
fatal to offline loading. A missing or corrupt manifest cannot silently bless mutable or stale
weights.

Compatibility descriptor version 3 and index namespacing include the revision, profile version,
native and selected dimensions, pooling/tensor contract, query/document encodings, tokenizer
padding/truncation/special-token policy, provenance/license identity, device, dtype, and
normalization. Any difference enters the existing controlled rebuild flow. This deliberately treats
query prompt changes as schema changes even when document text is otherwise unchanged.

## Verification and opt-in real-model smokes

The default suite is deterministic and network-free. It covers profile validation and derivation,
all four pooling strategies, prompt accounting, execution restrictions, manifest integrity,
compatibility drift, transferable storage, bounded orchestration, cancellation/crashes/shutdown,
typed LanceDB insertion, and the absence of a main-process tokenizer load.

Real-model tests require a separately prepared, checksum-verified cache and never acquire assets:

```sh
KBISS_RUN_MODEL_SMOKE=1 \
KBISS_MODEL_CACHE_DIR=/path/to/bge-small-cache \
bun test src/indexing/bge-local.smoke.test.ts

KBISS_RUN_CANDIDATE_MODEL_SMOKES=1 \
KBISS_BGE_SMALL_CACHE_DIR=/path/to/bge-small-cache \
KBISS_GTE_MODERNBERT_CACHE_DIR=/path/to/gte-cache \
bun test src/indexing/embedding-candidates-local.smoke.test.ts
```

Only candidates with a corresponding cache variable run; the others remain explicitly skipped.
Available variables are `KBISS_BGE_SMALL_CACHE_DIR`, `KBISS_BGE_BASE_CACHE_DIR`,
`KBISS_GTE_MODERNBERT_CACHE_DIR`, `KBISS_EMBEDDINGGEMMA_CACHE_DIR`,
`KBISS_QWEN3_EMBEDDING_CACHE_DIR`, and `KBISS_JINA_CODE_CACHE_DIR`. Each smoke checks the pinned
offline worker path, documented output dimension, unit normalization, a matching-document ranking,
and clean shutdown. These are runtime compatibility checks, not Plan 14 relevance evidence.

On 2026-08-22, all six selectable profiles passed this smoke on macOS arm64 using their pinned CPU
q8 artifacts. EmbeddingGemma ran at 256 dimensions and Qwen3 at 512 to exercise truncation and
renormalization; the other profiles ran at native dimension. The BGE-small baseline smoke also
passed independently. The verified caches and downloaded weights remained outside both repositories.

## Plan 13 and 14 handoff

Plan 13 may optimize pipeline concurrency around `EmbeddingModelProfile`, exact token accounting, and
the contiguous typed-vector protocol, but must preserve the vector semantics above. Plan 14 must use
these versioned profiles for matched mixed-format evaluation and is the only plan authorized to
change the default model or query task profile.
