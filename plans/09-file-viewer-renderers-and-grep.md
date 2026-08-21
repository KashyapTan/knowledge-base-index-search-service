# 09 - File Viewer, Renderers, and Grep

## Outcome

Provide a secure, attractive full-file viewer for Markdown, HTML, code, and ordinary text, with fast in-file grep, source navigation, and safe link behavior.

## Dependencies

Complete Plans 01-08. Fetch content only through the safe file-ID API from Plan 07.

## Work

### Viewer shell

Open files in an accessible modal or dialog-like overlay that supports predictable Escape/Back behavior, focus trapping/restoration, full-height reading, and deep linking if adopted in Plan 08.

The header should show filename, relative path, type, file size, current matched section/line, copy-path/reveal controls when available, renderer mode, and close action.

When opened from a result excerpt, scroll to and temporarily emphasize the corresponding source section.

### Renderer registry

Select a renderer by trusted detected format:

- Markdown/MDX: render GitHub-flavored Markdown with sanitized HTML, local syntax highlighting, tables, lists, headings, and anchor navigation. Do not execute embedded JSX/MDX components.
- HTML: offer a safe rendered preview in a sandboxed iframe and a source view. Disable scripts, same-origin privileges, forms, popups, and unnecessary remote resource loading. Apply a restrictive CSP to preview content.
- Code: use a read-only editor/viewer such as CodeMirror 6 with syntax highlighting, line numbers, selection/copy, and efficient handling of long files.
- JSON/YAML/XML/CSS/shell/SQL and other source: route through the appropriate code-language presentation.
- Plain text/log/CSV: use a virtualized or otherwise bounded text renderer preserving line numbers and whitespace.

Use lazy loading for heavy renderer modules so the search page remains fast.

### In-viewer grep

Provide a compact search control with:

- Literal search by default.
- Optional regular-expression mode.
- Case-sensitive toggle.
- Total match count and current position.
- Next/previous navigation.
- Enter/Shift+Enter shortcuts.
- Highlighting of all visible matches and a distinct active match.
- Graceful handling of invalid regex and zero-length regex matches.

For code/text, grep should operate against the original file content and navigate by offsets/lines. For rendered Markdown/HTML, highlight visible text without mutating unsafe HTML or corrupting React markup; provide a source-mode fallback when exact source matching cannot map cleanly to rendered text.

Run expensive grep operations off the critical render path for very large files and cancel stale searches.

### Link and source behavior

Links in Markdown or HTML should open only validated HTTP/HTTPS destinations in a new tab with `noopener` and `noreferrer`. Fragment links may navigate within the preview. Block or neutralize `file:`, `javascript:`, and other unsafe schemes.

“View full file” always means the complete internal viewer. If external reveal/open support is included, invoke only the safe API action for the already indexed file ID; never accept a shell command or arbitrary path from the browser.

### File changes while open

If the watcher reports that an open file changed or disappeared, display a non-destructive notice and allow refresh/close. Do not mix old grep offsets with new content silently.

## Testing requirements

Add unit tests for renderer selection, format metadata, literal/regex/case grep, Unicode, overlapping and zero-width matches, invalid regex, navigation wraparound, source offsets, stale-search cancellation, and changed/deleted-file state. Add component/browser tests for modal focus trapping/restoration, Escape/Back behavior, result-line navigation, source/preview switching, copy behavior, keyboard shortcuts, match highlighting, and large-file responsiveness.

Maintain malicious fixtures for Markdown and HTML containing scripts, event handlers, forms, popups, iframes, remote assets, `javascript:`, `file:`, data URLs, and attempts to access the parent origin. Assert sanitization, sandbox flags, CSP behavior, and safe external-link attributes in an actual browser where DOM behavior matters. Do not rely only on serialized markup snapshots for XSS protection.

Target approximately 93% line and function coverage for non-trivial viewer state, renderer selection, sanitization integration, grep, navigation, and link-policy code. Cover every safety-relevant branch regardless of aggregate coverage. Run coverage, typecheck, lint, production build, and existing checks before handoff.

## Acceptance criteria

- Markdown is attractive, sanitized, and faithful to common GFM content.
- Repository HTML cannot execute scripts or read the parent application's origin.
- Code/text files preserve lines, whitespace, copying, and syntax presentation.
- Grep supports literal/regex, case control, match counts, next/previous, and visible highlights.
- Opening from a result navigates to the matching source area.
- Unsafe URL schemes and arbitrary local paths cannot be opened.
- Large files remain usable without freezing the page.
- Viewer, grep, and content-safety tests keep non-trivial code at or near 93% meaningful coverage.

## Handoff

Plan 10 turns the integrated product into a dependable teammate-facing local command with model setup, state operations, documentation, and production polish.

## Completion notes (2026-08-21)

- Replaced the Plan 8 viewer host with a full-height accessible modal using opaque-ID-only metadata
  and content reads, focus trap/restoration, Escape and browser-Back behavior, source-line opening,
  relative-path copy feedback, explicit renderer modes, and non-destructive file-change/deletion
  notices driven by a new replayable `files` SSE event.
- Added a lazy renderer registry for sanitized GFM/MDX, isolated HTML preview/source, locally
  highlighted code, and virtualized plain/source text. Preview parsing is bounded at 1,000,000
  characters while the complete virtualized source remains accessible.
- Added local fenced Mermaid rendering with strict Mermaid configuration plus independent SVG
  sanitization. PlantUML/PUMl, Graphviz/DOT, D2, Vega, and Vega-Lite fences receive a clear,
  copyable source fallback without any remote renderer or repository-content transmission.
- Added layered content safety: Markdown raw HTML sanitization and blocked assets, an empty-sandbox
  HTML iframe with a nested default-deny CSP, removal of active/resource content, a shared
  fragment/HTTP(S)-only URL policy, and parent-controlled safe HTML external links. Chromium tests
  assert scripts, forms, frames, handlers, parent access, unsafe schemes, and hostile loads fail.
- Added exact-offset literal/regex grep with case control, Unicode, overlaps, zero-width handling,
  invalid-regex errors, capped counts, wraparound, Enter/Shift+Enter, visible/active source marks,
  rendered Markdown literal marks, source fallback, a large-file Worker, and stale cancellation.
- Added focused unit/component/browser coverage for the viewer, renderer registry, sanitization,
  grep, source offsets, modal keyboard/focus behavior, copy/failure states, watcher changes, diagram
  behavior, and a 20,000-line bounded-DOM fixture. Plan 9 viewer modules report 93.33-100% function
  coverage except the Markdown integration at 92.59% (with its Mermaid path verified in Chromium),
  and 96.46-100% line coverage.
- The complete default suite passes with 314 tests and one opt-in local-model smoke test skipped;
  suite coverage remains above 98% for lines and 97% for functions. Strict typecheck, Biome lint,
  the production Vite build, and the real Playwright browser test pass. Full contracts and Plan 10
  handoff guidance are recorded in `docs/plan-09-file-viewer-renderers-and-grep.md`.
