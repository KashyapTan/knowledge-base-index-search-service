# Plan 13: Pipelined Indexing Throughput and Incremental Reuse

Plan 13 retains the Plan 12 BGE-small default and retrieval semantics while changing how indexing
work is scheduled and reused. The index schema is now version 2 because chunk rows contain the exact
embedding-input identity needed for safe reuse. Existing version-1 indexes therefore take the
normal controlled-rebuild path.

## Pipeline contract

Indexing uses ordered 32-file windows and three concurrent stages:

```text
prepare/extract N+1 -> embed N -> serialized LanceDB commit N-1
```

Two semaphores independently cap prepared and embedded windows at two. A prepared permit remains
owned until embedding finishes, bounding extracted text; an embedded permit remains owned until the
single writer finishes, bounding vector storage. Production-like barrier tests prove preparation,
embedding, and commit overlap across adjacent windows, while commits remain in source-path order and
writer concurrency remains one. The measured combined run retained at most 64 prepared files, 1,848
prepared chunks, one embedded window, and 2,300,928 vector bytes.

Channels backpressure producers instead of treating a full healthy queue as an error. Cancellation
stops admission, discards queued windows, waits for unavoidable active extraction/inference calls,
and never sends an incomplete window to the writer. Per-file extraction or inference failures remain
isolated. LanceDB replacement still writes chunks first and the `files` marker second, so the
existing interrupted-commit retry remains authoritative and idempotent.

Timing now reports stage busy time, stage wait/backpressure time, pipeline wall time, maximum
in-flight ownership, and embedding batch utilization. Busy durations overlap and must not be summed
as wall time.

## Prior-state and persistence contract

Prior reuse state is fetched only for the active bounded window. LanceDB selects these fields:

- chunk and file ID;
- embedding-input hash and version;
- model, immutable revision, profile, dimension, pooling, document-encoding, tokenizer, and
  normalization identities;
- extractor, chunker, and index-schema versions;
- vector.

Display/search text, paths, navigation ranges, headings, symbols, and other result metadata are not
read for reuse. ID predicates use escaped, deduplicated batches capped at 128 IDs; a production
window contains at most 32 files. Tests assert the exact projection and typed `Float32Array` result.

`updateFiles()` is a separate files-table-only merge operation. Compatible content whose timestamp,
path metadata, or cheap fingerprint changed updates only authoritative file markers. It neither reads
nor versions the chunks table and therefore avoids vector/BM25 maintenance. The benchmark's 16-file
metadata-only mutation embedded zero chunks and left the chunks table version unchanged.

Chunk vectors remain typed from the Worker response through window assembly and LanceDB row
construction. Dimension and finite-value validation occurs before persistence; row construction no
longer spreads vectors into nested JavaScript arrays.

## Embedding identity and reuse

Navigation identity remains location-aware. Separately, embedding input version 1 hashes exactly:

```text
"embedding-input-v1\0" + embeddingProvider.encodeDocument(chunk.searchText)
```

Reuse requires that hash plus the model ID, pinned revision, profile, output dimension, pooling,
normalization, document-encoding, tokenizer, extractor, chunker, and schema versions. Thus harmless
line/offset movement can reuse a vector, while prompt/context/profile changes cannot. Equal hashes
are sorted by previous chunk ID and consumed as a multiset, so duplicate inputs have deterministic
one-for-one ownership.

The real-corpus large-file fixture had 1,451 chunks. A one-chunk insertion at the start, middle, and
end embedded exactly one chunk and reused 1,450 each time.

## Chunking and accelerator scheduling

The selected tokenizer abstraction does not expose a verified cross-profile offset mapping, so Plan
13 retains chunker version 2 and its exact boundaries. Its fallback now uses a bounded 4,096-entry
per-document token-count cache around split and merge probes. Equivalence/property tests cover all
first-class format families, large declarations, overlap, Unicode, malformed input, prompt overhead,
token ceilings, and half-open navigation offsets.

Embedding execution uses both a document count ceiling and a padded-token ceiling. BGE WebGPU/fp16
allows at most 32 documents and 8,192 padded tokens per call. Fixed buckets are generated from the
configured application limit (for the default limit: 64, 128, 256, 384, and 512), so a modest input
can never jump to an unrelated model-native 8K/32K context. Short buckets may use larger batches;
long buckets remain token-budget bound. Results are restored to source order. The provider records
useful/padded tokens, fill ratio, inference time, and queue wait for every batch.

Extraction and embedding worker queues now wait for bounded capacity. Abort and shutdown wake
capacity waiters and drain active native work without ordinary queue-full failures.

## Matched benchmark evidence

Both baseline and retained runs used the clean Xpdite revision
`d9b101508af4dc35c675341c02f524159f2e913d`, the same ignore list, 586 supported files and 6,939,351
bytes, 9,646 output chunks, BGE-small revision `ea104dacec62c0de699686887e3f920caeb4f3e3`,
WebGPU/fp16, 384 dimensions, a 400/50 chunk policy, Bun 1.4.0, and the same Apple M5 Pro with 24 GiB
RAM. State and output were outside the source tree; source Git status remained clean.

| Metric | Fresh pre-change baseline | Combined Plan 13 |
| --- | ---: | ---: |
| Full-index wall time | 95,464.78 ms | 89,161.29 ms |
| Throughput | 101.04 chunks/s | 108.19 chunks/s |
| Preparation busy | 21,740.61 ms | 22,999.06 ms |
| Embedding busy | 73,196.78 ms | 74,776.80 ms |
| Commit busy | 416.93 ms | 539.57 ms |
| Finalization | 108.98 ms | 95.22 ms |
| Pipeline wall | not recorded | 89,065.44 ms |
| Peak RSS | 1,400,700,928 bytes | 1,607,401,472 bytes |
| Index size | 31,235,145 bytes | 32,173,772 bytes |
| No-change reconciliation | 54.78 ms | 84.43 ms |

The retained result reduces full-index wall time by 6.60% and raises throughput by 7.07%. The schema's
additional identity columns and the bounded overlapping working set increased observed process peak
RSS by 14.76%; this is recorded rather than hidden. The post-change peak also includes the newly added
three-position large-file fixture, which the pre-change harness did not sample, so it is a
conservative process peak rather than a strictly phase-matched memory delta. Directly owned in-flight
vector memory remained 2.20 MiB and independent of corpus size. Query p95 in the combined report was
below 81 ms, far from the existing severe-regression threshold.

The combined run used 3,067,706 useful versus 3,736,448 padded tokens (82.10% fill) across 524
batches. Preparation/embedding/commit queue waits were 53,335.84/14,249.79/88,525.27 ms; those waits
overlap other stages. Metadata-only work completed in 9.17 ms for 16 files with no chunk mutation.
Start/middle/end large-file edit times were 17,595.92/19,142.34/19,428.98 ms, each with one embedded
and 1,450 reused chunks. The external-copy update/delete/rename cases took 52.20/33.82/39.31 ms.

Window candidates of 64 and 32 files were measured with the same configuration. The 64-file run
completed in 89,514.27 ms at 107.76 chunks/s and retained up to 128 prepared files/2,583 chunks. The
32-file run was slightly faster and halved the prepared-file bound, so 32 is retained. The 128-ID
predicate cap remains above one window and is independently bounded for direct store callers.

Reproduction command (choose fresh output and state directories):

```text
bun run benchmark:large --root ~/Documents/Xpdite --output /tmp/kbiss-plan13/combined.json \
  --state-dir /tmp/kbiss-plan13/state --cache-dir ~/Library/Caches/kbiss \
  --embedding-device webgpu --quantization fp16 --vector-dimension 384
```

The cached model must already be pinned locally; setup is the only operation permitted to acquire
assets. The benchmark itself does not write the source repository.

## Plan 14 handoff

Plan 14 should treat index schema version 2, embedding-input version 1, chunker version 2, the
32-file/two-stage-cap pipeline, 128-ID projected reads, and the BGE WebGPU 8,192-token budget as the
frozen Plan 13 baseline. Search ranking and the default embedding model were intentionally unchanged.
Plan 14 owns broader mixed-format judgments and any retained model/default decision.
