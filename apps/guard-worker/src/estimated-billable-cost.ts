import type { IncludedAllotment, PlanTier } from "./included-quota.js";

/**
 * The usage fields needed to derive the secondary cost series. The server's
 * usage-series points contain additional fields, so callers can pass them
 * through without adapting the values first.
 */
export interface EstimatedBillableUsagePoint {
  day: string;
  metrics: Readonly<Record<string, number>>;
}

export interface EstimatedBillableCostCycle {
  startsAt: number;
  endsAt: number;
}

export interface EstimatedBillableCostPoint {
  day: string;
  costUsd: number;
}

/**
 * Gross unit prices used by the existing Workers and Durable Objects
 * collectors in cloudflare.ts. These are deliberately keyed by the full
 * metric-definition ids used by the ledger. Only sum metrics with a
 * corresponding hardcoded collector rate are included; storage/max metrics
 * need a different time-based pricing model.
 */
export const ESTIMATED_BILLABLE_GROSS_RATES: Readonly<Record<string, number>> = {
  "workers:requests": 0.30 / 1_000_000,
  "workers:cpu_ms": 0.02 / 1_000_000,
  "durable_objects:requests": 0.15 / 1_000_000,
  "durable_objects:duration_gb_seconds": 12.50 / 1_000_000,
  "durable_objects:incoming_websocket_messages": (0.15 / 1_000_000) / 20,
  "durable_objects:rows_read": 0.001 / 1_000_000,
  "durable_objects:rows_written": 1 / 1_000_000,
  "durable_objects:kv_read_units": 0.20 / 1_000_000,
  "durable_objects:kv_write_units": 1 / 1_000_000,
  "durable_objects:kv_delete_requests": 1 / 1_000_000,
};

/**
 * Derive the daily cost attributable to usage above each metric's included
 * quantity. The included quantity is tracked independently for every metric
 * and reset at every billing-cycle boundary.
 *
 * `paid` and `unknown` use the regular paid-plan baseline. Free and Enterprise
 * plans have no supported list-rate estimate, so they return an empty series.
 * Authoritative billing costs remain the caller's responsibility.
 */
export function estimatedBillableCostSeries(
  points: readonly EstimatedBillableUsagePoint[],
  cycles: readonly EstimatedBillableCostCycle[],
  allotments: readonly IncludedAllotment[],
  planTier: PlanTier,
): EstimatedBillableCostPoint[] {
  if (planTier !== "paid" && planTier !== "unknown") return [];

  const includedByMetric = new Map<string, number>();
  for (const allotment of allotments) {
    if (Number.isFinite(allotment.includedPerCycle) && allotment.includedPerCycle >= 0) {
      includedByMetric.set(allotment.metricId, allotment.includedPerCycle);
    }
  }

  const orderedCycles = cycles
    .map((cycle, index) => ({ cycle, index }))
    .filter(({ cycle }) => Number.isFinite(cycle.startsAt) && Number.isFinite(cycle.endsAt) && cycle.endsAt > cycle.startsAt)
    .sort((left, right) => left.cycle.startsAt - right.cycle.startsAt || left.cycle.endsAt - right.cycle.endsAt || left.index - right.index);

  const orderedPoints = points
    .map((point, index) => ({ point, index }))
    .sort((left, right) => left.point.day.localeCompare(right.point.day) || left.index - right.index);
  const cycleUsage = new Map<number, Map<string, number>>();

  return orderedPoints.map(({ point }) => {
    const cycle = cycleForDay(orderedCycles, point.day);
    if (!cycle) return { day: point.day, costUsd: 0 };

    const usageByMetric = cycleUsage.get(cycle.index) ?? new Map<string, number>();
    cycleUsage.set(cycle.index, usageByMetric);
    let costUsd = 0;
    for (const [metricId, rawValue] of Object.entries(point.metrics)) {
      const included = includedByMetric.get(metricId);
      const grossRate = ESTIMATED_BILLABLE_GROSS_RATES[metricId];
      if (included === undefined || grossRate === undefined) continue;
      const value = Number.isFinite(rawValue) ? Math.max(0, rawValue) : 0;
      const previousUsage = usageByMetric.get(metricId) ?? 0;
      const currentUsage = previousUsage + value;
      const previousBillable = Math.max(0, previousUsage - included);
      const currentBillable = Math.max(0, currentUsage - included);
      costUsd += (currentBillable - previousBillable) * grossRate;
      usageByMetric.set(metricId, currentUsage);
    }
    return { day: point.day, costUsd };
  });
}

function cycleForDay(
  cycles: ReadonlyArray<{ cycle: EstimatedBillableCostCycle; index: number }>,
  day: string,
): { cycle: EstimatedBillableCostCycle; index: number } | null {
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  return cycles.find(({ cycle }) => timestamp >= cycle.startsAt && timestamp < cycle.endsAt) ?? null;
}
