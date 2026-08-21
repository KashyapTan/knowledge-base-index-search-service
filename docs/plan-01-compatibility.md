# Plan 1 compatibility record

Verified on 2026-08-20 using normal source execution (`bun run`), not
`bun build --compile`.

## Pinned runtime and dependency versions

| Component | Version | Proven import/approach |
| --- | --- | --- |
| Bun | 1.4.0 | `Bun.serve()` and Bun `Worker` running TypeScript source |
| `@lancedb/lancedb` | 0.37.1 | `import * as lancedb`; `connect(localPath)`; `createTable`; `vectorSearch` |
| `@huggingface/transformers` | 4.2.0 | `pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8", cache_dir })` |
| `onnxruntime-node` | 1.24.3 (transitive) | Node-API backend installed by the trusted dependency lifecycle script |
| React / React DOM | 19.2.8 | Vite browser asset |
| Vite / React plugin | 8.2.2 / 6.1.0 | `src/ui` root emitted to `dist/ui` |

All direct dependencies are exact in `package.json`, and `bun.lock` is committed. Bun blocks
dependency lifecycle scripts by default, so `onnxruntime-node` is explicitly listed in
`trustedDependencies`; this is required to install its platform binary during a fresh install.
Image-related `sharp` lifecycle scripts remain untrusted because this plan does not use image
pipelines.

### Bun 1.4 upgrade decision

The foundation was originally proven with Bun 1.3.12. It was upgraded to Bun 1.4.0 on 2026-08-20
after the stable release because its changes directly benefit a long-running local HTTP server with
a native inference Worker:

- Bun's release measurements report 20% lower peak memory for `Bun.serve`, substantially lower idle
  CPU use, and improved memory reclamation.
- Worker shutdown now has stronger internal lifecycle guarantees, and multiple termination crashes
  involving asynchronous work were fixed. The Web Worker API remains documented as experimental,
  so KBISS retains its typed shutdown handshake and child-process fallback.
- Node-API v10 support, more Node compatibility tests, and N-API cleanup/finalizer fixes reduce risk
  around the LanceDB and ONNX native boundary.
- Package installation includes stricter integrity, path, credential-scoping, and trusted-package
  checks. The lockfile was regenerated as Bun 1.4's version 2 format, which intentionally requires
  Bun 1.4 or newer to read.

This upgrade primarily improves server/runtime overhead and lifecycle robustness. It is not expected
to materially accelerate ONNX embedding inference, which remains dominated by model tokenization and
native inference; Plan 11 owns corpus-specific throughput comparisons.

The exact 1.4.0 release binary passed a fresh locked install, typecheck, lint, Bun tests, Vite build,
LanceDB close/reopen/vector retrieval, q8 ONNX inference in the Worker, temporary-data cleanup, and
the loopback `bun run serve` smoke check on macOS arm64. No 1.4 breaking change affected the Plan 1
code or dependencies. Composite package scripts invoke their child Bun commands through
`npm_execpath`, ensuring a version-manager-provided Bun 1.4 binary cannot accidentally delegate to
an older global Bun installation.

Sources: [Bun 1.4 release notes](https://bun.com/blog/bun-v1.4),
[Bun 1.4 breaking-change tracker](https://github.com/oven-sh/bun/issues/28792), and
[current Worker documentation](https://bun.com/docs/runtime/workers).

## Compatibility check

`bun run compat` performs one disposable end-to-end check:

1. Verifies that the check itself is running on the exact Bun version pinned by the project.
2. Creates a LanceDB database beneath an OS temporary directory, inserts two vectors, closes and
   reopens the database, and retrieves the nearest record.
3. Starts the same loopback Bun server used by `bun run serve`, checks `/api/health`, and retrieves
   the compiled Vite entry asset.
4. Starts a Bun Worker with a typed request/response protocol, loads quantized
   `Xenova/bge-small-en-v1.5`, and produces mean-pooled, L2-normalized embeddings.
5. Verifies the expected 384 dimensions and probes HTTP responsiveness while model loading and
   inference are in flight.
6. Closes native resources and removes the temporary database and model cache in a `finally` block.

No database, downloaded model, or other runtime state is written inside the Git worktree.

On the verified machine, the Bun 1.4 revalidation passed. The loopback health request completed in
0.3 ms while model loading was in flight and in 0.2 ms while embedding inference was in flight.
These timings are compatibility observations, not a cross-version performance benchmark; Plan 11
owns repeatable large-corpus measurements.

## Concurrency boundary

Bun Workers are the selected embedding boundary. The main thread owns HTTP and orchestration; the
worker owns Transformers.js model initialization and inference. Messages are discriminated unions:
`initialize`, `embed`, and `shutdown` requests receive `ready`, `embeddings`, `stopped`, or structured
`error` responses. Later plans can add batching/backpressure without changing process ownership.

Bun still documents Web Workers as experimental, particularly termination. Bun 1.4 fixes several
termination crashes, and Plan 1 observed successful module loading, native ONNX inference, message
passing, and termination on the verified platform. The client sends a typed shutdown handshake
before calling `terminate()`. If future Bun/ONNX combinations regress worker stability, the
documented fallback is a Bun child process using the same protocol shapes; no fallback was needed
in this verification.

## Support matrix

| Operating system / architecture | Plan 1 status |
| --- | --- |
| macOS 26.6 arm64 (Apple Silicon) | Verified |
| macOS x64 | Supported by upstream native packages; not yet team-verified |
| Linux glibc x64/arm64 | Supported by upstream native packages; not yet team-verified |
| Windows x64/arm64 | Supported by upstream native packages; not yet team-verified |
| Alpine/musl | Not a project target and not claimed |

Run `bun run compat` on each additional team target before promoting it to “verified.”
