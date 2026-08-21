# Plan 7 local API, lifecycle, progress, and security contract

Plan 7 composes Plans 02-06 behind one loopback-only `Bun.serve()` process. The public server API is
exported from `src/server/index.ts`; `src/server/cli.ts` is deliberately limited to desktop opening,
console output, and signal registration.

## Launch and ownership

`startApplication()` validates configuration, probes the configured 20-port loopback range for a
compatible KBISS instance, selects a free port when needed, and starts HTTP before model/index
initialization. A compatible instance must match service name, application version, and opaque root
identity. This includes instances that previously selected a fallback port, preventing competing
writers over one root/index namespace.

The returned started application owns a `ready` promise and idempotent `shutdown()`. The lifecycle
uses one shared local-first embedding provider for document and query work, one Lance index store, one
search retriever, the discovery service, and serialized indexing. Startup follows
`loading_model -> scanning -> indexing -> ready`; display-safe failures remain observable through
the status API while the UI server stays available.

The shared provider is local-first. Plan 10 permits a missing pinned model to be acquired during an
online first launch, while explicit offline configuration keeps the original no-network startup
boundary. In both cases inference begins only after local integrity preparation and the worker has
disabled remote loading.

The initial scan is explicit and indexed before the watcher starts without a duplicate initial
scan. Later manifest changes and manual work are serialized through one indexing tail. Shutdown
stops the watcher, refuses new work, aborts queued/in-flight embedding/search/indexing work at safe
boundaries, waits for active operations, closes the retriever/store, shuts down the Worker, closes
SSE streams, and then stops Bun HTTP. `SIGINT` and `SIGTERM` call this path once.

## Versioned same-origin API

All Plan 08 clients should use `/api/v1`:

| Method | Route | Contract |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Service/version, opaque root identity, and current startup phase. |
| `GET` | `/api/v1/status` | Startup, latest discovery/indexing progress, availability, action state, and same-origin CSRF token. |
| `GET` | `/api/v1/events` | SSE snapshots and ordered `startup`, `discovery`, `indexing`, and `issue` events. |
| `POST` | `/api/v1/search` | Plan 6 `SearchRequest` to `SearchResponse`; request cancellation reaches search. |
| `GET` | `/api/v1/files/:fileId` | Current display-safe metadata resolved through the trusted manifest. |
| `GET` | `/api/v1/files/:fileId/content` | Bounded, streamed current bytes with `text/plain` plus `nosniff`. |
| `POST` | `/api/v1/actions/reconcile` | CSRF-protected `{mode:"reconcile"|"reindex"}` operation. |

`/api/health` remains only as the Plan 1 compatibility alias. Unknown `/api` paths always return a
structured JSON 404 and never fall through to the SPA. Known routes return 405 plus `Allow` for the
wrong method.

JSON bodies must use `application/json` and are streamed through a 32 KiB bound before parsing.
Search shapes permit only `query`, `fileCount`, and `formats`; Plan 6 remains authoritative for
query/filter/count value validation. Only lowercase 64-character SHA-256 file IDs cross the file
boundary. Errors have `{error:{code,message}}`; arbitrary exception strings, stacks, queries,
excerpts, and absolute filesystem paths are not logged or returned.

At most four searches run concurrently by default. Excess work receives `SEARCH_BUSY`/429. Each
request has its own abort controller joined to shutdown and the HTTP request signal.

## SSE contract

Every data event has a monotonically increasing integer `id`, a named SSE `event`, and JSON `data`.
The server retains 128 recent events. A valid `Last-Event-ID` replays newer retained events in order;
an absent, malformed, unsafe, or stale cursor receives a complete `snapshot`. Idle connections get
comment heartbeats that do not advance event order. Events contain counts and display-safe file
issues, never contents or search queries.

## File access and containment

The browser supplies only an opaque file ID. `SafeFileAccess` resolves its trusted manifest record,
checks root identity and lexical containment, canonicalizes the live path, rejects an out-of-root
target, opens the canonical target by file handle, and then re-canonicalizes the source path. A
symlink swap therefore fails while an already-open handle cannot be redirected outside the root.

The open handle is re-statted as a regular file. Content is limited to 64 MiB and pulled in 64 KiB
chunks; cancellation closes the handle. The stream is limited to the size observed by `fstat`, so a
concurrent growth cannot exceed the memory/read bound. Deletions, directories, oversized files,
traversal records, forged IDs, null bytes, and symlink escapes have distinct safe responses.

Repository content is always served as `text/plain; charset=utf-8` in Plan 7, regardless of source
extension. Plan 9 owns sanitized Markdown rendering and isolated HTML previews.

## Browser security

The server binds only to `127.0.0.1`. Every request must use `127.0.0.1`, `localhost`, or `[::1]`
with the selected port in `Host`. An `Origin`, when present, must be the corresponding same-origin
HTTP origin; browser `Sec-Fetch-Site: cross-site` requests without an Origin are also rejected.
No permissive CORS headers or preflight endpoint exist.

All responses use `nosniff`, `DENY`/`frame-ancestors 'none'`, `same-origin` opener isolation, no
referrer, and a default-deny CSP for app assets. The manual action additionally requires the
unpredictable `X-KBISS-CSRF` token exposed by same-origin status/SSE state. A hostile origin cannot
read that token because API responses are not CORS-readable.

## Plan 8 handoff

Plan 8 should render status immediately, connect one `EventSource` to `/api/v1/events`, and use the
status CSRF token for manual actions. Search submissions should abort the prior request and ignore
stale responses. Result scores are ordering values, not percentages. Plan 8 must not accept local
paths or bypass the opaque file-ID routes; Plan 9 should fetch raw content from the content route and
apply renderer-specific sanitization in the browser.
