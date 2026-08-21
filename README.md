# Knowledge Base Index Search Service

KBISS is a local-only search application for the `card-gateway-artifacts` repository. This
repository currently contains the Plan 1 foundation: a Bun server, a compiled React/Vite shell,
shared TypeScript conventions, and a disposable native-runtime compatibility check. Production
indexing and search intentionally begin in later plans.

## Requirements

- Bun 1.4.0 (pinned in `.bun-version` and `package.json`)
- A platform supported by the pinned native packages; Plan 1 is verified on macOS arm64
- Internet access for the first compatibility run, which downloads the public BGE model into a
  temporary directory and removes it when the check ends

## Install and run

```sh
bun install --frozen-lockfile
bun run compat
bun run serve
```

`bun run serve` builds the UI and starts a skeletal loopback server at
`http://127.0.0.1:3210`. It does not yet open the browser or index a repository; those lifecycle
features belong to later plans.

## Scripts

| Command | Purpose |
| --- | --- |
| `bun run dev` | Build the UI once, then run the foundation server with Bun hot reload. |
| `bun run build` | Build the Vite asset and run strict TypeScript checks. |
| `bun run serve` | Build and serve the production UI asset on loopback. |
| `bun run typecheck` | Run strict TypeScript without emitting JavaScript. |
| `bun run lint` | Check formatting and lint rules with Biome. |
| `bun run format` | Apply the repository formatter. |
| `bun test` | Run focused Bun tests. |
| `bun run compat` | Exercise LanceDB, BGE inference, Bun Workers, HTTP, and Vite together. |

## Module boundaries

```text
src/
  server/       Bun HTTP lifecycle and API (foundation route only in Plan 1)
  config/       validated runtime configuration (Plan 2)
  discovery/    source scanning and watching (Plan 3)
  extraction/   text extraction and chunking (Plan 4)
  indexing/     embedding worker boundary and later persistence pipeline
  search/       hybrid retrieval and aggregation (Plan 6)
  shared/       environment-independent contracts and result/error conventions
  ui/           React/Vite browser application
```

The project uses tagged `Result<T, AppError>` values for expected failures at module boundaries.
Thrown exceptions remain appropriate for programmer errors and unrecoverable startup failures;
later plans should translate displayable failures into structured `AppError` values.

See [Plan 1 compatibility notes](docs/plan-01-compatibility.md) for pinned native imports,
worker protocol details, and the verified support matrix.
