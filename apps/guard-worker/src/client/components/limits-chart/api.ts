import { useEffect, useState } from "react";
import { api } from "../../api";
import type { CycleBounds, DayPoint } from "./cycles";
import type { PlanTier, PlanTierSource } from "../../types";

/** Mirror of the Worker's `GET /api/usage-series` response. */
export interface UsageSeriesResponse {
  scope: string;
  resourceId: string;
  found: boolean;
  today: string;
  metrics: Record<string, { key: string; label: string; unit: string; billable: boolean; includedPerCycle?: number }>;
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

export function billableCostSeries(data: UsageSeriesResponse): DayPoint[] {
  return cachedSeries(data, "billable-cost", () => {
    const sealedByDay = new Map(data.series.map(point => [point.day, point.sealed]));
    return (data.estimatedBillableCostSeries ?? []).map(point => ({ day: point.day, value: point.costUsd, sealed: sealedByDay.get(point.day) }));
  });
}

export function metricSeries(data: UsageSeriesResponse, metricId: string): DayPoint[] {
  return cachedSeries(data, `metric:${metricId}`, () => data.series.map(point => ({ day: point.day, value: point.metrics[metricId] ?? 0, sealed: point.sealed })));
}

/** Billable metric ids present in the series, most-used first. */
export function billableMetricIds(data: UsageSeriesResponse): string[] {
  const totals = new Map<string, number>();
  for (const point of data.series) for (const [id, value] of Object.entries(point.metrics)) totals.set(id, (totals.get(id) ?? 0) + value);
  return Object.entries(data.metrics)
    .filter(([, metric]) => metric.billable)
    .sort(([left], [right]) => (totals.get(right) ?? 0) - (totals.get(left) ?? 0))
    .map(([id]) => id);
}
