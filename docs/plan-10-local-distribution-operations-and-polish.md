# Plan 10 local distribution, operations, and polish contract

Plan 10 turns the Plan 01-09 application into a teammate-facing local product. It does not change
the Plan 6 ranking contract or Plan 9 rendering/security contract.

## Launch and model policy

`bun install` followed by `bun run serve` is sufficient on an online machine. `serve` builds Vite
production assets, starts loopback HTTP before long initialization, opens the browser exactly once,
then verifies/loads the configured model and reconciles the index in the background.

The pinned default remains `Xenova/bge-small-en-v1.5`, q8, 384 dimensions. Warm-up first inspects the
local integrity manifest and attempts local-only loading. If assets are absent and offline mode is
false, only this pinned model may be downloaded, with two launch attempts (three through explicit
`model:setup`). After setup, an integrity manifest covers every regular asset by size, mtime, and
SHA-256. Normal local loading sets Transformers.js `local_files_only`.

A corrupt manifest/cache is never overwritten in place. Online recovery renames it to a unique
`.corrupt-*` sibling before acquiring a fresh cache. `--offline`, `KBISS_OFFLINE`, or config
`offline:true` disables acquisition and produces a direct missing/corrupt-assets message. An
air-gapped import accepts only a complete, already verified KBISS model directory without symlinks,
copies it through a sibling staging directory, and preserves the previous managed cache.

## Operations and safety

`src/operations/` owns diagnostics, user-root selection, running-process actions, exact reset
targets, rebuild preservation, model import, and CLI argument handling. Minimal scripts only dispatch
to that tested layer.

- `config` prints resolved root/config/schema and every local path.
- `doctor` reports Bun pin compliance, native platform tier, key dependency pins, model integrity,
  and current index compatibility.
- `reconcile`/`reindex` locate the compatible same-root process, read its same-origin CSRF token, and
  invoke the existing Plan 7 bounded action.
- `root` canonicalizes/validates the directory and atomically updates only `root` in user JSON.
- `rebuild` atomically moves the exact current namespace into external `rebuild-backups`, recreates
  the required empty directories, and relies on the ordinary resumable startup pipeline to populate
  them. Existing schema namespaces are otherwise naturally retained across upgrades.
- `reset` defaults to the exact current namespace. All schema versions for the selected root and the
  selected model cache require separate flags.

Destructive paths must be strict descendants of their expected state/cache parent and are resolved
again immediately before use. Symlink escapes and broad/equal parent targets fail closed. Commands
print all targets, prompt on TTY, and require `--yes` in noninteractive automation.

## Production assets and product behavior

The Vite build uses content-hashed chunks. The Bun server assigns immutable one-year caching only to
hashed `/assets/` files, revalidation to ordinary local assets, and `no-cache` to HTML/SPA fallback.
Bun determines concrete content types, with an octet-stream fallback. API responses remain
`no-store`. Unknown asset paths do not fall through unless they are extensionless SPA routes.

The HTML shell now has a descriptive product title, local SVG icon, light/dark theme colors, and no
remote assets. Existing Plan 8/9 accessibility, empty/error/partial-index states, copy-path feedback,
responsive layout, reduced motion, content security, and renderer behavior remain the product
contract. CLI startup describes root, online/offline model policy, readiness, actionable diagnostics,
and graceful stop without printing content or queries.

## Plan 11 handoff

Plan 11 should use these commands in clean-environment release validation. It should retain the
offline/local-bundle fixture boundary for ordinary automation, run the opt-in real ONNX smoke path
only with prepared assets, test upgrades from copied old namespaces, and clean only temporary
application-data roots. Large-corpus relevance/performance evidence still owns the final BGE small
versus base decision; Plan 10 deliberately keeps model identity configurable and versioned.
