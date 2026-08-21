# 02 - Runtime Configuration and Local State

## Outcome

Define how the application finds the artifact repository, selects a port/model, stores local state, reports startup problems, and versions its index. Later components must consume one validated configuration object rather than reading environment variables or paths independently.

## Dependencies

Complete Plan 01 and reuse its confirmed Bun, LanceDB, Transformers.js, and worker integration choices.

## Work

### Configuration precedence

Implement and document a deterministic precedence order:

1. Explicit command-line options such as `--root` and `--port`.
2. Project-specific environment variables.
3. A per-user application configuration file, if included.
4. Safe defaults.

The default source root is `~/dev/card-gateway-artifacts`. Resolve the home directory through the operating system, canonicalize the result, and produce a useful error state if the directory is missing or unreadable. Do not silently create the source directory.

Support a single root for the first release while shaping configuration so multiple roots could be added later without changing persisted IDs or API contracts.

### Local state layout

Resolve an OS-appropriate per-user state/cache directory outside the project and source repositories. Define separate locations for:

- LanceDB data.
- Model cache/assets.
- Lightweight application metadata.
- Optional diagnostic logs.

Namespace each index by a stable hash of the canonical root. Do not expose the absolute path in filenames. Ensure multiple clones of this application point to the same local index only when their root, model, and schema configuration are compatible.

### Index compatibility metadata

Define one persisted compatibility descriptor containing at least:

- Application/index schema version.
- Embedding model ID and quantization.
- Vector dimension and normalization policy.
- Extractor/chunker version.
- Chunk size and overlap policy.
- Canonical root identity.

On startup, classify existing state as compatible, migration-required, rebuild-required, or corrupt. Do not let LanceDB dimension/schema mismatches surface as obscure runtime errors.

### Startup state machine

Define explicit states such as:

```text
starting -> validating -> loading_model -> scanning -> indexing -> ready
                                      \-> degraded
                                      \-> error
```

The HTTP server should eventually be able to start before indexing completes, so these states must be observable by the UI. Separate fatal configuration errors from per-file indexing errors.

### Port and process behavior

Bind to `127.0.0.1`. Select a stable default port and define behavior for a busy port: either locate an available loopback port or identify an already-running compatible instance. Never bind to all network interfaces as an automatic fallback.

## Data contracts

Leave typed definitions for:

- `AppConfig`
- `ResolvedPaths`
- `IndexCompatibility`
- `StartupState`
- Structured startup/configuration errors safe to display in the UI

These contracts must not import UI-specific types.

## Testing requirements

Add deterministic Bun tests in this phase rather than deferring configuration coverage to Plan 11. Cover configuration precedence, CLI/environment restoration, home-directory expansion, canonicalization, root overrides, default selection, state-directory resolution, stable namespace hashing, model/schema compatibility classification, missing or unreadable roots, corrupt metadata, and occupied-port behavior.

Use isolated temporary home/state/root directories and restore all mutated environment and process state after each test. Include table-driven tests across supported path shapes and operating-system abstractions without hardcoding one developer's machine. Exercise any persisted compatibility descriptor with real temporary files, not only mocks.

Target approximately 93% line and function coverage for the non-trivial configuration, path, compatibility, and startup-state code introduced by this plan, with direct coverage of all security- or rebuild-relevant branches. Generated types and trivial entrypoint wiring may be narrowly excluded with justification. Run the coverage suite, typecheck, lint, and existing checks before handoff.

## Acceptance criteria

- Default and overridden roots resolve consistently across supported operating systems.
- All generated state is outside both Git repositories.
- The same root/configuration produces the same index namespace.
- Model or vector-dimension changes are detected before database use.
- Missing/unreadable roots and port conflicts produce actionable structured errors.
- The server remains loopback-only.
- Phase-specific tests pass and the non-trivial code added here is at or near the project's 93% coverage target without artificial coverage padding.

## Handoff

Plan 03 consumes `AppConfig`, `ResolvedPaths`, and startup-state reporting to discover files and maintain a change manifest.
