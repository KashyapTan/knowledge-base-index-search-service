# 04 - Text Extraction and Structure-Aware Chunking

## Outcome

Convert supported Markdown, HTML, code, and ordinary text files into clean, deterministic chunks suitable for semantic and keyword search while preserving accurate navigation back to the source.

## Dependencies

Complete Plans 01-03. Input must arrive through the discovery contracts, and every file read must be revalidated as inside the configured root.

## Work

### Extractor registry

Implement an extractor interface selected by detected format rather than scattering extension switches throughout the indexer. Each extractor returns normalized searchable text, document metadata, source line/offset mapping, and warnings.

Required extractors:

- Markdown/MDX: preserve heading hierarchy, paragraphs, lists, tables, block quotes, and fenced-code context. Avoid embedding frontmatter syntax noise while retaining meaningful values.
- HTML: extract title, meta description when useful, headings, visible body text, lists, tables, and code blocks. Exclude scripts, styles, templates, and navigation noise where reliably identifiable.
- Python: prefer module/class/function boundaries, docstrings, comments, and logical declarations.
- JavaScript/TypeScript and JSX/TSX: prefer modules, classes, functions, components, and logical declarations.
- Other source formats: use safe language-aware rules where available and a deterministic line-block fallback.
- JSON/YAML/TOML/XML: retain key paths and readable values rather than flattening away structure.
- Plain text/log/CSV: preserve lines and paragraph/record boundaries with a bounded fallback.

Unsupported or malformed syntax must fall back to text extraction when safe instead of discarding the entire file.

### Text normalization

Normalize line endings and invalid Unicode predictably while retaining a mapping to original line numbers. Avoid destructive whitespace normalization that merges code tokens or makes displayed excerpts inaccurate.

Store the original file separately from extracted search text; the viewer later reads the current full file and does not reconstruct it from chunks.

### Chunking policy

Start with approximately 350-450 embedding tokens and 10-15% overlap, subject to the selected model's tokenizer and 512-token limit. Structure boundaries take priority over hitting an exact size.

When a semantic unit is too large, split it by nested blocks, paragraphs, or line windows. When units are too small, combine adjacent units sharing the same section. Ensure deterministic chunk output for identical input.

### Search-enrichment context

Create a controlled embedding/search representation that can include:

- Root-relative file path and filename.
- Format/language.
- Markdown heading trail.
- Class/function/component/symbol name.
- The actual chunk content.

Keep raw chunk content separately so the UI does not show synthetic prefixes as if they were in the source file.

### Chunk identity and navigation

Each chunk must include:

- Stable chunk ID derived from file identity, semantic location, and content.
- File ID.
- Ordinal.
- Raw display text and enriched searchable text.
- Start/end line and, when practical, character offsets.
- Heading/symbol context.
- Content hash.
- Extractor/chunker version.

Line ranges must be accurate enough to open and highlight the corresponding section in the full-file viewer.

## Testing requirements

Create reviewed golden fixtures for every supported extractor family: Markdown/MDX, HTML, Python, JavaScript/TypeScript/JSX/TSX, structured data, shell/SQL/styles, and plain-text fallback. Assert extracted visible text, omitted noise, heading/symbol context, deterministic IDs, token limits, overlap policy, Unicode/line-ending normalization, and exact source line/offset mapping.

Include malformed syntax, frontmatter, nested headings, fenced code, HTML scripts/styles/templates, large declarations, extremely long lines, invalid Unicode, empty files, and parser-fallback cases. Prefer semantic assertions over enormous brittle snapshots; use focused snapshots only where a structured output is meant to be stable. Add property/invariant tests where useful, such as no chunk exceeding the model limit and every chunk range remaining inside its file.

Target approximately 93% line and function coverage for non-trivial extractor, normalizer, tokenizer/chunker, enrichment, and mapping logic. Critical fallback and malformed-input branches must be covered regardless of the aggregate number. Run coverage, typecheck, lint, and existing checks before handoff.

## Acceptance criteria

- Identical input and configuration produce identical chunks and IDs.
- Markdown chunks retain heading context and do not split ordinary paragraphs unnecessarily.
- HTML embeddings exclude script/style contents and retain meaningful visible sections.
- Python and JS/TS files prefer declaration boundaries, with a reliable malformed-code fallback.
- No chunk exceeds the model's actual token limit after enrichment.
- Every displayed chunk can map back to correct source lines.
- Extractor failures are isolated to individual files and are actionable.
- Extractor/chunker tests meet the project's approximately 93% meaningful coverage target for non-trivial code.

## Handoff

Plan 05 consumes the chunk contracts, produces local embeddings, and persists file/chunk state in LanceDB.

## Completion notes (2026-08-20)

- Added the exported Plan 4 contracts and composed extraction pipeline. It consumes only ready
  `DiscoveredFile` records, revalidates root identity, relative paths, canonical containment, and
  path stability immediately around each read, and isolates every expected failure by file ID.
- Added deterministic CRLF/CR and invalid-Unicode normalization with one-based line data and
  normalized-to-original UTF-16 offset mapping. Invalid UTF-8 changes after discovery are decoded
  predictably with an actionable warning rather than terminating extraction.
- Added a format-keyed extractor registry for Markdown/MDX, visible HTML, Python,
  JavaScript/TypeScript/JSX/TSX, JSON/JSONC/YAML/TOML/XML, shell/SQL/stylesheets, CSV, and ordinary
  text. Malformed syntax and unexpected parser failures use safe bounded fallbacks.
- Added structure-aware chunking with the configured 400-token target and 50-token overlap,
  injected selected-model token counting, a hard 512-token recount, path/format/heading/symbol
  enrichment kept separate from display text, SHA-256 content hashes, and stable semantic chunk
  IDs.
- Added reviewed fixtures and focused/property-style assertions for all extractor families,
  nested headings, frontmatter, fenced code, hidden HTML content, malformed and unclosed syntax,
  large declarations, extreme lines, invalid Unicode/UTF-8, empty files, deterministic IDs,
  overlap, hard limits, and exact source ranges. The full suite passes with 181 tests and reports
  98.84% line and 99.56% function coverage overall; Plan 4 application modules exceed the 93%
  target.
- The complete public API, tokenizer expectation, safety boundary, field semantics, and Plan 5
  handoff are recorded in `docs/plan-04-text-extraction.md`.

## Post-release regression fix (2026-08-22)

- Fixed oversized-unit splitting so reaching the unit end terminates overlap generation. Version 1
  could emit progressively shorter suffix fragments and merge them into malformed searchable/display
  chunks.
- Added a regression invariant requiring every split display chunk to remain a contiguous source
  excerpt and retain the final source token without synthetic suffixes.
- Bumped the default chunker compatibility version to 2 so affected local indexes require a rebuild.
