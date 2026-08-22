import type { DistributionSummary } from "./contracts.ts";

function quantile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(probability * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)] ?? 0;
}

export function summarizeDistribution(values: readonly number[]): DistributionSummary {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (sorted.length === 0) {
    return { count: 0, minimum: 0, mean: 0, p50: 0, p95: 0, p99: 0, maximum: 0 };
  }
  return {
    count: sorted.length,
    minimum: sorted[0] ?? 0,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    maximum: sorted.at(-1) ?? 0,
  };
}
