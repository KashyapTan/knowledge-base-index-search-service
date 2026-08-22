# 10 - Local Distribution, Operations, and Polish

## Outcome

Make the completed application dependable for teammates to clone, install, start, stop, update, diagnose, and rebuild without understanding LanceDB or embedding internals.

## Dependencies

Complete Plans 01-09. This plan integrates and operationalizes existing features; it must not redesign search or rendering without documenting the contract change.

## Work

### Teammate workflow

Deliver and document the primary flow:

```text
bun install
bun run serve
```

`bun run serve` should build or reuse production frontend assets, start the loopback server, open the browser once, validate the source root, prepare the model/index, reconcile changes, and remain active until interrupted.

Keep `bun run dev` separate for contributors. Do not require global CLIs beyond Bun and ordinary operating-system facilities.

### Local model setup

Choose and document a deterministic model acquisition policy. The practical default may download the pinned quantized model once during setup/first run, verify it, cache it in local application data, and then disable remote loading. Provide clear progress, retry, offline, and corruption messages.

If the team requires air-gapped first execution, support a documented pre-bundled model-assets path. Do not silently fall back to a remote inference API.

### Production asset handling

Build Vite assets reproducibly and serve them from Bun with correct content types, caching, and SPA fallback. Keep runtime assets local. Avoid `bun build --compile` until native Transformers.js/ONNX packaging is demonstrably reliable across team platforms.

### Operational commands

Provide safe, explicit operations for:

- Showing resolved configuration and state paths.
- Triggering a reconciliation scan.
- Rebuilding an incompatible/corrupt index.
- Clearing only this application's selected root-specific index/cache.
- Selecting a different configured root.
- Printing version and diagnostic dependency information.

Destructive commands must identify their exact target, request confirmation when interactive, and never accept broad unresolved paths.

### Updates and compatibility

Handle application upgrades with explicit schema compatibility checks. Preserve a usable old index until a replacement is ready when practical. Provide clear messaging for model or chunker changes that require re-indexing.

Pin dependencies and commit the Bun lockfile. Document known native-platform limitations and the supported Bun version.

### Product polish

Review startup messages, progress estimates, browser titles/icons, empty states, error recovery, indexing diagnostics, copy-path behavior, dark/light presentation, accessibility, and responsiveness as one coherent product.

Write a concise README covering purpose, privacy model, prerequisites, installation, `serve`, root overrides, local storage, supported formats, troubleshooting, and safe reset/reindex behavior.

## Testing requirements

Add process-level tests around argument handling, root overrides, model setup states, browser-open-once behavior, production asset serving, diagnostics, schema-upgrade decisions, and exact reset/rebuild targets. Use temporary application-data and source roots so operational tests can prove that no command writes to or deletes unrelated paths.

Create clean-environment smoke workflows for `bun install`, the production build, `bun run serve`, first model setup with a controlled local asset source, and a fully offline restart using the populated cache. Exercise missing/corrupt model recovery, busy ports, incompatible indexes, interrupted rebuilds, and supported platform/architecture checks. Do not require or mutate a developer's real artifact repository.

Target approximately 93% line and function coverage for non-trivial setup, operational-command, migration, reset, asset-serving, and lifecycle orchestration code. Minimal command entrypoints and static assets may be excluded narrowly while their observable behavior remains covered by process tests. Run the complete coverage suite, typecheck, lint, production build, and all existing checks before handoff.

## Acceptance criteria

- A teammate can go from a clean clone to a usable browser app with documented Bun commands.
- After model acquisition, indexing and search operate without network access.
- Production UI assets are served by the same loopback Bun process.
- Root-specific reset/rebuild commands cannot delete unrelated user data.
- Updates detect incompatible indexes and recover with actionable messaging.
- No database/model/generated frontend cache dirties the source or application repositories.
- Documentation accurately reflects supported platforms, paths, formats, and privacy behavior.
- Operational and distribution tests pass, and suite coverage remains at or near 93% for non-trivial, testable code.

## Handoff

Plan 11 is the final phase of the original release. It validates correctness, security, relevance,
and performance against fixtures and the user-designated large external repository, then makes the
original evidence-based small-versus-base embedding decision. Plans 12-14 are later post-release
model-runtime, throughput, and mixed-format relevance phases.

## Completion notes (2026-08-21)

- Made `bun install` plus `bun run serve` the complete online teammate flow. Launch still exposes the
  loading UI before long initialization and opens the browser once, but now performs local-first
  model verification, two-attempt pinned acquisition when assets are absent, corruption quarantine,
  reconciliation, watching, and actionable graceful-start/stop console reporting. Added explicit
  `--offline`/`KBISS_OFFLINE`/user-config policy with tested precedence.
- Added deterministic model setup states and progress, retry bounds, integrity inspection, preserved
  `.corrupt-*` caches, and verified air-gapped imports. Imports require a complete checksum manifest,
  reject symlinks and overlapping paths, stage through a sibling directory, and preserve the prior
  managed cache. A controlled clean-environment smoke proves first preparation, portable import, and
  a fully offline restart without network or developer repositories.
- Added teammate operations for resolved config/paths, dependency/platform diagnostics, version,
  running-process reconcile/reindex, atomic default-root selection, preserved index rebuild, and
  exact-scope reset. Reset/rebuild print targets, prompt interactively, require `--yes` in automation,
  reject broad/equal/unresolved/symlink-escaped targets, and leave unrelated fixture sentinels intact.
  Rebuild moves the old namespace to external backups before creating the fresh resumable target.
- Completed production asset behavior with Bun-derived content types, immutable caching only for
  hashed Vite assets, revalidation for ordinary local assets, no-cache HTML/SPA fallback, and
  unchanged `no-store` API behavior. Added a local SVG icon, descriptive title/metadata, theme colors,
  and coherent startup/diagnostic copy while preserving Plan 8/9 accessibility and security contracts.
- Rewrote the README around privacy, the two-command flow, offline/air-gapped setup, root overrides,
  OS-specific storage, supported formats and diagram fallbacks, safe operations, native-platform
  limitations, and troubleshooting. Recorded the Plan 10 contract and updated superseded Plan 2/5/7
  configuration/model-lifecycle notes. CI now runs the controlled operations smoke and production
  build after a frozen install.
- Added process, filesystem, HTTP, configuration, lifecycle, setup, corruption, interrupted rebuild,
  busy-instance, asset-cache, and safety regression coverage. The complete default suite passes 330
  tests with one existing opt-in local-assets test skipped and reports 99.45% line / 98.71% function
  coverage overall. Plan 10 CLI is 99.47% line / 100% function, operations core is 97.01% / 94.44%,
  and model-asset logic is 100% / 95%.
- Frozen install, strict typecheck, Biome lint, production Vite build, controlled setup/offline smoke,
  Playwright's real API/UI path, and the disposable native compatibility check all pass. The latter
  revalidated LanceDB, loopback production assets, Bun Workers, and q8 BGE-small 384-dimensional
  normalized embeddings on Bun 1.4.0/macOS arm64 without leaving model or database data behind.
