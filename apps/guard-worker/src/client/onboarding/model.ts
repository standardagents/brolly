import type { AlertLevel, FixedSpendLimits, OnboardingData, Policy, SpendLimits, Threshold } from "../types";

export const LIMIT_ROWS = [
  { metric: "projected_daily_cost_usd", windowMs: 86_400_000, label: "Projected cost per Durable Object", unit: "USD / day", defaults: [0.5, 2, 5] },
  { metric: "rows_read", windowMs: 300_000, label: "Rows read per Durable Object", unit: "rows / 5 min", defaults: [1_000_000, 2_500_000, 5_000_000] },
  { metric: "rows_written", windowMs: 300_000, label: "Rows written per Durable Object", unit: "rows / 5 min", defaults: [5_000, 12_500, 25_000] },
  { metric: "rows_read", windowMs: 86_400_000, label: "Daily rows read per Durable Object", unit: "rows / 24 hr", defaults: [25_000_000, 50_000_000, 100_000_000] },
  { metric: "rows_written", windowMs: 86_400_000, label: "Daily rows written per Durable Object", unit: "rows / 24 hr", defaults: [125_000, 250_000, 500_000] },
] as const;

export type LimitRow = typeof LIMIT_ROWS[number];
export type RuntimeIntegration = { workerScript: string; installed: boolean };

const DEFAULT_ALERT_LEVELS: AlertLevel[] = [
  { id: "warning", position: 0, label: "Warning", entries: [] },
  { id: "critical", position: 1, label: "Critical", entries: [] },
  { id: "emergency", position: 2, label: "Emergency", entries: [] },
];

const DEFAULT_SPEND_LIMITS: FixedSpendLimits = { warning: 1, critical: 5, emergency: 10 };

/**
 * Convert the estimate endpoint's fixed three-value response to the current
 * ordered level IDs. Extra levels inherit the highest suggested value.
 */
export function mapFixedSpendLimits(limits: FixedSpendLimits, levels: AlertLevel[]): SpendLimits {
  const values = [limits.warning, limits.critical, limits.emergency];
  return Object.fromEntries(levels.map((level, index) => [level.id, values[Math.min(index, values.length - 1)] ?? 0]));
}

/** Fill missing level IDs while preserving values currently keyed by those IDs. */
export function ensureSpendLimits(value: SpendLimits | undefined, levels: AlertLevel[], defaults: FixedSpendLimits | SpendLimits = DEFAULT_SPEND_LIMITS): SpendLimits {
  const fallback = [
    typeof defaults.warning === "number" ? defaults.warning : 1,
    typeof defaults.critical === "number" ? defaults.critical : 5,
    typeof defaults.emergency === "number" ? defaults.emergency : 10,
  ];
  return Object.fromEntries(levels.map((level, index) => {
    const existing = value?.[level.id];
    const next = typeof existing === "number" && Number.isFinite(existing)
      ? existing
      : fallback[Math.min(index, fallback.length - 1)] ?? 0;
    return [level.id, next];
  }));
}

export function preparePolicy(policy: Policy, families: string[], scopedAssets: OnboardingData["scopedAssets"], levels: AlertLevel[] = DEFAULT_ALERT_LEVELS): Policy {
  const next = structuredClone(policy);
  next.accountDailySpend = ensureSpendLimits(next.accountDailySpend, levels, { warning: 5, critical: 12.5, emergency: 25 });
  next.familyDailySpend ??= {};
  next.assetDailySpend ??= {};
  for (const family of families) {
    next.familyDailySpend[family] = ensureSpendLimits(next.familyDailySpend[family], levels);
  }
  for (const asset of scopedAssets) {
    next.assetDailySpend[asset.key] = ensureSpendLimits(next.assetDailySpend[asset.key], levels, next.familyDailySpend[asset.family]);
  }
  for (const row of LIMIT_ROWS) next.thresholds = replaceThreshold(next.thresholds, findThreshold(next, row.metric, row.windowMs, row.defaults));
  return next;
}
export function prepareRuntimeIntegrations(assets: OnboardingData["scopedAssets"]): Record<string, RuntimeIntegration> {
  return Object.fromEntries(assets.map(asset => [asset.key, {
    workerScript: asset.tags.cloudflareWorkerScript ?? (asset.family === "workers" ? asset.id : ""),
    installed: asset.tags.brollyFuse === "true",
  }]));
}

export function findThreshold(policy: Policy, metric: string, windowMs: number, defaults: readonly number[]): Threshold {
  const existing = policy.thresholds.find(item => item.metric === metric && item.windowMs === windowMs);
  return {
    ...existing,
    metric,
    windowMs,
    warning: existing?.warning ?? defaults[0],
    critical: existing?.critical ?? defaults[1],
    emergency: existing?.emergency ?? defaults[2],
  };
}

export function replaceThreshold(thresholds: Threshold[], next: Threshold): Threshold[] {
  const found = thresholds.some(item => item.metric === next.metric && item.windowMs === next.windowMs);
  return found
    ? thresholds.map(item => item.metric === next.metric && item.windowMs === next.windowMs ? next : item)
    : [...thresholds, next];
}
