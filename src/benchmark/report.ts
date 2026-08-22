import type { LargeRepositoryBenchmarkReport, ModelComparisonReport } from "./contracts.ts";

function milliseconds(value: number): string {
  return `${value.toFixed(value < 10 ? 2 : 1)} ms`;
}

function bytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function renderBenchmarkMarkdown(report: LargeRepositoryBenchmarkReport): string {
  const relevance = report.relevance?.metrics;
  return `# KBISS large-repository benchmark

Generated ${report.generatedAt} for corpus revision \`${report.corpus.revision ?? "unversioned"}\`.
No absolute source path or corpus content is included.

## Corpus and settings

- ${report.corpus.supportedFileCount.toLocaleString()} supported files, ${bytes(report.corpus.totalBytes)}, ${report.indexing.extractedChunkCount.toLocaleString()} chunks
- ${report.settings.modelId} (${report.settings.embeddingDevice}/${report.settings.quantization}, ${report.settings.vectorDimension} dimensions)
- ${report.settings.chunkSizeTokens} target tokens with ${report.settings.chunkOverlapTokens} overlap
- ${report.settings.indexStrategy} vector strategy at a ${report.settings.annThreshold.toLocaleString()}-chunk ANN threshold

## Performance

- Browser shell ready: ${milliseconds(report.startup.loopbackBrowserReadyMs)}
- Model load: ${milliseconds(report.startup.modelLoadMs)}; tokenizer: ${milliseconds(report.startup.tokenizerLoadMs)}
- Initial scan: ${milliseconds(report.startup.initialScanMs)}
- Initial indexing: ${milliseconds(report.indexing.initialWallMs)} (${report.indexing.chunksPerSecond.toFixed(2)} chunks/s)
${
  report.indexing.stageTiming
    ? `- Indexing stage busy time (overlaps; do not sum as wall time): preparation ${milliseconds(report.indexing.stageTiming.preparationMs)}, embedding ${milliseconds(report.indexing.stageTiming.embeddingMs)}, commit ${milliseconds(report.indexing.stageTiming.commitMs)}, finalization ${milliseconds(report.indexing.stageTiming.finalizationMs)}
- Pipeline wall time: ${milliseconds(report.indexing.stageTiming.pipelineWallMs ?? report.indexing.stageTiming.totalMs)}; queue wait/backpressure: preparation ${milliseconds(report.indexing.stageTiming.stageWaitMs?.preparation ?? 0)}, embedding ${milliseconds(report.indexing.stageTiming.stageWaitMs?.embedding ?? 0)}, commit ${milliseconds(report.indexing.stageTiming.stageWaitMs?.commit ?? 0)}
- Embedding token utilization: ${(report.indexing.stageTiming.embeddingUtilization?.usefulTokens ?? 0).toLocaleString()} useful / ${(report.indexing.stageTiming.embeddingUtilization?.paddedTokens ?? 0).toLocaleString()} padded tokens in ${(report.indexing.stageTiming.embeddingUtilization?.batches ?? 0).toLocaleString()} batches`
    : ""
}
- No-change reconciliation: ${milliseconds(report.indexing.noChangeReconciliationMs)}
- Peak / steady RSS: ${bytes(report.memory.peakRssBytes)} / ${bytes(report.memory.steadyRssBytes)}
- Index / model cache: ${bytes(report.storage.indexBytes)} / ${bytes(report.storage.modelCacheBytes)}
- Warm query p50 range: ${milliseconds(Math.min(...report.queries.map((query) => query.totalMs.p50)))}–${milliseconds(Math.max(...report.queries.map((query) => query.totalMs.p50)))}
- Warm query p95 range: ${milliseconds(Math.min(...report.queries.map((query) => query.totalMs.p95)))}–${milliseconds(Math.max(...report.queries.map((query) => query.totalMs.p95)))}

## Correctness and relevance

- Read-only verification: ${report.corpus.readOnlyVerification.gitStatusUnchanged === false ? "failed" : "passed"}
- Initial indexing failures: ${report.indexing.failedFiles}; no-change files: ${report.indexing.noChangeFiles}
- External-copy update/delete/rename: ${milliseconds(report.incrementalFixture.updateMs)} / ${milliseconds(report.incrementalFixture.deleteMs)} / ${milliseconds(report.incrementalFixture.renameMs)}
${
  report.incrementalFixture.metadataOnlyMass
    ? `- Metadata-only mass update: ${report.incrementalFixture.metadataOnlyMass.fileCount} files in ${milliseconds(report.incrementalFixture.metadataOnlyMass.wallMs)}; embedded ${report.incrementalFixture.metadataOnlyMass.embeddedChunks} chunks; chunk table ${report.incrementalFixture.metadataOnlyMass.chunksVersionUnchanged ? "unchanged" : "changed"}`
    : ""
}
${
  report.incrementalFixture.largeFileEdits
    ? `- Large-file start/middle/end edits (${bytes(report.incrementalFixture.largeFileEdits.fileBytes)}): ${milliseconds(report.incrementalFixture.largeFileEdits.start.wallMs)} / ${milliseconds(report.incrementalFixture.largeFileEdits.middle.wallMs)} / ${milliseconds(report.incrementalFixture.largeFileEdits.end.wallMs)}; embedded ${report.incrementalFixture.largeFileEdits.start.embeddedChunks}/${report.incrementalFixture.largeFileEdits.middle.embeddedChunks}/${report.incrementalFixture.largeFileEdits.end.embeddedChunks} chunks`
    : ""
}
${
  relevance
    ? `- Recall@5 ${(relevance.recallAt5 * 100).toFixed(1)}%; Recall@10 ${(relevance.recallAt10 * 100).toFixed(1)}%; MRR ${relevance.meanReciprocalRank.toFixed(3)}`
    : "- No private large-corpus judgment file was supplied; performance queries were anonymized in this report."
}
`;
}

export function renderModelComparisonMarkdown(report: ModelComparisonReport): string {
  const metric = (value: number | null): string =>
    value === null ? "not judged" : value.toFixed(3);
  return `# KBISS BGE small versus BGE base

Generated ${report.generatedAt} for corpus revision \`${report.corpusRevision ?? "unversioned"}\`.
Non-model settings were ${report.identicalSettings ? "identical" : "not identical"}.

| Metric | BGE small | BGE base |
| --- | ---: | ---: |
| Recall@5 | ${metric(report.small.recallAt5)} | ${metric(report.base.recallAt5)} |
| Recall@10 | ${metric(report.small.recallAt10)} | ${metric(report.base.recallAt10)} |
| MRR | ${metric(report.small.meanReciprocalRank)} | ${metric(report.base.meanReciprocalRank)} |
| Indexing chunks/s | ${report.small.indexingChunksPerSecond.toFixed(2)} | ${report.base.indexingChunksPerSecond.toFixed(2)} |
| Median warm query | ${milliseconds(report.small.medianWarmQueryMs)} | ${milliseconds(report.base.medianWarmQueryMs)} |
| Model load | ${milliseconds(report.small.modelLoadMs)} | ${milliseconds(report.base.modelLoadMs)} |
| Peak RSS | ${bytes(report.small.peakRssBytes)} | ${bytes(report.base.peakRssBytes)} |
| LanceDB index | ${bytes(report.small.indexBytes)} | ${bytes(report.base.indexBytes)} |

## Decision

Selected \`${report.decision.selectedModel}\`.

${report.decision.rationale.map((reason) => `- ${reason}`).join("\n")}
`;
}
