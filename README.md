# KBISS

KBISS (Knowledge Base Index Search Service) is a fast, private search app for a local
`card-gateway-artifacts` repository. It combines exact filename/path and BM25 matches with local
semantic search, groups results by file, and includes safe Markdown, HTML, code, text, diagram, and
in-file grep views.

Repository content, queries, embeddings, and indexes stay on this machine. KBISS has no telemetry,
API key, remote inference service, CDN, or remote font. On an online first run, only the pinned
public embedding profile's pinned model revision is downloaded from Hugging Face; repository content
is never sent with that request. Once verified, model loading and all search/index work are local.

## Prerequisites

- Bun **1.4.0**, pinned by `.bun-version`, `package.json`, and `bun.lock`.
- macOS arm64 is the currently verified native target.
- The pinned LanceDB/ONNX packages also publish binaries for macOS x64, Linux x64/arm64, and Windows
  x64, but KBISS does not yet run those targets in CI. `bun run doctor` reports the support tier.
- A readable local source repository. The default is `~/dev/card-gateway-artifacts`.

KBISS uses ordinary `bun run`; it does not use `bun build --compile`. Transformers.js/ONNX and
LanceDB include native libraries, and single-executable packaging is not a supported delivery path.

## Install and start

```sh
bun install
bun run serve
```

That is the normal teammate workflow. `serve` builds reproducible production UI assets, validates
the source root, starts one `127.0.0.1` server, opens the browser once, prepares or verifies the
pinned model, resumes or creates the compatible index, reconciles the repository, and watches for
changes until interrupted. The page is available during model loading and indexing and becomes
searchable as committed data is ready. Stop with Ctrl-C; KBISS checkpoints safe work and shuts down
the watcher, worker pools, LanceDB, and HTTP server.

Initial indexing is a bounded local pipeline. Apple Silicon uses four file extraction/tokenization
workers and one warm fp16 WebGPU embedding worker; CPU fallback uses up to two warm q8 ONNX workers.
Changed files are prepared in 64-file windows, missing chunks are batched across file boundaries,
and accelerator batches are grouped into fixed 64/128/256/384/512-token shapes. One serialized
writer applies each complete window to LanceDB before advancing its file commit markers. This keeps
the UI responsive, avoids concurrent database races, bounds memory, and preserves interruption-safe
resume semantics.

The first online run may take several minutes while it downloads and verifies
`Xenova/bge-small-en-v1.5`. Apple Silicon selects WebGPU/fp16; other platforms retain CPU/q8, and
either profile can be selected explicitly. Download failure is retried twice. Later launches verify
the cache and load with remote access disabled. A corrupt cache is preserved beside the managed
cache before a fresh copy is acquired.

Override the root or preferred port for one launch:

```sh
bun run serve --root /path/to/card-gateway-artifacts --port 3210
```

If the preferred port is busy, KBISS searches the next 19 loopback ports. If a compatible KBISS for
the same root is already running in that range, the command opens that instance rather than starting
a competing index writer. KBISS never falls back to a network-facing interface.

Contributor mode is separate:

```sh
bun run dev --root /path/to/fixture-repository
```

## Offline and air-gapped setup

Force a launch to use verified local assets only:

```sh
bun run serve --offline
```

`KBISS_OFFLINE=true` and an `offline` boolean in the user config are equivalent. If assets are
missing or corrupt, offline startup fails with an actionable message and leaves repository/index
data unchanged.

For an air-gapped machine, prepare the same pinned model on a connected, platform-compatible
machine:

```sh
bun run model:setup --root /path/to/a-readable-root
bun run config --root /path/to/a-readable-root
```

Copy the reported `modelCacheDir` as a whole, including `kbiss-model-assets.json`, then import it on
the air-gapped machine:

```sh
bun run model:setup --offline --asset-source /mounted/kbiss-model-bundle \
  --root /path/to/card-gateway-artifacts
bun run serve --offline --root /path/to/card-gateway-artifacts
```

Imports accept only a checksum-verified KBISS bundle with no symlinks. Any previous managed model
cache is preserved before the imported bundle replaces it. KBISS never falls back to remote
inference.

## Configuration and local storage

Precedence is command-line options, `KBISS_*` environment variables, the per-user `config.json`,
then defaults. Supported options are `--root`, `--port`, `--config`, `--state-dir`, `--cache-dir`,
`--model`, `--embedding-device`, `--quantization`, `--vector-dimension`, `--normalization`, and
`--offline`. `--embedding-device` accepts `auto`, `cpu`, `webgpu`, or `coreml`; the selected versioned
model profile validates the device, dtype, and dimension and supplies safe defaults. `auto` uses
WebGPU on Apple Silicon only for a reviewed profile path and otherwise uses that profile's default.
See the [Plan 12 embedding runtime contract](docs/plan-12-versioned-embedding-model-profiles-and-runtime.md).

Every source root uses a conservative cross-language ignore list for dependency trees, virtual
environments, build output, caches, test reports, user-specific editor/VCS state, local version
manager installations, deployment state, and compiled artifacts. It covers the common generated
output of JavaScript/TypeScript, Python, Rust, Java/Kotlin/Scala, C/C++/CMake/Make, Go, Ruby, PHP,
.NET, Swift/Xcode, Dart/Flutter, Elixir/Erlang, Haskell, OCaml, Terraform, and major production web
frameworks. Filenames containing `temp` in any casing are also ignored. The policy is curated
against GitHub's evergreen
[`gitignore` templates](https://github.com/github/gitignore) but deliberately keeps source files,
manifests, `Makefile`, lockfiles, build definitions, migrations, team editor configuration, and
version selectors searchable. View the complete resolved list with `bun run config`.

Set `ignorePatterns` in the per-user JSON configuration to replace the defaults. Patterns are
root-relative globs; a trailing slash means a directory. Copy the resolved list and remove any rule
whose content should be searchable, add project-specific generated paths, or use an empty array to
disable every configurable default:

```json
{
  "ignorePatterns": ["node_modules/", ".venv/", "dist/", "build/", "generated/**"]
}
```

`.git` internals and KBISS's external state/cache locations remain unconditional safety exclusions.
Changing the list is incremental: the next scan removes newly ignored records and indexes newly
included files without requiring a manual rebuild.

Save a new default root after validating it:

```sh
bun run root /path/to/card-gateway-artifacts
```

An explicit `KBISS_ROOT` or `--root` still takes precedence over the saved value. Print the complete
resolved configuration and exact storage paths with:

```sh
bun run config
```

Default application locations are:

| Platform | State/config | Model cache |
| --- | --- | --- |
| macOS | `~/Library/Application Support/kbiss` | `~/Library/Caches/kbiss` |
| Linux | `$XDG_STATE_HOME/kbiss` and `$XDG_CONFIG_HOME/kbiss` | `$XDG_CACHE_HOME/kbiss` |
| Windows | `%LOCALAPPDATA%\kbiss\state` and `%APPDATA%\kbiss` | `%LOCALAPPDATA%\kbiss\cache` |

Indexes are namespaced by opaque hashes of the canonical source root and all index/model schema
inputs. Model caches are namespaced by model identity. No database, model, manifest, log, or built
frontend cache is written into the KBISS repository or indexed repository; `dist/` is ignored build
output.

## Operations

| Command | Purpose |
| --- | --- |
| `bun run config` | Print the resolved root, model/index settings, and exact state paths. |
| `bun run doctor` | Check Bun/native target support, pinned dependencies, model integrity, and index compatibility. |
| `bun run version` | Print KBISS, Bun, platform/architecture, and important dependency versions. |
| `bun run reconcile` | Ask the running same-root app to scan for filesystem changes. |
| `bun run reindex` | Ask the running same-root app to re-evaluate committed files. |
| `bun run rebuild` | Preserve the selected current index, stage a fresh one, and print both exact paths. |
| `bun run reset` | Remove only the selected current root/model/schema index. |
| `bun run root <path>` | Validate and save a different default source root atomically. |
| `bun run model:setup` | Download/import, verify, and warm the selected model explicitly. |
| `bun run help` | Show command and option help. |

`reconcile` and `reindex` require `serve` to be running and use its same-origin action token. For a
corrupt/incompatible current index, stop the app, run `bun run rebuild`, then `bun run serve`.
Rebuild moves the previous index into the external `rebuild-backups` area before creating the fresh
target, so an interrupted rebuild remains recoverable. A schema/model/chunker upgrade naturally
selects a new namespace and leaves the old namespace usable until the new index is ready.

Reset/rebuild commands print their exact targets and prompt on an interactive terminal. Automation
must opt in with `--yes`; lack of confirmation removes nothing. Additional reset scopes are explicit:

```sh
# Remove every index-schema version for only the selected root.
bun run reset --all-index-versions

# Also remove the selected model cache (it may be shared by other roots using that model).
bun run reset --include-model
```

Every target is checked against the configured application state/cache parent immediately before
deletion. Broad paths, parent directories, unresolved paths, and symlink escapes are rejected.
Unrelated files are never selected.

## Supported content

First-class indexing covers Markdown/MDX, HTML, Python, JavaScript/TypeScript and JSX/TSX, JSON,
JSONC, YAML, TOML, XML, CSS and preprocessors, shell, SQL, CSV, text, and logs. Other files positively
detected as ordinary UTF-8 text use a safe fallback. Images/OCR, office documents, archives,
compiled binaries, and proprietary formats are not indexed.

Markdown diagrams fenced as `mermaid` render locally after sanitization. PlantUML/PUMl,
Graphviz/DOT, D2, Vega, and Vega-Lite fences remain labeled, copyable source; KBISS does not send
them to a remote renderer. Repository HTML is sanitized and shown in an empty-sandbox iframe.

## Troubleshooting

- **Root missing/unreadable:** run `bun run root /correct/path` or pass `--root`; KBISS never creates
  the source repository.
- **Model missing offline:** connect once and run `bun run model:setup`, or import a verified local
  bundle with `--asset-source`.
- **Model corrupt:** online `serve`/`model:setup` preserves the corrupt cache and reacquires it;
  offline mode asks for a verified bundle instead.
- **Index rebuild required:** stop KBISS, run `bun run doctor`, then `bun run rebuild` with the same
  root/configuration options and restart.
- **Busy ports:** KBISS searches 20 loopback ports and reports `PORT_UNAVAILABLE` if all are occupied.
- **Native load failure:** confirm `bun --version` is exactly 1.4.0 and inspect `bun run doctor`.
- **Browser did not open:** use the `http://127.0.0.1:<port>` URL printed by `serve`; the server stays
  usable when no desktop opener exists.

## Development checks

```sh
bun run lint
bun run typecheck
bun run test:coverage
bun run build
bun run test:e2e
bun run test:relevance
bun run release:gate
```

`bun run compat` is the explicit network-enabled native compatibility spike. Ordinary tests use
temporary roots/application-data and deterministic fake embeddings; they do not read or mutate a
developer repository. Real pinned-model smoke tests remain opt-in and require separately prepared,
verified caches; Plan 12 documents the per-profile cache variables and commands.

The opt-in large-corpus tools require explicit external paths and never write into the indexed or
KBISS repositories:

```sh
bun run benchmark:large --root /path/to/large-repo --output /external/reports/small.json
bun run benchmark:models --root /path/to/large-repo --output-dir /external/model-comparison
```

Pass `--allow-download` only when model acquisition is intended, and `--judgments` only for a local
reviewed judgment file that should remain outside version control. The benchmark records anonymized
performance-query labels in its report. See the final Plan 11 baseline and model decision in
[`docs/plan-11-testing-relevance-evaluation-and-benchmarking.md`](docs/plan-11-testing-relevance-evaluation-and-benchmarking.md).
