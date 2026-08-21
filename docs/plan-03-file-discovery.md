# Plan 3 file-discovery contract

Plan 3 inventories repository files without extracting semantic text. Its public surface is exported
from `src/discovery/index.ts`. Callers create the composed service with a validated `AppConfig`:

```ts
const discovery = await createDiscoveryService(config, {
  scanner: { ignorePatterns: ["generated/**", "scratch/"] },
});
if (discovery.ok) await discovery.value.watcher.start();
```

`start()` attaches the filesystem watcher before starting the initial scan, closing the event gap
between the initial snapshot and continuous watching. The server lifecycle does not start this
service yet; that integration remains in the later indexing/API plans.

## Inventory and identity

`DiscoveredFile` contains the opaque file ID, root-relative normalized path, canonical absolute
path, filename, lowercase extension, detected format/MIME family, fingerprint, read/index status,
and a display-safe last error when applicable. A file ID is SHA-256 over a version marker, the
opaque Plan 2 root identity, and the NFC-normalized POSIX-style relative path. It never contains an
absolute path or a caller-supplied path.

The scanner traverses directory entries in stable code-point order and fingerprints files with
bounded concurrency (eight by default). Hidden content is included. `.git` segments are always
excluded; no other broad directory exclusions are implicit. Teams may pass root-relative `*`,
`**`, and `?` glob rules through `ignorePatterns`; a trailing slash makes a rule directory-only.
Plan 2's state and cache paths are also explicitly excluded by the composed scanner.

Symbolic links are resolved before traversal. Targets outside the canonical root become `unsafe`
per-file records and are never opened. Canonical directories are opened through directory handles,
and their canonical identities are tracked to stop cycles and duplicate traversal. Files are opened
through handles and the source path is canonicalized again before any bytes are read, detecting
reproducible retargeting races.

## Format detection and fingerprints

All format extensions listed in `AGENTS.md` are mapped to a format and MIME family. Extensionless
and unfamiliar files are accepted as plain text only after strict streaming UTF-8 validation and a
small binary-control-byte check. Empty files are valid text. Invalid UTF-8, binary NUL data,
unreadable files, and unsafe paths remain in the snapshot with isolated statuses; they cannot stop
the scan.

Fingerprints contain byte size, modification time in milliseconds and decimal nanoseconds, change
time, inferred timestamp precision, optional device/inode identity, and a streaming SHA-256 content
hash. A repeat scan first compares size, timestamps, and filesystem identity. It reuses the stored
hash when reliable metadata is unchanged; changed or coarse timestamps cause a streamed hash.
Consequently a same-size rewrite with restored modification time is still detected through change
metadata, while a metadata-only touch avoids downstream re-indexing after hash comparison.

## Manifest and change semantics

`JsonFileManifest` implements the storage-independent `FileManifest` interface. Its default path is
`ResolvedPaths.indexMetadataDir/file-manifest.json`. It exposes `snapshot()`, `get(fileId)`, and
`subscribe(listener)`. Persistence writes a mode-`0600` `.pending` file and atomically renames it;
a complete pending file is promoted on restart, a partial pending file is discarded, and corrupt
state is rebuilt by the next authoritative scan.

Every scan returns all classifications in stable path order:

- `added`: a new readable text file;
- `content-changed`: a readable file's hash or prior read status changed;
- `metadata-only`: its content hash stayed the same while metadata changed;
- `unchanged`: no meaningful record change;
- `deleted`: a prior manifest path is absent or now ignored;
- `failed`: a new or changed malformed, unsupported, unreadable, or unsafe file.

Manifest subscribers receive only actionable changes (everything except `unchanged`) and receive
them only after the replacement snapshot is durably renamed. Persistent failures remain reflected
in `DiscoveryProgress.failed` but are not repeatedly delivered when their records are unchanged.
Renames intentionally appear as delete plus add.

`DiscoveryProgress` reports `discovered`, `unchanged`, `pending`, `failed`, and `removed` counts
without paths or contents. Initial per-file failures can also flow through Plan 2's `file_error`
startup event; a fatal root scan uses `fatal_error`.

## Watch and reconciliation

`DiscoveryWatcher` converts raw rename/change notifications into full metadata-first scans. A
100 ms default debounce coalesces duplicate and atomic-save event patterns, and every final event is
re-statted by the scanner rather than trusted. Events received during a scan queue one subsequent
scan, with reconciliation taking priority.

Native recursive watching is used when supported. If a filesystem cannot provide it, a root watch
plus the same reconciliation loop preserves eventual correctness. Native errors/overflow signals,
periodic 60-second checks, and clock drift after sleep all schedule authoritative reconciliation.
The watcher accepts `WatchSource` and `WatchScheduler` adapters so event loss, sleep, debouncing, and
in-flight queues can be tested without timing flakiness.

## Plan 4 handoff

Plan 4 should consume only manifest records whose `readStatus` is `ready`, use `fileId`,
`relativePath`, `format`, and `fingerprint.contentHash` as its discovery inputs, and subscribe to
actionable changes for incremental work. Before reading, it must still canonicalize the current
path and verify containment because files may change after discovery. A `deleted` change provides
the previous record so later storage can remove stale chunks.
