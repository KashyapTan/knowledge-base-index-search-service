# 08 - React Search Experience

## Outcome

Create a polished, fast, accessible browser interface that makes indexing state understandable and lets teammates search, scan distinct-file results, and open a selected file with minimal friction.

## Dependencies

Complete Plans 01-07. Consume shared API types or generated equivalents; do not redefine server contracts ad hoc in components.

## Work

### Application shell

Build a focused single-page interface with:

- Product name and concise local/private status.
- Prominent search input.
- Configurable top-X result count with a restrained default.
- Current source-root label using a safe shortened representation.
- Indexing/readiness indicator.
- Main result region and viewer host.

Favor a lightweight visual system and excellent typography over a large UI framework. Keep assets local; do not depend on remote fonts, CDNs, analytics, or telemetry.

### Startup and indexing states

Subscribe to the progress stream and clearly represent loading model, scanning, indexing, ready, degraded, and fatal-error states. Show useful counts and allow searching available committed content while background indexing continues, with an explicit “results may be incomplete” indication.

Display per-file failures in a non-disruptive diagnostics area rather than flooding the primary view.

### Search interactions

- Focus the search input on load and provide a keyboard shortcut to refocus it.
- Debounce ordinary typing briefly while allowing Enter to submit immediately.
- Abort or ignore stale requests.
- Preserve identifiers and punctuation exactly as typed.
- Keep the previous useful result set visible during a fast refresh when appropriate.
- Represent loading, no-query, no-results, partial-index, and error states distinctly.

### Result presentation

Each result card represents one file and displays:

- Filename and root-relative path.
- File type/language.
- Best matching excerpt with source lines/section.
- Search-term highlights where reliable.
- Additional matched sections in a collapsed area.
- A clear full-file viewer action.
- Optional copy-path/reveal action supplied by the secure API.

Do not show raw vector distances as user-facing relevance percentages. Make result ordering and grouping visually obvious.

### Accessibility and responsiveness

Support keyboard navigation through results, visible focus, semantic controls, screen-reader labels, reduced-motion preferences, adequate contrast, and laptop-sized responsive layouts. Search and viewer interactions must not require a mouse.

### State and routing

Use the smallest appropriate state management approach. Make query/top-X state shareable in the URL if it does not leak sensitive data into unwanted browser history; otherwise document the privacy tradeoff. A selected file may use route/modal state so refresh and Back behavior remain predictable.

## Testing requirements

Add React component and hook tests for startup states, progress updates, partial-index messaging, query submission, Enter behavior, debounce timing, stale-request cancellation, top-X changes, result grouping, excerpt expansion, loading/no-results/error states, URL state if enabled, and long-path/large-excerpt rendering. Use fake timers and deterministic API/SSE adapters rather than real timeouts.

Add focused Playwright coverage for the critical keyboard flow: load, focus search, submit, move through distinct-file results, expand excerpts, and open a file. Include accessibility assertions for names, focus order, visible focus, status announcements, reduced motion, and contrast-relevant states. Mock APIs only for UI-state isolation; retain at least one contract-level browser smoke path against the real local API.

Target approximately 93% line and function coverage for non-trivial UI state, hooks, reducers, request coordination, and result-presentation logic. Static styling, generated API types, and trivial visual wrappers may be excluded narrowly; important interaction branches may not. Run coverage, typecheck, lint, production build, and existing checks before handoff.

## Acceptance criteria

- A teammate can understand whether results are complete and can search during background indexing.
- Stale responses cannot replace newer query results.
- Results are visibly grouped as distinct files with useful excerpts and relative paths.
- All primary search operations work with keyboard and assistive technology.
- The UI has no runtime dependency on external assets or services.
- Large result excerpts and long paths do not break the layout.
- UI tests cover critical behavior and keep non-trivial, testable frontend logic at or near the 93% coverage target.

## Handoff

Plan 09 implements the full-file modal/viewer and its renderer-specific grep behavior.

## Completion notes (2026-08-21)

- Replaced the Plan 7 lifecycle placeholder with a responsive React search application using a
  small local CSS system, system fonts, no remote assets, and no telemetry. The shell shows the
  product privacy posture, a server-derived basename-only source label, live readiness/indexing
  state, search controls, distinct-file results, diagnostics, and the Plan 9 viewer host.
- Added a typed browser adapter over the shared Plan 6/7 contracts, one SSE subscription, display-safe
  API failures, and deep-linked opaque-ID metadata lookup. `ApplicationStatus.sourceRootLabel` is
  derived without exposing an absolute source path.
- Added 250 ms debounced search plus immediate Enter/button submission, exact query preservation,
  configurable top-X, AbortController cancellation, generation-based stale-response rejection,
  previous-result preservation during refresh, and distinct idle/loading/refresh/no-result/error/
  partial-index states.
- Added file-grouped cards with root-relative paths, formats, best excerpt context and source lines,
  safe literal highlighting, collapsed supplemental excerpts, and no misleading score percentage.
  Long paths and large excerpts are bounded without losing their underlying accessible text.
- Added load focus, `/` and Command/Ctrl-K refocus, ArrowUp/ArrowDown/Home/End result movement,
  semantic controls/live regions, visible focus, responsive layouts, contrast-aware colors, and
  reduced-motion behavior. The full search flow is usable without a mouse.
- Added URL-backed `q`/`n` state with replace semantics and pushed opaque file/line selection state
  for predictable refresh and Back behavior. The UI and detailed Plan 8 contract explicitly disclose
  that shareable localhost URLs can retain submitted queries in browser history.
- Added 19 deterministic UI tests and one Playwright browser smoke path through the real production
  asset and Plan 7 API/SSE router. Plan 8 UI modules report 99.29% line and 97.90% function coverage;
  the complete suite passes 294 tests with one opt-in model smoke test skipped and reports 99.47%
  line and 98.80% function coverage. Playwright, strict typecheck, lint, and production build pass.
- Full browser contracts, URL privacy behavior, request coordination, accessibility decisions, and
  the Plan 9 viewer handoff are recorded in `docs/plan-08-react-search-experience.md`.
