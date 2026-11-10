import type { CoverageResult, LedgerRunBudget } from "@standardagents/brolly-core";
import { PRODUCT_USAGE_DEFINITIONS } from "./product-usage.js";

export type StoredCoverageState = "measured" | "partial" | "unavailable";
export type ChartCoverageState = StoredCoverageState | "pending";

export interface CoverageIntervalInput {
  accountId: string;
  dataset: string;
  scopeKey?: string;
  startsAt: number;
  endsAt: number;
  state: StoredCoverageState;
  reason?: string;
  recordedAt?: number;
}

export interface CoverageIntervalRow {
  dataset: string;
  scope_key: string;
  starts_at: number;
  ends_at: number;
  state: StoredCoverageState;
  reason: string | null;
  recorded_at: number;
}

export interface CoverageSpan {
  fromDay: string;
  toDay: string;
  state: ChartCoverageState;
  reason?: string;
}

export interface MetricDatasetGroup {
  /** One of these datasets can satisfy this required source group. */
  alternatives: string[];
  root: "account" | "zone";
}

const SPECIAL_METRIC_SOURCES: Record<string, MetricDatasetGroup[]> = {
  "billing:authoritative_usage": [{ alternatives: ["billable-usage"], root: "account" }],
  "workers:requests": [{ alternatives: [metricCoverageDataset("workersInvocationsAdaptive", "requests")], root: "account" }],
  "workers:cpu_ms": [{ alternatives: [metricCoverageDataset("workersInvocationsAdaptive", "cpu_ms")], root: "account" }],
  "workers:cache_requests": [{ alternatives: ["billable-usage"], root: "account" }],
  "durable_objects:requests": [{ alternatives: [metricCoverageDataset("durableObjectsInvocationsAdaptiveGroups", "requests")], root: "account" }],
  "durable_objects:duration_gb_seconds": [{ alternatives: [metricCoverageDataset("durableObjectsPeriodicGroups", "duration_gb_seconds")], root: "account" }],
  "durable_objects:incoming_websocket_messages": [
    { alternatives: [metricCoverageDataset("durableObjectsInvocationsAdaptiveGroups", "incoming_websocket_messages")], root: "account" },
    { alternatives: [metricCoverageDataset("durableObjectsPeriodicGroups", "incoming_websocket_messages")], root: "account" },
  ],
  "durable_objects:rows_read": [{ alternatives: [metricCoverageDataset("durableObjectsPeriodicGroups", "rows_read")], root: "account" }],
  "durable_objects:rows_written": [{ alternatives: [metricCoverageDataset("durableObjectsPeriodicGroups", "rows_written")], root: "account" }],
  "durable_objects:kv_read_units": [{ alternatives: [metricCoverageDataset("durableObjectsPeriodicGroups", "kv_read_units")], root: "account" }],
  "durable_objects:kv_write_units": [{ alternatives: [metricCoverageDataset("durableObjectsPeriodicGroups", "kv_write_units")], root: "account" }],
  "durable_objects:kv_delete_requests": [{ alternatives: [metricCoverageDataset("durableObjectsPeriodicGroups", "kv_delete_requests")], root: "account" }],
  "durable_objects:sql_storage_bytes": [{ alternatives: [metricCoverageDataset("durableObjectsSqlStorageGroups", "sql_storage_bytes")], root: "account" }],
  "durable_objects:kv_storage_bytes": [{ alternatives: [metricCoverageDataset("durableObjectsStorageGroups", "kv_storage_bytes")], root: "account" }],
};

export function metricCoverageDataset(dataset: string, metric: string): string {
  return `${dataset}#${metric}`;
}

const PRODUCT_METRIC_SOURCES = new Map<string, MetricDatasetGroup[]>();
for (const product of PRODUCT_USAGE_DEFINITIONS) {
  for (const source of product.datasets) {
    for (const metric of source.metrics) {
      const id = `${product.family}:${metric.metric}`;
      const groups = PRODUCT_METRIC_SOURCES.get(id) ?? [];
      if (source.fallbackFor) {
        const preferred = metricCoverageDataset(source.fallbackFor, metric.metric);
        const fallback = metricCoverageDataset(source.dataset, metric.metric);
        const group = groups.find(item => item.alternatives.includes(preferred));
        if (group) group.alternatives.push(fallback);
        else groups.push({ alternatives: [preferred, fallback], root: source.root ?? "account" });
      } else {
        const dataset = metricCoverageDataset(source.dataset, metric.metric);
        if (!groups.some(item => item.alternatives.includes(dataset))) groups.push({ alternatives: [dataset], root: source.root ?? "account" });
      }
      PRODUCT_METRIC_SOURCES.set(id, groups);
    }
  }
  for (const metric of product.billingOnlyMetrics) {
    PRODUCT_METRIC_SOURCES.set(`${product.family}:${metric}`, [{ alternatives: ["billable-usage"], root: "account" }]);
  }
}

export function metricDatasetGroups(metricId: string): MetricDatasetGroup[] {
  return SPECIAL_METRIC_SOURCES[metricId] ?? PRODUCT_METRIC_SOURCES.get(metricId) ?? [];
}

export async function coverageSpansForMetrics(
  db: D1Database,
  accountId: string,
  metricIds: string[],
  fromDay: string,
  toDay: string,
  scope: string,
): Promise<Record<string, CoverageSpan[]>> {
  const startsAt = Date.parse(`${fromDay}T00:00:00Z`);
  const endsAt = Date.parse(`${toDay}T00:00:00Z`) + 86_400_000;
  const intervals = await db.prepare(
    `SELECT dataset,scope_key,starts_at,ends_at,state,reason,recorded_at
     FROM coverage_intervals WHERE account_id=?1 AND starts_at<?3 AND ends_at>?2
     ORDER BY recorded_at DESC`,
  ).bind(accountId, startsAt, endsAt).all<CoverageIntervalRow>();
  const active = await db.prepare(
    `SELECT scope_key,starts_at,ends_at FROM backfill_slices
     WHERE status IN ('pending','running') AND starts_at<?3 AND ends_at>?2
       AND backfill_job_id IN (SELECT id FROM backfill_jobs WHERE account_id=?1)`,
  ).bind(accountId, startsAt, endsAt).all<{ scope_key: string; starts_at: number; ends_at: number }>();
  const pending = active.results.flatMap(row => {
    try {
      const parsed = JSON.parse(row.scope_key) as { dataset?: unknown; zoneIds?: unknown };
      if (typeof parsed.dataset !== "string") return [];
      const zoneIds = Array.isArray(parsed.zoneIds)
        ? parsed.zoneIds.filter((item): item is string => typeof item === "string")
        : [];
      return [{ dataset: parsed.dataset, scopeKeys: zoneIds.length ? zoneIds : [""], startsAt: row.starts_at, endsAt: row.ends_at }];
    } catch { return []; }
  });
  const requestedZone = zoneIdFromScope(scope);
  return Object.fromEntries(metricIds.map(metricId => {
    const groups = metricDatasetGroups(metricId);
    const days: Array<{ day: string; state: ChartCoverageState; reason?: string }> = [];
    for (let at = startsAt; at < endsAt; at += 86_400_000) {
      const day = new Date(at).toISOString().slice(0, 10);
      const groupStates = groups.map(group => groupState(group, at, at + 86_400_000, intervals.results, pending, requestedZone));
      days.push({ day, ...combineRequired(groupStates) });
    }
    return [metricId, compactCoverage(days)];
  }));
}

export function combineCoverageSpans(
  coverage: Record<string, CoverageSpan[]>,
  metricIds: string[],
  fromDay: string,
  toDay: string,
): CoverageSpan[] {
  const days: Array<{ day: string; state: ChartCoverageState; reason?: string }> = [];
  for (let at = Date.parse(`${fromDay}T00:00:00Z`); at <= Date.parse(`${toDay}T00:00:00Z`); at += 86_400_000) {
    const day = new Date(at).toISOString().slice(0, 10);
    const values = metricIds.map(metricId => {
      const span = coverage[metricId]?.find(item => item.fromDay <= day && item.toDay >= day);
      return span ? { state: span.state, reason: span.reason } : { state: "unavailable" as const };
    });
    days.push({ day, ...combineRequired(values) });
  }
  return compactCoverage(days);
}

export function alternativeCoverageSpans(
  alternatives: CoverageSpan[][],
  fromDay: string,
  toDay: string,
): CoverageSpan[] {
  const days: Array<{ day: string; state: ChartCoverageState; reason?: string }> = [];
  for (let at = Date.parse(`${fromDay}T00:00:00Z`); at <= Date.parse(`${toDay}T00:00:00Z`); at += 86_400_000) {
    const day = new Date(at).toISOString().slice(0, 10);
    const values = alternatives.map(spans => spans.find(item => item.fromDay <= day && item.toDay >= day))
      .filter((item): item is CoverageSpan => Boolean(item));
    const measured = values.find(item => item.state === "measured");
    const partial = values.find(item => item.state === "partial");
    const pending = values.find(item => item.state === "pending");
    const unavailable = values.find(item => item.state === "unavailable");
    const selected = measured ?? partial ?? pending ?? unavailable
      ?? { state: "unavailable" as const, reason: "No cost evidence was recorded for this interval." };
    days.push({ day, state: selected.state, ...(selected.reason ? { reason: selected.reason } : {}) });
  }
  return compactCoverage(days);
}

export function coverageStateFromResults(results: CoverageResult[]): StoredCoverageState {
  if (!results.length) return "unavailable";
  if (results.every(item => item.state === "healthy")) return "measured";
  if (results.some(item => item.state === "healthy" || item.state === "delayed")) return "partial";
  return "unavailable";
}

/** Persist positive or negative dataset evidence independently from samples. */
export async function saveCoverageInterval(
  db: D1Database,
  value: CoverageIntervalInput,
  budget?: LedgerRunBudget,
): Promise<void> {
  if (!(value.endsAt > value.startsAt)) return;
  const scopeKey = value.scopeKey ?? "";
  const reason = value.reason?.slice(0, 2_000) ?? null;
  const recordedAt = value.recordedAt ?? Date.now();
  // The normal forward-monitor path extends one interval in place. Historical
  // slices can remain as a few adjacent rows and are compacted in API output.
  const extended = await db.prepare(
    `UPDATE coverage_intervals SET ends_at=?6,recorded_at=?7
     WHERE account_id=?1 AND dataset=?2 AND scope_key=?3 AND ends_at=?4
       AND state=?5 AND COALESCE(reason,'')=COALESCE(?8,'')`,
  ).bind(
    value.accountId, value.dataset, scopeKey, value.startsAt, value.state,
    value.endsAt, recordedAt, reason,
  ).run();
  chargeMeta(budget, extended.meta);
  if (Number(extended.meta.changes ?? 0) > 0) return;
  const inserted = await db.prepare(
    `INSERT INTO coverage_intervals(
       account_id,dataset,scope_key,starts_at,ends_at,state,reason,recorded_at
     ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
     ON CONFLICT(account_id,dataset,scope_key,starts_at) DO UPDATE SET
       ends_at=excluded.ends_at,state=excluded.state,reason=excluded.reason,recorded_at=excluded.recorded_at`,
  ).bind(
    value.accountId, value.dataset, scopeKey, value.startsAt, value.endsAt,
    value.state, reason, recordedAt,
  ).run();
  chargeMeta(budget, inserted.meta);
}

export async function saveCoverageIntervals(
  db: D1Database,
  values: CoverageIntervalInput[],
  budget?: LedgerRunBudget,
): Promise<void> {
  for (const value of values) await saveCoverageInterval(db, value, budget);
}

function chargeMeta(budget: LedgerRunBudget | undefined, meta: { rows_read?: number; rows_written?: number; changes?: number }): void {
  if (!budget) return;
  budget.charge("d1RowsRead", Number(meta.rows_read ?? 0));
  budget.charge("d1RowsWritten", Number(meta.rows_written ?? meta.changes ?? 0));
}

interface PendingInterval { dataset: string; scopeKeys: string[]; startsAt: number; endsAt: number }
interface DayCoverage { state: ChartCoverageState; reason?: string }

function groupState(
  group: MetricDatasetGroup,
  startsAt: number,
  endsAt: number,
  intervals: CoverageIntervalRow[],
  pending: PendingInterval[],
  requestedZone: string | null,
): DayCoverage {
  const scopes = group.root === "account"
    ? [""]
    : requestedZone
      ? [requestedZone]
      : [...new Set([
        ...intervals.filter(row => group.alternatives.some(alternative => coverageDatasetBase(alternative) === coverageDatasetBase(row.dataset)) && row.scope_key).map(row => row.scope_key),
        ...pending.filter(row => group.alternatives.some(alternative => coverageDatasetBase(alternative) === row.dataset)).flatMap(row => row.scopeKeys).filter(Boolean),
      ])];
  if (!scopes.length) return { state: "unavailable", reason: "Cloudflare did not expose coverage for this dataset." };
  const partitions = scopes.map(scopeKey => {
    const exactCandidates = intervals.filter(row => group.alternatives.includes(row.dataset)
      && row.scope_key === scopeKey && row.starts_at < endsAt && row.ends_at > startsAt);
    const candidates = exactCandidates.length ? exactCandidates : intervals.filter(row => group.alternatives.some(alternative => coverageDatasetBase(alternative) === row.dataset)
      && row.scope_key === scopeKey && row.starts_at < endsAt && row.ends_at > startsAt);
    const active = pending.some(row => group.alternatives.some(alternative => coverageDatasetBase(alternative) === row.dataset)
      && row.scopeKeys.includes(scopeKey) && row.startsAt < endsAt && row.endsAt > startsAt);
    const measured = candidates.find(row => row.state === "measured");
    if (measured) return { state: "measured" as const };
    const partial = candidates.find(row => row.state === "partial");
    if (partial) return { state: "partial" as const, reason: partial.reason ?? undefined };
    if (active) return { state: "pending" as const };
    const unavailable = candidates.find(row => row.state === "unavailable");
    return unavailable
      ? { state: "unavailable" as const, reason: unavailable.reason ?? undefined }
      : { state: "unavailable" as const, reason: "No collection evidence was recorded for this interval." };
  });
  return combinePartitions(partitions);
}

function coverageDatasetBase(dataset: string): string {
  const separator = dataset.indexOf("#");
  return separator < 0 ? dataset : dataset.slice(0, separator);
}

function combinePartitions(values: DayCoverage[]): DayCoverage {
  if (values.every(value => value.state === "measured")) return { state: "measured" };
  if (values.some(value => value.state === "pending")) return { state: "pending" };
  if (values.some(value => value.state === "measured" || value.state === "partial")) {
    return { state: "partial", reason: firstReason(values) };
  }
  return { state: "unavailable", reason: firstReason(values) };
}

function combineRequired(values: DayCoverage[]): DayCoverage {
  if (!values.length) return { state: "unavailable", reason: "This metric has no collection source." };
  if (values.every(value => value.state === "measured")) return { state: "measured" };
  if (values.some(value => value.state === "pending")) return { state: "pending" };
  if (values.some(value => value.state === "partial")
    || values.some(value => value.state === "measured") && values.some(value => value.state === "unavailable")) {
    return { state: "partial", reason: firstReason(values) };
  }
  return { state: "unavailable", reason: firstReason(values) };
}

function compactCoverage(days: Array<{ day: string; state: ChartCoverageState; reason?: string }>): CoverageSpan[] {
  const spans: CoverageSpan[] = [];
  for (const day of days) {
    const previous = spans.at(-1);
    if (previous && previous.state === day.state && previous.reason === day.reason) previous.toDay = day.day;
    else spans.push({ fromDay: day.day, toDay: day.day, state: day.state, ...(day.reason ? { reason: day.reason } : {}) });
  }
  return spans;
}

function firstReason(values: DayCoverage[]): string | undefined {
  return values.find(value => value.reason)?.reason;
}

function zoneIdFromScope(scope: string): string | null {
  const match = scope.match(/^asset:[^:]+:zone:(.+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
