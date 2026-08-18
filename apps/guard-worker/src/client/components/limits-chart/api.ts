import { useEffect, useState } from "react";
import { api } from "../../api";
import type { CycleBounds, DayPoint } from "./cycles";

/** Mirror of the Worker's `GET /api/usage-series` response. */
export interface UsageSeriesResponse {
  scope: string;
  resourceId: string;
  found: boolean;
  today: string;
  metrics: Record<string, { key: string; label: string; unit: string; billable: boolean }>;
  series: Array<{ day: string; costUsd: number; metrics: Record<string, number>; sealed: boolean }>;
  cycles: Array<CycleBounds & { approximate: boolean }>;
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

export function costSeries(data: UsageSeriesResponse): DayPoint[] {
  return data.series.map(point => ({ day: point.day, value: point.costUsd, sealed: point.sealed }));
}

export function metricSeries(data: UsageSeriesResponse, metricId: string): DayPoint[] {
  return data.series.map(point => ({ day: point.day, value: point.metrics[metricId] ?? 0, sealed: point.sealed }));
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
