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
  fromDay?: string;
  metrics: Record<string, { key: string; label: string; unit: string; role?: "billable" | "shared_billing" | "quota" | "provider_cost"; productLimit?: boolean; billingKind?: "independent" | "shared" | "conditional" | "quota_only" | "announced" | "provider" | "none"; condition?: string; sharedBillingMetricId?: string; billable: boolean; includedPerCycle?: number; billedVia?: { metricId: string; ratio: number; label: string }; aggregationKind?: AggregationKind }>;
  series: Array<{ day: string; costUsd: number; metrics: Record<string, number>; sealed: boolean }>;
  coverage?: Record<string, CoverageSpan[]>;
  costCoverage?: CoverageSpan[];
  estimatedBillableCostSeries?: Array<{ day: string; costUsd: number }>;
  estimatedBillableCostByMetric?: Record<string, Array<{ day: string; costUsd: number }>>;
  cycles: Array<CycleBounds & { approximate: boolean }>;
  includedQuotaCatalogVersion?: string;
  planTier?: PlanTier;
  planTierSource?: PlanTierSource;
}

export type CoverageState = "measured" | "partial" | "pending" | "unavailable";
export interface CoverageSpan { fromDay: string; toDay: string; state: CoverageState; reason?: string }

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

export function useUsageSeries(token: string, scope: string, enabled = true): UsageSeriesState {
  const [state, setState] = useState<UsageSeriesState>({ data: null, loading: enabled, error: "" });
  useEffect(() => {
    if (!scope || !enabled) return;
    let cancelled = false;
    setState(current => ({ ...current, loading: true, error: "" }));
    api<UsageSeriesResponse>(`/api/usage-series?scope=${encodeURIComponent(scope)}`, token)
      .then(data => { if (!cancelled) setState({ data, loading: false, error: "" }); })
      .catch(cause => { if (!cancelled) setState({ data: null, loading: false, error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { cancelled = true; };
  }, [token, scope, enabled]);
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
  return cachedSeries(data, "cost", () => coveredSeries(
    data,
    data.costCoverage,
    point => point.costUsd,
  ));
}

/** Daily list-rate cost attributable to one billed usage meter. */
export function metricBillableCostSeries(data: UsageSeriesResponse, metricId: string): DayPoint[] | undefined {
  const series = data.estimatedBillableCostByMetric?.[metricId];
  if (!series) return undefined;
  return cachedSeries(data, `billable-cost:${metricId}`, () => series.map(point => ({ day: point.day, value: point.costUsd })));
}


export function metricSeries(data: UsageSeriesResponse, metricId: string): DayPoint[] {
  return cachedSeries(data, `metric:${metricId}`, () => coveredSeries(
    data,
    data.coverage?.[metricId],
    point => point.metrics[metricId],
  ));
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
  const memberSeries = members.map(member => ({ ...member, series: metricSeries(data, member.id) }));
  const series = cachedSeries(data, `pool:${metricId}`, () => memberSeries[0]!.series.map((point, index) => {
    const points = memberSeries.map(member => ({ member, point: member.series[index] }));
    const missing = points.some(item => item.point?.missing);
    return {
      day: point.day,
      value: points.reduce((sum, item) => sum + (item.point?.value ?? 0) * item.member.perUnit, 0) / selfPerUnit,
      sealed: points.every(item => item.point?.sealed),
      missing,
      coverage: missing ? weakestCoverage(points.map(item => item.point?.coverage)) : "measured",
    };
  }));
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
      series: cachedSeries(data, `part:${id}`, () => metricSeries(data, id).map(point => ({ ...point, value: point.value / metric.billedVia!.ratio }))),
    })),
  ];
}

/** The series a meter's row charts: the meter plus everything folded into it. */
export function rowSeries(data: UsageSeriesResponse, metricId: string): DayPoint[] {
  const parts = metricComposition(data, metricId);
  if (!parts) return metricSeries(data, metricId);
  return cachedSeries(data, `row:${metricId}`, () => parts[0]!.series.map((point, index) => {
    const values = parts.map(part => part.series[index]);
    const missing = values.some(value => value?.missing);
    return {
      day: point.day,
      value: values.reduce((sum, value) => sum + (value?.value ?? 0), 0),
      sealed: values.every(value => value?.sealed),
      missing,
      coverage: missing ? weakestCoverage(values.map(value => value?.coverage)) : "measured",
    };
  }));
}

function coveredSeries(
  data: UsageSeriesResponse,
  spans: CoverageSpan[] | undefined,
  read: (point: UsageSeriesResponse["series"][number]) => number | undefined,
): DayPoint[] {
  // Older fixtures remain sparse. Production responses carry an explicit
  // range and evidence spans.
  if (!data.fromDay || !spans) return data.series.map(point => ({ day: point.day, value: read(point) ?? 0, sealed: point.sealed }));
  const rows = new Map(data.series.map(point => [point.day, point]));
  const output: DayPoint[] = [];
  for (let at = Date.parse(`${data.fromDay}T00:00:00Z`); at <= Date.parse(`${data.today}T00:00:00Z`); at += 86_400_000) {
    const day = new Date(at).toISOString().slice(0, 10);
    const row = rows.get(day);
    const observed = row ? read(row) : undefined;
    const span = spans.find(item => item.fromDay <= day && item.toDay >= day);
    const coverage = span?.state ?? "unavailable";
    output.push({
      day,
      value: observed ?? 0,
      sealed: row?.sealed,
      coverage,
      coverageReason: span?.reason,
      missing: coverage === "pending" || coverage === "unavailable" || coverage === "partial" && observed === undefined,
    });
  }
  return output;
}

function weakestCoverage(values: Array<DayPoint["coverage"]>): DayPoint["coverage"] {
  if (values.includes("unavailable")) return "unavailable";
  if (values.includes("pending")) return "pending";
  if (values.includes("partial")) return "partial";
  return "measured";
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
export function limitMetricIds(data: UsageSeriesResponse): string[] {
  return Object.entries(data.metrics)
    .filter(([, metric]) => (metric.productLimit ?? metric.billable) && !metric.billedVia)
    .map(([id]) => id);
}

/** Compatibility name for callers that have not adopted the broader limit roles. */
export const billableMetricIds = limitMetricIds;
