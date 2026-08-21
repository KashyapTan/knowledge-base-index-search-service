# 07 - Local API, Lifecycle, Progress, and Security

## Outcome

Expose indexing, search, and file-viewing capabilities through one robust loopback-only Bun server, with typed validation, progress streaming, safe path handling, and graceful lifecycle behavior.

## Dependencies

Complete Plans 01-06. The API must call existing services rather than duplicating discovery, database, embedding, or ranking logic.

## Work

### Bun server and routes

Use `Bun.serve()` with explicit routes. Define a small versioned API surface for:

- Application health and version.
- Startup/indexing status.
- Server-Sent Events for progress and state changes.
- Search requests.
- File metadata and full-file content by opaque/stable file ID.
- A controlled manual rescan/reindex action.
- Optional reveal/copy-path metadata if approved and safely implemented.

Serve the production Vite assets from the same origin. Provide SPA fallback without swallowing `/api` errors.

### Startup behavior

Start the loopback server as early as safely possible, then initialize model/index services and begin reconciliation in the background. Open the browser once the server can render a useful loading/error page, not only after a large initial index finishes.

Ensure only one browser-open action occurs per launch. If another compatible instance already owns the configured root/port, focus or report that instance rather than starting competing writers.

### Validation and errors

Validate query sizes, result limits, file IDs, filters, and action bodies. Return structured error codes/messages appropriate for UI display without leaking stack traces or arbitrary local paths.

Propagate request cancellation into search where possible. Rate limits need not target hostile multi-user traffic, but bound expensive input and concurrent searches.

### Safe file access

For each file request:

1. Resolve the ID from trusted indexed metadata.
2. Canonicalize the current path.
3. Verify it remains inside the configured root.
4. Recheck type/size as appropriate.
5. Read with bounded memory or stream when large.

Never accept an arbitrary absolute path from the browser. Treat symlink changes after indexing as untrusted.

### Localhost security

- Bind only to `127.0.0.1` by default.
- Accept only expected localhost Host headers/selected port.
- Do not enable permissive CORS.
- Use restrictive security headers for the main UI.
- Give sandboxed HTML preview content a stricter, isolated content security policy.
- Protect state-changing local actions against cross-origin requests.
- Avoid logging sensitive queries or file contents.

### Lifecycle

Handle termination signals and graceful shutdown: stop watching, stop accepting new indexing work, finish or checkpoint safe writes, close workers, and release LanceDB handles.

## Testing requirements

Start the real Bun server on an ephemeral loopback port for API integration tests. Cover route/method validation, structured errors, status transitions, SSE connection/reconnection and event ordering, search cancellation, file streaming, SPA fallback, manual reconciliation, startup failures, concurrent-instance behavior, and graceful shutdown with in-flight work.

Treat security tests as mandatory branches: forged IDs, traversal encodings, null bytes, oversized inputs, symlink swaps, files deleted between lookup and read, unexpected Host headers, cross-origin requests, state-changing request protection, unsafe content types, and stack/path leakage. Do not mock filesystem canonicalization in the tests intended to validate containment.

Target approximately 93% line and function coverage for non-trivial routing, validation, lifecycle, SSE, error mapping, and security code. Every path-containment and cross-origin decision branch should be explicitly tested even if overall coverage already exceeds the target. Run coverage, typecheck, lint, build, and existing checks before handoff.

## Acceptance criteria

- One Bun process serves the API and built frontend on loopback only.
- The browser can observe startup/index progress without polling aggressively.
- Search and file reads use validated typed contracts.
- Traversal strings, forged IDs, and symlink escapes cannot read outside the root.
- Unexpected Host/CORS access is rejected.
- Shutdown leaves a recoverable index.
- Initial indexing does not delay access to the progress/error UI.
- API and security tests pass at or near 93% meaningful coverage for the non-trivial code added here.

## Handoff

Plan 08 builds the primary React search experience against these stable API contracts.

## Completion notes (2026-08-21)

- Replaced the foundation server with one versioned `/api/v1` Bun API for health/version, startup
  status, replayable SSE progress, cancellable search, opaque-ID file metadata/content, and
  CSRF-protected reconciliation/reindex actions. Production Vite assets share the origin, while
  unknown API paths remain structured JSON errors instead of falling through to the SPA.
  The minimal React lifecycle page now renders loading, indexing counts, isolated issues, fatal
  startup errors, and SSE reconnection state while Plan 08 remains responsible for search UI.
- Added an explicit application runtime that starts HTTP before model/index initialization, composes
  the existing discovery/extraction/indexing/search services, shares one offline embedding provider,
  serializes initial/watcher/manual index work, and keeps display-safe startup failures observable.
  The discovery watcher gained a narrow `scanInitially: false` option so this runtime can index one
  authoritative initial scan without immediately repeating it.
- Added compatible-instance discovery across the full configured 20-port fallback range. Matching
  service version plus opaque root identity reuses the running URL rather than opening a competing
  writer. The CLI opens the browser exactly once per launch after HTTP is useful; desktop/signal
  glue is isolated in `src/server/cli.ts`.
- Added bounded 32 KiB JSON parsing, strict body shapes/methods/content types, Plan 6 value validation,
  four-search concurrency control, request/shutdown cancellation, structured HTTP error mapping,
  and no default query/content/excerpt logging.
- Added a bounded SSE replay hub with monotonic IDs, 128 retained events, safe `Last-Event-ID`
  handling, full snapshots for absent/stale cursors, ordered startup/discovery/indexing/issue data,
  and comment heartbeats that do not change event order.
- Added opaque-ID file access with trusted manifest lookup, root-identity and lexical checks, live
  canonicalization, file-handle open plus post-open canonical recheck, regular-file/64 MiB bounds,
  64 KiB streaming, cancellation cleanup, and forced `text/plain`/`nosniff` responses. Traversal,
  forged IDs, null bytes, out-of-root symlinks, symlink swaps, deletion races, directories, and
  oversized files all fail safely.
- Enforced exact localhost Host/selected-port checks, same-origin `Origin`/Fetch Metadata checks, no
  permissive CORS, a same-origin CSRF token for state changes, and default-deny CSP plus restrictive
  browser headers. Unexpected exceptions return generic errors without stacks or arbitrary paths.
- Added 31 focused Plan 7 tests using real ephemeral Bun servers and real temporary filesystem
  canonicalization. The complete default suite passes with 275 tests and one opt-in local-model
  smoke test skipped, reporting 99.50% line and 98.93% function coverage overall. Routing,
  validation, SSE, file access, and security report 100% line/function coverage; lifecycle reports
  97.32% line and 92.11% function coverage, with only the real tokenizer asset-loader function left
  to the existing opt-in local-model path. Lint, strict typecheck, and the production Vite build pass.
- The stable routes, event format, security/file boundary, lifecycle ownership, and Plan 08/09
  guidance are recorded in `docs/plan-07-local-api-lifecycle-security.md`.
