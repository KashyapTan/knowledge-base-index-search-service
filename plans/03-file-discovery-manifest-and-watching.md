# 03 - File Discovery, Manifest, and Watching

## Outcome

Build a deterministic, resumable inventory of supported files under the configured root and emit normalized change events for the indexing pipeline.

This phase discovers and fingerprints files. It does not extract semantic text or create embeddings.

## Dependencies

Complete Plans 01-02. Use the centralized root and local-state resolution; do not recreate path logic.

## Work

### Recursive discovery

Walk the root with bounded concurrency and stable ordering. Consider regular files with supported source/text extensions and safely detect ordinary UTF-8 text for extensionless or unfamiliar text files.

At minimum, recognize the format families listed in `AGENTS.md`. Treat unreadable, malformed, or unsupported files as per-file statuses rather than fatal scan failures.

Do not follow a symlink whose canonical target is outside the configured root. Avoid cycles. Exclude VCS internals such as `.git` and the application's own state location. Provide an explicit ignore mechanism for teams that need it, but do not silently add broad exclusions that could hide artifact content.

### Stable identity and metadata

Assign stable file IDs from root-relative normalized paths. Capture:

- Relative and canonical absolute path.
- Filename and extension.
- Detected format/MIME family.
- Byte size.
- Modification time with understood precision limitations.
- Filesystem identity where useful but not portable.
- Read/index status and last error summary.

Never use an unvalidated client-supplied absolute path as a file ID.

### Incremental fingerprinting

Use size and modification time as a cheap first comparison. Hash contents when metadata changed, when timestamps are unreliable, or when a correctness check requires it. Select a fast deterministic content hash and stream large files rather than loading everything merely to fingerprint it.

Classify scan output into added, content-changed, metadata-only, unchanged, deleted, and failed. A rename may be expressed as delete-plus-add initially, provided stale chunks are reliably removed later.

### Manifest ownership

Define the manifest abstraction and its persisted representation. It may share LanceDB storage later, but discovery code must depend on an interface rather than LanceDB query details. Updates should be crash-safe enough that an interrupted scan is recoverable on the next run.

### Continuous watching

After the initial scan, watch the root for additions, writes, removals, and renames. Debounce editor save patterns and coalesce duplicate events. Re-stat a file before emitting a final change because many editors replace files atomically.

If the watcher overflows, loses events, or the laptop sleeps, schedule a reconciliation scan rather than trusting an incomplete event stream.

### Progress events

Emit structured progress containing counts for discovered, unchanged, pending, failed, and removed files. Do not emit file contents.

## Contracts

Define typed contracts similar to:

- `DiscoveredFile`
- `FileFingerprint`
- `FileChange`
- `DiscoveryProgress`
- `FileManifest`

The downstream pipeline must be able to request a full snapshot and subscribe to normalized changes.

## Acceptance criteria

- A repeated scan of an unchanged repository emits no content changes.
- Adds, edits, deletes, common atomic saves, and in-root renames are represented correctly.
- Symlink cycles and out-of-root symlinks cannot escape the configured root.
- One unreadable file does not terminate the scan.
- Watcher recovery includes a reconciliation path.
- Discovery does not modify the indexed repository.

## Handoff

Plan 04 consumes `DiscoveredFile` records and turns supported file content into normalized, line-addressable chunks.

