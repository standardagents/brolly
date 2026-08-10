import type { AssetRef, Evaluation, MetricSample, Policy, Severity, SpendLimits, Threshold } from "./types.js";

export const DEFAULT_FAMILY_DAILY_SPEND: Record<string, SpendLimits> = Object.fromEntries([
  "workers", "durable_objects", "workers_ai", "queues", "d1", "r2", "kv", "pages", "images", "stream",
  "vectorize", "hyperdrive", "ai_gateway", "zones",
].map(family => [family, { warning: 1, critical: 5, emergency: 10 }])) as Record<string, SpendLimits>;

export const DEFAULT_POLICY: Policy = {
  version: "2026-08-09.1",
  mode: "approval",
  accountDailySpend: { warning: 5, critical: 12.5, emergency: 25 },
  familyDailySpend: DEFAULT_FAMILY_DAILY_SPEND,
  assetDailySpend: {},
  thresholds: [
    { metric: "rows_read", windowMs: 5 * 60_000, warning: 1_000_000, critical: 2_500_000, emergency: 5_000_000, minimumBaselineSamples: 12, anomalyMultiplier: 8 },
    { metric: "rows_written", windowMs: 5 * 60_000, warning: 5_000, critical: 12_500, emergency: 25_000, minimumBaselineSamples: 12, anomalyMultiplier: 8 },
    { metric: "rows_read", windowMs: 24 * 60 * 60_000, emergency: 100_000_000 },
    { metric: "rows_written", windowMs: 24 * 60 * 60_000, emergency: 500_000 },
    { metric: "projected_daily_cost_usd", windowMs: 24 * 60 * 60_000, warning: 0.5, critical: 2, emergency: 5, minimumBaselineSamples: 12, anomalyMultiplier: 6 },
  ],
};

const rank: Record<Severity, number> = { info: 0, warning: 1, critical: 2, emergency: 3 };

export function robustExpected(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle];
}

export function evaluateSample(
  sample: MetricSample,
  threshold: Threshold,
  baseline: number[],
  policy: Policy,
): Evaluation | null {
  const absolute = absoluteSeverity(sample.value, threshold);
  const expected = baseline.length >= (threshold.minimumBaselineSamples ?? Number.POSITIVE_INFINITY)
    ? robustExpected(baseline)
    : undefined;
  const anomalous = expected !== undefined && expected > 0 && sample.value >= expected * (threshold.anomalyMultiplier ?? 8);
  const severity: Severity | null = absolute ?? (anomalous ? "warning" : null);
  if (!severity) return null;

  const estimatedSpend = sample.metric === "projected_daily_cost_usd" || sample.source === "billing" || sample.metric.endsWith("_cost_usd");
  const action = estimatedSpend
    ? policy.mode === "observe" ? "notify" : "prepare_stop"
    : controlAction(sample.asset, severity, policy);
  return {
    key: [sample.asset.accountId, sample.asset.family, sample.asset.id, sample.metric, threshold.windowMs].join(":"),
    asset: sample.asset,
    metric: sample.metric,
    severity,
    observed: sample.value,
    threshold: thresholdForSeverity(threshold, severity),
    expected,
    reason: anomalous && !absolute
      ? `${sample.metric} is ${formatMultiple(sample.value, expected)} above its robust baseline`
      : `${sample.metric} crossed the ${severity} hard threshold`,
    action,
  };
}

export function evaluateProjectedDailySpend(asset: AssetRef, usd: number, policy: Policy): Evaluation | null {
  const spendLimits = scopedSpendLimits(asset, policy) ?? policy.familyDailySpend?.[asset.family] ?? policy.accountDailySpend;
  const threshold: Threshold = { metric: "projected_daily_cost_usd", windowMs: 86_400_000, ...spendLimits };
  const severity = absoluteSeverity(usd, threshold);
  if (!severity) return null;
  return {
    key: `${asset.accountId}:${asset.family}:${asset.scope}:${asset.id}:projected_daily_cost_usd`, asset, metric: threshold.metric,
    severity, observed: usd, threshold: thresholdForSeverity(threshold, severity),
    reason: `Projected ${asset.family === "account" ? "monitored account" : asset.family} spend crossed the ${severity} threshold`,
    // GraphQL pricing is an estimate rather than an invoice-grade billing
    // measure. It may prepare an operator-reviewed action, but must never be
    // the sole signal for an automatic shutdown.
    action: policy.mode === "observe" ? "notify" : "prepare_stop",
  };
}

export function assetBudgetKey(asset: Pick<AssetRef, "family" | "scope" | "id">): string {
  return `${asset.family}:${asset.scope}:${asset.id}`;
}

function scopedSpendLimits(asset: AssetRef, policy: Policy): SpendLimits | undefined {
  const direct = policy.assetDailySpend?.[assetBudgetKey(asset)];
  if (direct) return direct;
  if (asset.family === "durable_objects" && asset.scope === "object" && asset.parentId) {
    return policy.assetDailySpend?.[assetBudgetKey({ family: asset.family, scope: "namespace", id: asset.parentId })];
  }
  return undefined;
}

function absoluteSeverity(value: number, threshold: Threshold): Severity | null {
  if (threshold.emergency !== undefined && value >= threshold.emergency) return "emergency";
  if (threshold.critical !== undefined && value >= threshold.critical) return "critical";
  if (threshold.warning !== undefined && value >= threshold.warning) return "warning";
  return null;
}

function thresholdForSeverity(threshold: Threshold, severity: Severity): number | undefined {
  return severity === "emergency" ? threshold.emergency : severity === "critical" ? threshold.critical : threshold.warning;
}

function controlAction(asset: AssetRef, severity: Severity, policy: Policy): Evaluation["action"] {
  if (asset.tier === "control_plane" || asset.tier === "critical" || asset.tier === "unclassified") return "notify";
  if (severity !== "emergency") return "notify";
  return policy.mode === "automatic" ? "stop" : policy.mode === "approval" ? "prepare_stop" : "notify";
}

function formatMultiple(value: number, expected: number): string {
  const multiple = expected === 0 ? Number.POSITIVE_INFINITY : value / expected;
  return Number.isFinite(multiple) ? `${multiple.toFixed(1)}x` : "infinitely";
}

export function highestSeverity(values: Severity[]): Severity {
  return values.reduce((best, value) => rank[value] > rank[best] ? value : best, "info");
}
