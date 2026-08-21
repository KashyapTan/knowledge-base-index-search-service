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

## Acceptance criteria

- Identical input and configuration produce identical chunks and IDs.
- Markdown chunks retain heading context and do not split ordinary paragraphs unnecessarily.
- HTML embeddings exclude script/style contents and retain meaningful visible sections.
- Python and JS/TS files prefer declaration boundaries, with a reliable malformed-code fallback.
- No chunk exceeds the model's actual token limit after enrichment.
- Every displayed chunk can map back to correct source lines.
- Extractor failures are isolated to individual files and are actionable.

## Handoff

Plan 05 consumes the chunk contracts, produces local embeddings, and persists file/chunk state in LanceDB.

