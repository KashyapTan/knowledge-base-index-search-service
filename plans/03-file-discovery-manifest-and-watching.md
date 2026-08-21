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

## Testing requirements

Build temporary fixture trees covering supported, extensionless UTF-8, unsupported, unreadable, hidden, ignored, empty, and large streamed files. Test deterministic ordering and IDs, metadata-first comparisons, content changes with unchanged size, timestamp precision edge cases, additions, deletions, renames, atomic editor saves, duplicate watcher events, reconciliation after simulated event loss, and recovery from a partially written manifest.

Include real filesystem integration tests for in-root symlinks, out-of-root symlinks, cycles, canonicalization races that can be reproduced safely, and assurance that discovery never writes into the source root. Use controllable clocks/event adapters where timing is involved so the suite is not flaky.

Target approximately 93% line and function coverage for non-trivial scanner, fingerprint, manifest, ignore, coalescing, and reconciliation code, with strong branch coverage for path-safety and error recovery. Run these tests with coverage plus typecheck, lint, and all pre-existing checks.

## Acceptance criteria

- A repeated scan of an unchanged repository emits no content changes.
- Adds, edits, deletes, common atomic saves, and in-root renames are represented correctly.
- Symlink cycles and out-of-root symlinks cannot escape the configured root.
- One unreadable file does not terminate the scan.
- Watcher recovery includes a reconciliation path.
- Discovery does not modify the indexed repository.
- Discovery tests are deterministic and the phase remains at or near 93% coverage for non-trivial, testable code.

## Handoff

Plan 04 consumes `DiscoveredFile` records and turns supported file content into normalized, line-addressable chunks.

## Completion notes (2026-08-20)

- Added the exported Plan 3 contracts and a composed discovery service. Stable file IDs use the
  opaque Plan 2 root identity plus an NFC-normalized root-relative path; absolute paths and local
  filesystem identities never participate in portable IDs.
- Added stable recursive traversal with bounded fingerprint concurrency, explicit glob ignores,
  `.git` exclusion, hidden-file inclusion, canonical directory handles, symlink-cycle detection,
  out-of-root rejection, and file-handle revalidation against canonicalization races.
- Added the complete required extension map plus strict streamed UTF-8/plain-text detection for
  extensionless and unfamiliar files. Empty, malformed, binary, unreadable, unsafe, and large files
  are isolated into typed records without aborting a scan.
- Added metadata-first incremental comparison with nanosecond timestamp/change metadata,
  filesystem identity where available, coarse-timestamp safeguards, and streaming SHA-256 hashes.
  Scans classify adds, content changes, metadata-only changes, unchanged files, deletions, and
  failures; renames intentionally remain delete-plus-add.
- Added an interface-backed JSON manifest under `ResolvedPaths.indexMetadataDir`. Mode-`0600`
  pending writes are atomically renamed, complete interrupted writes are promoted, partial writes
  are discarded, and corrupt state is safely rebuilt by reconciliation. Snapshot subscribers are
  notified only after persistence and only for actionable changes.
- Added native recursive watching with debounce/coalescing, authoritative re-stat scans, serialized
  in-flight work, periodic reconciliation, overflow/error recovery, and sleep/clock-drift recovery.
  Injected watch and scheduler adapters make timing behavior deterministic in tests.
- Added temporary-filesystem tests for every required format family, extensionless/hidden/ignored/
  empty/large/malformed/binary/unreadable files, deterministic order and IDs, incremental change
  classes, atomic saves, duplicate events, lost events, manifest recovery, state exclusion, and real
  in-root/out-of-root/cyclic symlinks. Full validation passes with 138 tests and reports 98.32% line
  and 99.29% function coverage for loaded application code; discovery code is 99%+ line coverage
  overall, with scanner function coverage at 95.56%.
- The complete persistence, change, watcher, ignore, and Plan 4 handoff contracts are recorded in
  `docs/plan-03-file-discovery.md`.
