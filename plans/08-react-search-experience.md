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

## Acceptance criteria

- A teammate can understand whether results are complete and can search during background indexing.
- Stale responses cannot replace newer query results.
- Results are visibly grouped as distinct files with useful excerpts and relative paths.
- All primary search operations work with keyboard and assistive technology.
- The UI has no runtime dependency on external assets or services.
- Large result excerpts and long paths do not break the layout.

## Handoff

Plan 09 implements the full-file modal/viewer and its renderer-specific grep behavior.

