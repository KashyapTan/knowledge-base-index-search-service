# Plan 8 React search experience contract

Plan 8 replaces the lifecycle placeholder with the primary React search application. The browser
continues to use only the same-origin `/api/v1` boundary from Plan 7; repository content, queries,
and excerpts are never sent to an external service.

## Application and API boundary

`src/ui/api.ts` is the browser adapter for the shared server and search contracts. Components do
not redefine response shapes. It loads `/api/v1/status`, keeps one `EventSource` connected to
`/api/v1/events`, posts typed requests to `/api/v1/search`, and resolves deep-linked selections
through opaque IDs at `/api/v1/files/:fileId`.

`ApplicationStatus` now includes `sourceRootLabel`. The runtime derives this value from only the
configured root basename; an absolute local path never crosses the API boundary. File content and
file access still require the opaque SHA-256 ID routes established in Plan 7.

The runtime publishes a fresh full snapshot immediately after its owned services become available.
This closes the race where an early status request and SSE snapshot both observed model loading and
later phase-only events could otherwise leave the browser's `searchAvailable` bit stale.

The status UI distinguishes connecting, validation, model loading, scanning, indexing, ready,
degraded, fatal, reconnection, and shutdown states. Active indexing is considered partial even
after initial readiness, so committed content remains searchable with an explicit incomplete-results
notice. File-level startup/indexing failures are deduplicated in a collapsed diagnostics region.

## Search coordination and presentation

`useSearch` owns one request generation and `AbortController` at a time. Ordinary input is debounced
for 250 ms; Enter and the Search button submit immediately. Each newer query, cleared query,
disabled search service, or unmount aborts older work. A monotonically increasing generation check
also prevents a backend that resolves after cancellation from publishing stale results.

The hook preserves the exact input string for the server, including casing, whitespace,
punctuation, quotes, slashes, and identifiers. A useful prior response remains visible while a
new request is loading or if a refresh fails. Idle, initial loading, refreshing, no-result, error,
and partial-index states have distinct copy and live-region behavior.

Each card is one `SearchFileResult`, never one raw chunk. It shows the filename, root-relative path,
format, strongest excerpt, line/heading/symbol context, literal server-approved highlights, and up
to two collapsed supplemental excerpts. Ordering scores remain internal. Arrow keys plus Home/End
move among the distinct-file actions; `/` and Command/Ctrl-K refocus the primary search input.

## URL and viewer-host contract

Submitted query and count state use `q` and `n` query parameters with `history.replaceState`, so
typing does not create a history entry for every character. This makes refresh and sharing useful,
but the current localhost URL—and therefore potentially browser history or a copied URL—contains
the submitted query. This contract and the README document the tradeoff without repeating product
copy in the compact main search surface. No URL state is sent remotely by KBISS.

Opening a result pushes `file=<opaque-id>` and an optional one-based `line` parameter. Back restores
the prior selection predictably. A refreshed deep link resolves display metadata through the safe
opaque-ID API. `ViewerSelection` deliberately contains only ID, filename, relative path, format,
and source line. Plan 9 should replace the lightweight viewer host with its accessible modal,
fetch `/api/v1/files/:fileId/content`, and apply renderer/grep behavior without changing search
request coordination or accepting arbitrary local paths.

## Styling, accessibility, and testing

The visual system is local CSS and system fonts only. It includes high-contrast controls, visible
three-pixel focus rings, laptop/mobile layout constraints, overflow handling for long paths and
excerpts, semantic labels/live regions, and a reduced-motion media query. There are no CDN assets,
remote fonts, analytics, or telemetry.

Deterministic Bun/Happy DOM tests cover status/event transitions, partial messaging, debounce and
immediate submission, stale cancellation, count changes, URL state, deep links, result grouping,
literal highlights, expansion, keyboard navigation, viewer selection, long content, errors, and
API/SSE adapters. The Happy DOM globals are unregistered after the component suite so server tests
retain Bun's native request implementation.

Playwright builds the production UI and runs through the real Plan 7 Bun router, security headers,
status endpoint, SSE stream, and search endpoint with deterministic local service fixtures. It
asserts the critical keyboard path, accessible names and announcements, focus order and visible
focus, expansion, file opening, reduced motion, and control contrast. The fixture never loads a
model or reads a developer repository.

## Post-release shell update (2026-08-21)

The primary search control now lives in a responsive sticky top bar with minimal KBISS branding,
the indexing/readiness control immediately beside it, and the safe folder basename at the far edge.
The indexing control retains processed/total files, committed chunks, the current filename,
progress, and diagnostics; it collapses to a compact `Index ready` badge after indexing. `#236CFF`
is the single interactive accent across the main search view.

The header grid responds to indexing state. A completed index uses only the ready badge's intrinsic
width so the search field expands left without a reserved empty column. Active indexing reserves a
bounded, narrower status column, grows vertically, and wraps the current filename to two lines while
the search field consumes the remaining width.

SSE reconnect notices are cleared on stream open or any valid event. A transient progress-stream
reconnect is not presented as an error while committed search remains available; connection copy is
reserved for startup states where there is no usable search service.
