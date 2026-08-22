# Plan 2 runtime configuration and local-state contract

Plan 2 gives later subsystems one validated `AppConfig`. Scanner, indexer, search, and UI lifecycle
code must receive this object or one of its typed children; they must not read process arguments,
environment variables, or platform paths independently.

## Configuration precedence

Values are selected in this fixed order:

1. Explicit command-line options.
2. `KBISS_*` environment variables.
3. The per-user JSON configuration file.
4. Built-in defaults.

The sources map as follows:

| Setting | Command line | Environment | JSON key | Default |
| --- | --- | --- | --- | --- |
| Source root | `--root` | `KBISS_ROOT` | `root` | `~/dev/card-gateway-artifacts` |
| Preferred port | `--port` | `KBISS_PORT` | `port` | `3210` |
| Model ID | `--model` | `KBISS_MODEL_ID` | `modelId` | `Xenova/bge-small-en-v1.5` |
| Quantization | `--quantization` | `KBISS_QUANTIZATION` | `quantization` | `q8` |
| Vector dimensions | `--vector-dimension` | `KBISS_VECTOR_DIMENSION` | `vectorDimension` | `384` |
| Normalization | `--normalization` | `KBISS_NORMALIZATION` | `normalization` | `l2` |
| Offline model policy | `--offline[=true|false]` | `KBISS_OFFLINE` | `offline` | `false` |
| State directory | `--state-dir` | `KBISS_STATE_DIR` | `stateDir` | OS-specific |
| Cache directory | `--cache-dir` | `KBISS_CACHE_DIR` | `cacheDir` | OS-specific |
| Discovery ignores | n/a | n/a | `ignorePatterns` | Cross-language generated/dependency defaults |
| Config file | `--config` | `KBISS_CONFIG_FILE` | n/a | OS-specific |

Options accept either `--name value` or `--name=value`. An explicitly selected config file must
exist and contain a JSON object with only documented keys. A missing default config file is normal.
Unknown CLI options, unknown JSON keys, unsupported quantization values, non-positive vector
dimensions, non-`l2` normalization, and ports outside 1-65535 produce structured display-safe
errors. The loader does not mutate its arguments or environment.

The config file defaults are:

| OS | Config file |
| --- | --- |
| macOS | `~/Library/Application Support/kbiss/config.json` |
| Linux/Unix | `${XDG_CONFIG_HOME:-~/.config}/kbiss/config.json` |
| Windows | `%APPDATA%/kbiss/config.json` |

Example:

```json
{
  "root": "~/dev/card-gateway-artifacts",
  "port": 3210,
  "modelId": "Xenova/bge-small-en-v1.5",
  "quantization": "q8",
  "vectorDimension": 384,
  "ignorePatterns": ["node_modules/", ".venv/", "dist/", "build/"]
}
```

`ignorePatterns` is an optional root-relative glob array. When absent, KBISS uses its complete
cross-language default list; when present, the array replaces that list, and `[]` disables every
configurable default. Empty, absolute, parent-traversing, oversized, or non-string rules are
rejected. `.git` and the resolved KBISS state/cache paths remain unconditional exclusions.

`~` is expanded with the operating-system home-directory API. Relative paths resolve against the
startup working directory. The source root is then resolved with `realpath`, checked to be a
readable/searchable directory, and assigned an opaque SHA-256 identity. The loader never creates
the source root. `sourceRoots` is a one-element tuple in Plan 2 so later multi-root support can be
added without changing persisted file IDs or the API shape.

## External local-state layout

The default state and cache roots are:

| OS | State | Cache |
| --- | --- | --- |
| macOS | `~/Library/Application Support/kbiss` | `~/Library/Caches/kbiss` |
| Linux/Unix | `${XDG_STATE_HOME:-~/.local/state}/kbiss` | `${XDG_CACHE_HOME:-~/.cache}/kbiss` |
| Windows | `%LOCALAPPDATA%/kbiss/state` | `%LOCALAPPDATA%/kbiss/cache` |

The resolved layout is:

```text
state/
  indexes/<root-namespace>/<index-namespace>/
    lancedb/
    metadata/compatibility.json
  logs/
cache/
  models/<model-namespace>/
```

All namespace segments are truncated SHA-256 hashes; absolute source paths are not exposed as
filenames or written to compatibility metadata. The root namespace depends on the canonical-root
identity. The index namespace depends on root identity plus every index-affecting model, schema,
extractor, and chunker input. The model namespace depends only on embedding configuration so local
assets can be reused safely across source roots. Consequently, separate application clones reuse
an index only when they resolve the same root and compatible index configuration.

Before creating directories, prospective paths are canonicalized through their nearest existing
ancestor so symlinked parents cannot redirect generated data into the source or project repository.
State/cache paths inside either repository are rejected.

## Compatibility descriptor

`IndexCompatibility` persists only compatibility inputs:

- descriptor and application versions;
- index schema version;
- embedding model ID, quantization, vector dimension, and `l2` normalization;
- extractor and chunker versions;
- chunk-size and overlap policy;
- opaque canonical-root identity.

`writeCompatibilityMetadata` writes a mode-`0600` temporary file and atomically renames it.
Indexing code must write it only after establishing a usable matching index; configuration startup
does not claim compatibility merely because it created empty directories.

Startup classification is deterministic:

| Status | Meaning |
| --- | --- |
| `compatible` | Every persisted field matches. Database use may proceed. |
| `migration-required` | Only application/descriptor metadata versions differ; index data inputs match. |
| `rebuild-required` | Metadata is absent or any root/model/vector/schema/extractor/chunker input differs. |
| `corrupt` | JSON is malformed, incomplete, or internally invalid. Do not open the index as compatible. |

An unreadable metadata file is a structured startup error rather than a corrupt classification.
This boundary ensures LanceDB vector-dimension and schema mismatches are detected before database
access.

## Startup and port contracts

`StartupState` and `StartupStateStore` expose the ordered lifecycle:

```text
starting -> validating -> loading_model -> scanning -> indexing -> ready
                                      scanning/indexing/ready -> degraded
                                      any nonfatal phase -> error
```

Per-file errors enter `degraded` with a recorded resume phase and remain separate from fatal
startup errors. Invalid or out-of-order transitions return `INVALID_STARTUP_TRANSITION`; listeners
observe successful transitions only.

The HTTP listener is fixed to `127.0.0.1`. Port selection probes the preferred port and up to 19
successive ports. A busy port is skipped; unexpected bind failures and exhausted ranges return
structured errors. No code path falls back to `0.0.0.0` or another network interface.

## Plan 3 handoff

Plan 3 should import contracts from `src/config/index.ts`, use `AppConfig.sourceRoots[0]` for the
canonical root and opaque root identity, keep all manifest data under `ResolvedPaths.indexMetadataDir`,
and report scanner state through `StartupStateStore`. Stable file IDs should combine the opaque root
identity with normalized root-relative paths, never absolute paths. Per-file discovery failures
should use `file_error`; fatal root/configuration failures should use `fatal_error`.
