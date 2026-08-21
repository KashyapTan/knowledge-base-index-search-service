# Plan 9 file viewer, renderer, and grep contract

Plan 9 replaces the Plan 8 selection placeholder with a full-height, same-origin file viewer. The
browser still identifies files only by opaque SHA-256 IDs and fetches current bytes only from the
Plan 7 `GET /api/v1/files/:fileId/content` boundary.

## Viewer and lifecycle

`FileViewer` is an `aria-modal` dialog with a trapped Tab cycle, Escape close, focus restoration,
and the Plan 8 URL/Back behavior. Its header contains filename, root-relative path, trusted format,
live byte size, target/current match line, renderer mode, a relative-path-only copy action, and the
close action. Opening a result retains its one-based source line; source mode scrolls a virtualized
line window and Markdown preview temporarily emphasizes the nearest positioned block.

`KbissApi.getFileContent()` is the only browser content reader. It preserves the structured Plan 7
error envelope and never accepts a path. App-wide `/` and Command/Ctrl-K shortcuts are disabled
while the modal is open so they cannot move focus behind it.

The server now emits replayable `files` SSE events containing only opaque IDs and `changed` or
`deleted` state. Content, paths, and queries are not added to events. An open viewer keeps its loaded
snapshot and grep offsets stable, displays a notice, and offers an explicit refresh for changes.
Deletes retain the loaded copy until close. Failed watcher reads are treated as changes because the
browser must not silently assume its snapshot is current.

## Renderer registry and bounds

Trusted discovery formats map as follows:

| Formats | Renderer |
| --- | --- |
| Markdown/MDX | sanitized GFM preview plus source |
| HTML | empty-sandbox `srcdoc` preview plus source |
| Python, JavaScript/TypeScript, JSON, YAML, TOML, CSS, shell, SQL, XML | highlighted source |
| CSV, logs, ordinary/unknown text | whitespace-preserving source |

The Markdown, HTML, source-highlighting, Mermaid, and grep Worker modules are lazy production
chunks. Source uses a fixed-height virtual line window with overscan, so a 20,000-line fixture keeps
fewer than 150 line nodes mounted. Markdown/HTML preview is disabled above 1,000,000 characters;
the complete virtualized source remains available. This bound prevents an enormous parsed markup
tree while retaining full-file access.

Markdown uses `react-markdown`, GFM, raw-HTML parsing followed by `rehype-sanitize`, and local
Highlight.js languages. JSX/MDX components are never evaluated. Repository images are represented
as blocked placeholders. Fenced `mermaid` is loaded only on demand, rendered with Mermaid strict
security and HTML labels disabled, then independently SVG-sanitized before insertion. Other known
diagram fences (`plantuml`/`puml`, Graphviz/DOT, D2, Vega/Vega-Lite) remain labeled, copyable source;
KBISS never sends a diagram to a remote renderer.

## HTML and link isolation

HTML preview is sanitized before it enters an iframe. Scripts, styles, forms and controls, frames,
objects, embedded content, media/resource elements, handlers, inline style, source URLs, and active
attributes are removed. The generated complete document includes `default-src 'none'`,
`script-src 'none'`, `form-action 'none'`, and explicit no-load directives. The iframe uses an empty
`sandbox`—no scripts, same-origin authority, forms, popups, or parent access.

Only absolute `http:`/`https:` and fragment links survive policy validation. Markdown external links
open with `_blank`, `noopener noreferrer`, and no referrer. Because the HTML iframe intentionally
cannot open popups, its validated HTTP(S) links are also exposed in a parent-controlled link strip
with those attributes. Relative paths, `file:`, `javascript:`, `data:`, mail, and unknown schemes are
neutralized; local repository navigation never bypasses an opaque file ID.

The app CSP explicitly permits only same-origin Workers and frames while retaining the existing
default deny, object deny, and frame-ancestor deny policy. The preview's nested CSP is stricter than
the app policy.

## Grep contract

`runGrep()` operates on original UTF-16 source content and returns exact start/end offsets plus
one-based line/column positions. Literal search is default, permits overlaps, and uses Unicode-aware
regular-expression case folding without lowercasing the source (which could corrupt offsets).
Optional regex mode uses global Unicode matching. Zero-width matches advance by a Unicode code
point, invalid expressions return a display-safe error, and results are capped at 20,000 with an
explicit limited marker.

Navigation wraps in both directions. Enter selects next and Shift+Enter previous; buttons expose the
same behavior. Source mode highlights visible matches and a distinct active match. Markdown preview
also highlights visible literal text without rewriting unsafe HTML or React markup. Navigating an
exact Markdown/HTML source match switches to source mode as the deterministic fallback.

Files below 256 KiB grep after a microtask yield. Larger files run in a disposable module Worker.
Every query generation aborts the prior Worker/search and stale results are ignored even if an
executor resolves after cancellation.

## Verification

Unit/component coverage includes format routing, safe links, HTML/SVG sanitization, literal/regex/
case/Unicode/overlap/zero-width grep, offsets, caps, wraparound, cancellation, virtual scrolling,
viewer loading/failure/change states, copy behavior, focus trapping/restoration, Escape, keyboard
shortcuts, preview/source changes, active highlights, and large-file bounds.

The production Chromium test uses real Plan 7 routes and malicious Markdown/HTML fixtures containing
scripts, handlers, forms, frames, remote assets, parent-origin attempts, and unsafe URL schemes. It
also renders Mermaid, checks the non-Mermaid fallback, asserts sandbox/CSP/link attributes and zero
hostile network requests, exercises grep/source navigation, and verifies browser Back behavior.
