# Plan 4 text-extraction and chunk contract

Plan 4 converts `DiscoveredFile` records into deterministic, line-addressable `SearchChunk`
records. Its public API is exported from `src/extraction/index.ts`. It does not persist or embed
chunks; Plan 5 owns that lifecycle.

```ts
const pipeline = createExtractionPipeline(config, createTransformersTokenCounter(tokenizer), 512);
const result = await pipeline.process(discoveredFile);
if (result.ok) {
  for (const chunk of result.value.chunks) {
    // Pass chunk.searchText to the document-embedding provider.
  }
}
```

The tokenizer passed to the pipeline must be the selected embedding model's tokenizer. The
Transformers.js adapter counts special tokens, so the configured 512-token model limit applies to
the complete enriched representation rather than only source content. The Unicode word counter is
deterministic test/development support and is not the production BGE tokenizer.

## Read and normalization boundary

`FileExtractionPipeline.process()` accepts only discovery records marked `ready`. It verifies the
opaque root identity and normalized relative path, canonicalizes the current path, rejects targets
outside the configured root, opens the resolved path, and rechecks the source path before reading.
A failure is returned as a display-safe, file-scoped `ExtractionError`; one file cannot terminate
the surrounding indexing run.

Decoded text normalizes CRLF and CR to LF and replaces invalid UTF-8 or unpaired UTF-16 surrogates
with U+FFFD. `NormalizedSource` retains one-based source lines and a normalized-to-original UTF-16
offset map. Extracted units and chunks use inclusive start/end lines and half-open character
offsets. Search extraction never modifies the source file, and the later viewer still reads the
current original file.

## Extractor registry

`ExtractorRegistry` is keyed by the `FileFormat` produced by discovery. The default registry
contains these deterministic extractors:

- Markdown/MDX: frontmatter values, nested headings, paragraphs, lists, quotes, tables, and fenced
  code. Frontmatter delimiters are omitted from search text.
- HTML: title, description, headings, paragraphs, list/table rows, quotes, and code. Script, style,
  template, navigation, and aside content is excluded, including an unclosed active element through
  end of file.
- Python: module preamble plus class/function declarations, docstrings, and comments, with a line
  fallback for malformed strings or declaration-free files.
- JavaScript/TypeScript/JSX/TSX: top-level module declarations, interfaces, types, functions,
  components, and classes. A comment/string-aware delimiter check selects a deterministic line
  fallback for malformed input.
- JSON/JSONC, YAML, TOML, and XML: readable scalar key paths and values. JSONC comments and trailing
  commas are tolerated; malformed structured data falls back to source records.
- Shell, SQL, and stylesheets: function/object/selector declaration boundaries where recognized,
  then bounded line blocks.
- Plain text/log and CSV: paragraph/line blocks and bounded records; later CSV chunks repeat header
  context in search text without pretending it appears again in display text.

Unexpected extractor exceptions are isolated by a safe text fallback with a `PARSER_FALLBACK`
warning. An absent format registration returns `EXTRACTOR_UNAVAILABLE`.

## Chunk contract and identity

`SearchChunk` stores the opaque file ID, root-relative path, ordinal, raw display text, enriched
search text, one-based line range, original UTF-16 offsets, heading trail, symbols, content hash,
actual token count, and extractor/chunker versions.

Search enrichment is a controlled prefix containing relative path, filename, language/format,
heading trail, and symbols. It exists only in `searchText`; `displayText` never contains synthetic
prefixes. Adjacent small units combine only inside the same heading section. Large units split
deterministically with configured token overlap. Structure boundaries win when they fit, and every
finished chunk is recounted against the model's hard maximum.

Chunk content hashes are SHA-256 over display content. IDs are SHA-256 over a version marker, file
ID, semantic location (line range, headings, symbols), and content hash. Identical inputs and
configuration therefore reproduce identical chunks and IDs, while content or semantic-location
changes invalidate the affected identity.

## Plan 5 handoff

Plan 5 should consume only successful `ExtractedFile` results. Store `SearchChunk` fields directly
in the chunks table, embed `searchText`, show `displayText` in excerpts, and use `contentHash` plus
`chunkId` when deciding whether an existing embedding can be reused. It should treat
`ExtractionError` as a per-file indexing issue and continue other work. The extractor/chunker
versions and configured size/overlap are already index-compatibility inputs from Plan 2.
