# Knowledge Base Index Search Service

KBISS is a local-only search application for the `card-gateway-artifacts` repository. The current
implementation includes the Bun/React foundation, validated runtime configuration, external
per-user state layout, index compatibility checks, and a resumable file-discovery manifest with
safe recursive watching. It also includes local-only, structure-aware text extraction and
tokenizer-bounded chunking, local Worker-based BGE embeddings, and resumable LanceDB file/chunk
indexing, hybrid BM25/vector/path retrieval, and a secure loopback-only API with streamed startup
and indexing progress. The primary React search UI and full-file renderers remain in Plans 08-09.

## Requirements

- Bun 1.4.0 (pinned in `.bun-version` and `package.json`)
- A platform supported by the pinned native packages; Plan 1 is verified on macOS arm64
- Internet access for the first compatibility run, which downloads the public BGE model into a
  temporary directory and removes it when the check ends
- Internet access for the explicit first `model:setup`; indexing after setup remains offline

## Install and run

```sh
bun install --frozen-lockfile
bun run compat
bun run model:setup
bun run serve
```

`bun run serve` validates the source root, prepares external per-user state, builds the UI, and
starts the loopback server at `http://127.0.0.1:3210`, opens the browser as soon as the loading page
is available, and initializes/reconciles the local index in the background. If that port is busy,
KBISS searches the next loopback ports. A later launch detects a compatible instance anywhere in
that range and opens it instead of starting a competing index writer.

The source repository defaults to `~/dev/card-gateway-artifacts`. Override it without modifying
the project:

```sh
bun run serve --root /path/to/card-gateway-artifacts --port 3210
```

`bun run model:setup` is the explicit, one-time network-enabled model preparation step. It downloads
only the configured model into KBISS's external per-user cache and writes an integrity manifest.
Normal indexing first verifies that manifest and starts Transformers.js with remote model loading
disabled. Pass the same `--root`, `--model`, and embedding options used for `serve` when overriding
defaults.

Configuration precedence is command-line options, `KBISS_*` environment variables, the per-user
`config.json`, then defaults. See [Plan 2 runtime configuration](docs/plan-02-runtime-configuration.md)
for every setting and the OS-specific state layout. KBISS never creates the source root and never
writes indexes or model assets into either repository.

## Scripts

| Command | Purpose |
| --- | --- |
| `bun run dev` | Build the UI once, then run the local API/server lifecycle with Bun hot reload. |
| `bun run build` | Build the Vite asset and run strict TypeScript checks. |
| `bun run serve` | Build and serve the production UI asset on loopback. |
| `bun run typecheck` | Run strict TypeScript without emitting JavaScript. |
| `bun run lint` | Check formatting and lint rules with Biome. |
| `bun run model:setup` | Explicitly download/verify the configured model in the external local cache. |
| `bun run format` | Apply the repository formatter. |
| `bun test` | Run focused Bun tests. |
| `bun run test:coverage` | Run Bun tests with line and function coverage. |
| `bun run compat` | Exercise LanceDB, BGE inference, Bun Workers, HTTP, and Vite together. |

## Module boundaries

```text
src/
  server/       secure Bun HTTP API, SSE progress, file access, and graceful lifecycle
  config/       validated runtime configuration and local-state contracts
  discovery/    deterministic scanning, manifest persistence, and reconciled watching
  extraction/   safe format-aware extraction, source mapping, and tokenizer-bounded chunking
  indexing/     offline embedding provider, bounded Worker queue, and resumable LanceDB pipeline
  search/       hybrid retrieval and file-level aggregation
  shared/       environment-independent contracts and result/error conventions
  ui/           React/Vite browser application
```

The project uses tagged `Result<T, AppError>` values for expected failures at module boundaries.
Thrown exceptions remain appropriate for programmer errors; the server maps expected and
unexpected request failures to display-safe structured responses without exposing stacks or local
absolute paths.

See [Plan 1 compatibility notes](docs/plan-01-compatibility.md) for pinned native imports and the
worker boundary, and [Plan 2 runtime configuration](docs/plan-02-runtime-configuration.md) for the
configuration and persisted-state contracts. See
[Plan 3 file discovery](docs/plan-03-file-discovery.md) for inventory, change, manifest, ignore, and
watcher contracts consumed by extraction and indexing.
See [Plan 4 text extraction](docs/plan-04-text-extraction.md) for extractor selection, normalized
source mapping, chunk identity, token-limit, and Plan 5 persistence contracts.
See [Plan 5 local indexing](docs/plan-05-local-embeddings-and-indexing.md) for offline model setup,
LanceDB schemas, commit/recovery semantics, progress events, and Plan 6 retrieval contracts.
See [Plan 6 hybrid search](docs/plan-06-hybrid-search.md) for ranking and response contracts, and
[Plan 7 local API](docs/plan-07-local-api-lifecycle-security.md) for routes, SSE, lifecycle, file
containment, and browser security contracts consumed by Plans 08-09.
