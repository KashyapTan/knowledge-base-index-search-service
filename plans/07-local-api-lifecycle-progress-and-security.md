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
