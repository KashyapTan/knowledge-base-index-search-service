# Coverage governance

The Plan 11 release gate measures executable application modules under `src/` and requires at least
93% aggregate line coverage and 93% aggregate function coverage. `bun run test:coverage` emits both
the human-readable table and `coverage/lcov.info`; `scripts/check-coverage.ts` independently parses
that report and fails either threshold.

Coverage is evidence for missing behavior, not a source-layout target. Security, recovery,
incremental-indexing, ranking, cancellation, and destructive-operation branches retain direct tests
regardless of the aggregate number.

## Reviewed exclusions

- `*.test.ts` and `*.test.tsx` are test definitions, not application behavior.
- `src/**/test-helpers.ts` and `src/**/fixtures/` are deterministic test support. Their production
  consumers remain measured.
- Type-only declarations, `src/ui/vite-env.d.ts`, static CSS/SVG, and minimal `src/ui/main.tsx` or
  script entrypoint glue contain no useful decision logic. Their observable UI/process behavior is
  exercised by component, process, and Playwright tests.
- Native LanceDB, ONNX Runtime, Transformers.js, and generated Vite output are third-party or
  generated code. KBISS integration and failure handling around those boundaries is covered.
- The narrow `productionAdapters` block in `src/server/runtime.ts` only wires Plan 3-6 factories.
  Each factory is directly covered, the composed boundary is injected in lifecycle tests, and the
  real tokenizer/model path is exercised by the opt-in local-assets smoke and model benchmark.
- The Mermaid lazy import/render callbacks in `src/ui/viewer/markdown-renderer.tsx` require a real
  browser SVG/layout environment. Playwright asserts local rendering and sanitized SVG output.
- One defensive ReactMarkdown branch for a malformed `pre` node is unreachable through the parser's
  public contract; all accepted fenced-code and diagram forms are covered.

No security, concurrency, error-recovery, ranking, or destructive-operation implementation is
excluded by file or directory.
