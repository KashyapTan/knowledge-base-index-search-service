# 01 - Project Foundation and Bun Compatibility

## Outcome

Create the minimum maintainable project foundation and prove that the native dependencies required by the architecture work under ordinary Bun execution before substantial implementation begins.

This phase is intentionally a compatibility and structure phase. It should not implement the production indexer, search UI, or viewer.

## Context

The project is greenfield and must use Bun end to end. LanceDB and ONNX Runtime use native Node-API/shared-library components, so their compatibility is more consequential than choosing a router or component library. Transformers.js has an official Bun embedding example, but single-executable Bun compilation is not a project requirement and should be avoided.

## Work

### Establish the repository structure

Create a single Bun/TypeScript workspace with clear module boundaries, such as:

```text
src/
  server/
  config/
  discovery/
  extraction/
  indexing/
  search/
  shared/
  ui/
```

Use one package unless a concrete build limitation justifies workspaces. Configure strict TypeScript, consistent formatting/linting, Vite for the React frontend, and Bun-native scripts. Pin the supported Bun version or version range in project metadata and documentation.

Define scripts conceptually for development, building, serving, typechecking, and later tests. `bun run serve` is the teammate-facing command; it may be skeletal in this phase.

### Prove the critical runtime path

Build a disposable compatibility spike that verifies, under `bun run`:

1. `@lancedb/lancedb` can create/open a database in a temporary directory.
2. A table can accept and retrieve a tiny vector record.
3. Transformers.js can load a quantized BGE small ONNX model and produce a normalized embedding.
4. The resulting vector has the expected dimension.
5. Bun can run the embedding operation without blocking the intended server architecture irreparably.
6. `Bun.serve()` can expose a trivial health route and serve a compiled Vite asset.

Delete temporary compatibility data after the check. Do not place test databases or model caches in the repository.

### Choose the concurrency boundary

Validate Bun Workers for the embedding path. Bun documents Workers as experimental, so record any limitations discovered. If Workers are unstable with the selected Transformers.js/ONNX version, choose a Bun child-process worker with a small typed message protocol instead. Keep inference outside the request-handling event loop either way.

### Pin proven dependency versions

Once the spike works, lock the exact compatible versions of Bun-facing native dependencies. Document supported operating systems/architectures based on the team's real environment. Avoid Alpine/musl assumptions unless it is an actual team target.

Do not use `bun build --compile`; normal source execution is the supported delivery mechanism.

## Contracts to leave for later phases

- Canonical project directory layout.
- Shared TypeScript conventions and error/result pattern.
- Confirmed LanceDB import/connection approach.
- Confirmed Transformers.js model-loading approach.
- Confirmed worker or subprocess message boundary.
- Confirmed frontend production-asset serving approach.

## Acceptance criteria

- A fresh dependency installation succeeds using Bun.
- TypeScript is strict and the foundational scripts execute through Bun.
- LanceDB, BGE-small embedding, Bun HTTP serving, and the chosen worker boundary have each been exercised successfully.
- Compatibility results and pinned versions are documented.
- No production indexing/search/viewer functionality has been prematurely implemented.
- No persistent runtime data is written into the Git worktree.

## Handoff

Plan 02 uses the proven imports and runtime boundaries to implement durable configuration, startup state, and local storage resolution.

