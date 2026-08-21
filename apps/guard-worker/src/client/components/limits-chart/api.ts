import { useEffect, useState } from "react";
import { api } from "../../api";
import type { AggregationKind, CycleBounds, DayPoint } from "./cycles";
import type { PlanTier, PlanTierSource } from "../../types";

/** Mirror of the Worker's `GET /api/usage-series` response. */
export interface UsageSeriesResponse {
  scope: string;
  resourceId: string;
  found: boolean;
  today: string;
  metrics: Record<string, { key: string; label: string; unit: string; billable: boolean; includedPerCycle?: number; billedVia?: { metricId: string; ratio: number; label: string }; aggregationKind?: AggregationKind }>;
  series: Array<{ day: string; costUsd: number; metrics: Record<string, number>; sealed: boolean }>;
  estimatedBillableCostSeries?: Array<{ day: string; costUsd: number }>;
  cycles: Array<CycleBounds & { approximate: boolean }>;
  includedQuotaCatalogVersion?: string;
  planTier?: PlanTier;
  planTierSource?: PlanTierSource;
}

export interface UsageSeriesState {
  data: UsageSeriesResponse | null;
  loading: boolean;
  error: string;
}

/** Scope key for a policy map entry: account, one family, or one scoped asset. */
export function scopeKey(target: { kind: "account" } | { kind: "family"; family: string } | { kind: "asset"; key: string }): string {
  if (target.kind === "account") return "account";
  if (target.kind === "family") return `family:${target.family}`;
  return `asset:${target.key}`;
}

export function useUsageSeries(token: string, scope: string): UsageSeriesState {
  const [state, setState] = useState<UsageSeriesState>({ data: null, loading: true, error: "" });
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setState(current => ({ ...current, loading: true, error: "" }));
    api<UsageSeriesResponse>(`/api/usage-series?scope=${encodeURIComponent(scope)}`, token)
      .then(data => { if (!cancelled) setState({ data, loading: false, error: "" }); })
      .catch(cause => { if (!cancelled) setState({ data: null, loading: false, error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { cancelled = true; };
  }, [token, scope]);
  return state;
}

// Derived per-day series are cached per response object. Charts, defaults,
// and deviation checks ask for the same series dozens of times per render
// pass; stable array identities also let downstream memo caches hit.
const seriesCache = new WeakMap<UsageSeriesResponse, Map<string, DayPoint[]>>();

function cachedSeries(data: UsageSeriesResponse, key: string, build: () => DayPoint[]): DayPoint[] {
  let byKey = seriesCache.get(data);
  if (!byKey) { byKey = new Map(); seriesCache.set(data, byKey); }
  let series = byKey.get(key);
  if (!series) { series = build(); byKey.set(key, series); }
  return series;
}

export function costSeries(data: UsageSeriesResponse): DayPoint[] {
  return cachedSeries(data, "cost", () => data.series.map(point => ({ day: point.day, value: point.costUsd, sealed: point.sealed })));
}


export function metricSeries(data: UsageSeriesResponse, metricId: string): DayPoint[] {
  return cachedSeries(data, `metric:${metricId}`, () => data.series.map(point => ({ day: point.day, value: point.metrics[metricId] ?? 0, sealed: point.sealed })));
}

/**
 * A shared-allotment pool as seen from one metric: the allotment and the
 * pool's total usage, both in that metric's units. WebSocket messages bill
 * into the Durable Objects request meter at 20:1, so the message row sees a
 * 20M-message allotment drained by messages plus 20× every direct request,
 * and the request row sees its 1M allotment drained by requests plus
 * messages ÷ 20. Metrics that share nothing return undefined.
 */
export interface MetricPool { includedPerCycle: number; series: DayPoint[] }

export function metricPool(data: UsageSeriesResponse, metricId: string): MetricPool | undefined {
  const metric = data.metrics[metricId];
  if (!metric) return undefined;
  const poolId = metric.billedVia?.metricId ?? metricId;
  const included = data.metrics[poolId]?.includedPerCycle;
  if (!(typeof included === "number" && included > 0)) return undefined;
  // Every member of the pool with its weight in pool (target) units.
  const members = Object.entries(data.metrics)
    .filter(([id, item]) => id === poolId || item.billedVia?.metricId === poolId)
    .map(([id, item]) => ({ id, perUnit: id === poolId ? 1 : 1 / item.billedVia!.ratio }));
  if (members.length < 2) return undefined;
  const selfPerUnit = members.find(member => member.id === metricId)!.perUnit;
  const series = cachedSeries(data, `pool:${metricId}`, () => data.series.map(point => ({
    day: point.day,
    value: members.reduce((sum, member) => sum + (point.metrics[member.id] ?? 0) * member.perUnit, 0) / selfPerUnit,
    sealed: point.sealed,
  })));
  return { includedPerCycle: included / selfPerUnit, series };
}

/** One part of a meter's composition, in the meter's units. */
export interface MetricPart { id: string; label: string; series: DayPoint[] }

/**
 * Composition of a meter that absorbs other metrics: the meter itself first,
 * then each folded source converted to the meter's units. Undefined for a
 * meter nothing bills into.
 */
export function metricComposition(data: UsageSeriesResponse, metricId: string): MetricPart[] | undefined {
  const sources = Object.entries(data.metrics).filter(([, metric]) => metric.billedVia?.metricId === metricId);
  if (!sources.length) return undefined;
  return [
    { id: metricId, label: data.metrics[metricId]?.label ?? metricId, series: metricSeries(data, metricId) },
    ...sources.map(([id, metric]) => ({
      id,
      label: `${metric.label} ÷ ${metric.billedVia!.ratio}`,
      series: cachedSeries(data, `part:${id}`, () => data.series.map(point => ({ day: point.day, value: (point.metrics[id] ?? 0) / metric.billedVia!.ratio, sealed: point.sealed }))),
    })),
  ];
}

/** The series a meter's row charts: the meter plus everything folded into it. */
export function rowSeries(data: UsageSeriesResponse, metricId: string): DayPoint[] {
  const parts = metricComposition(data, metricId);
  if (!parts) return metricSeries(data, metricId);
  return cachedSeries(data, `row:${metricId}`, () => data.series.map((point, index) => ({
    day: point.day,
    value: parts.reduce((sum, part) => sum + (part.series[index]?.value ?? 0), 0),
    sealed: point.sealed,
  })));
}

/** Included allotment for a metric: its own, or its share of a pool in its units. */
export function metricIncluded(data: UsageSeriesResponse, metricId: string): number | undefined {
  const pool = metricPool(data, metricId);
  if (pool) return pool.includedPerCycle;
  const included = data.metrics[metricId]?.includedPerCycle;
  return typeof included === "number" && Number.isFinite(included) && included > 0 ? included : undefined;
}

/** Aggregation semantics for a metric. Legacy responses use additive totals. */
export function metricAggregationKind(data: UsageSeriesResponse, metricId: string): AggregationKind {
  const kind = data.metrics[metricId]?.aggregationKind;
  return kind === "maximum" || kind === "latest" ? kind : "sum";
}

/**
 * Billable metric ids present in the series, most-used first. A metric that
 * bills into another meter (WebSocket messages into Durable Objects requests)
 * is folded into that meter's row and never listed on its own.
 */
export function billableMetricIds(data: UsageSeriesResponse): string[] {
  const totals = new Map<string, number>();
  for (const point of data.series) for (const [id, value] of Object.entries(point.metrics)) totals.set(id, (totals.get(id) ?? 0) + value);
  return Object.entries(data.metrics)
    .filter(([, metric]) => metric.billable && !metric.billedVia)
    .sort(([left], [right]) => (totals.get(right) ?? 0) - (totals.get(left) ?? 0))
    .map(([id]) => id);
}
