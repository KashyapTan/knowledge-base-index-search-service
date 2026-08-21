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

## Acceptance criteria

- A teammate can go from a clean clone to a usable browser app with documented Bun commands.
- After model acquisition, indexing and search operate without network access.
- Production UI assets are served by the same loopback Bun process.
- Root-specific reset/rebuild commands cannot delete unrelated user data.
- Updates detect incompatible indexes and recover with actionable messaging.
- No database/model/generated frontend cache dirties the source or application repositories.
- Documentation accurately reflects supported platforms, paths, formats, and privacy behavior.

## Handoff

Plan 11 is the final phase. It validates correctness, security, relevance, and performance against fixtures and the user-designated large external repository, then makes the evidence-based small-versus-base embedding decision.

