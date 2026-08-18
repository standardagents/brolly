import { resourceId } from "@standardagents/brolly-core";

/**
 * Daily cost and usage series for one policy scope, read from the ledger the
 * backfill and monitor already wrote. Powers the limits chart in onboarding
 * and settings. No Cloudflare API calls.
 *
 * Scope keys match the policy maps:
 *   `account`                      → whole account
 *   `family:<family>`              → one product family
 *   `asset:<family>:<scope>:<id>`  → one scoped asset (assetBudgetKey)
 */
export interface UsageSeriesPoint {
  day: string;
  costUsd: number;
  metrics: Record<string, number>;
  sealed: boolean;
}

export interface UsageSeriesResponse {
  scope: string;
  resourceId: string;
  found: boolean;
  today: string;
  /** Metric id → { key, label, unit } for the metrics present in the series. */
  metrics: Record<string, { key: string; label: string; unit: string; billable: boolean }>;
  series: UsageSeriesPoint[];
  cycles: Array<{ startsAt: number; endsAt: number; approximate: boolean }>;
}

export function scopeResourceId(accountId: string, scope: string): string | null {
  if (scope === "account") return resourceId(accountId, "account", "account", accountId);
  const family = scope.match(/^family:([^:]+)$/);
  if (family) return resourceId(accountId, family[1]!, "product", family[1]!);
  const asset = scope.match(/^asset:([^:]+):([^:]+):(.+)$/);
  if (asset) return resourceId(accountId, asset[1]!, `${asset[1]}:${asset[2]}`, asset[3]!);
  return null;
}

export async function usageSeriesResponse(db: D1Database, accountId: string, url: URL, now = Date.now()): Promise<Response> {
  const scope = url.searchParams.get("scope") ?? "account";
  const id = scopeResourceId(accountId, scope);
  if (!id) return Response.json({ error: "scope must be account, family:<family>, or asset:<family>:<scope>:<id>" }, { status: 400 });
  const days = Math.min(400, Math.max(1, Number(url.searchParams.get("days") ?? 120)));
  const today = new Date(now).toISOString().slice(0, 10);
  const from = new Date(now - days * 86_400_000).toISOString().slice(0, 10);

  const [resource, daily, shards, definitions, cycles] = await Promise.all([
    db.prepare(`SELECT id,product_family FROM resources WHERE id=?1 LIMIT 1`).bind(id).first<{ id: string; product_family: string }>(),
    db.prepare(
      `SELECT local_day,metrics_json,estimated_cost_usd,authoritative_allocated_cost_usd,sealed
       FROM usage_daily WHERE resource_id=?1 AND local_day>=?2 AND local_day<=?3 ORDER BY local_day ASC`,
    ).bind(id, from, today).all<{ local_day: string; metrics_json: string; estimated_cost_usd: number | null; authoritative_allocated_cost_usd: number | null; sealed: number }>(),
    db.prepare(
      `SELECT local_day,payload_json FROM usage_accumulator_shards
       WHERE account_id=?1 AND local_day>=?2 AND local_day<=?3
         AND (json_extract(payload_json,'$.sealedAt') IS NULL OR updated_at>json_extract(payload_json,'$.sealedAt'))`,
    ).bind(accountId, from, today).all<{ local_day: string; payload_json: string }>(),
    db.prepare(`SELECT id,metric_key,display_name,unit,billing_mapping FROM metric_definitions WHERE active=1`).all<{ id: string; metric_key: string; display_name: string; unit: string; billing_mapping: string | null }>(),
    db.prepare(`SELECT starts_at,ends_at,approximate FROM billing_cycles WHERE account_id=?1 AND ends_at>=?2 ORDER BY starts_at ASC`)
      .bind(accountId, now - (days + 31) * 86_400_000).all<{ starts_at: number; ends_at: number; approximate: number }>(),
  ]);

  const byDay = new Map<string, UsageSeriesPoint>();
  for (const row of daily.results) {
    byDay.set(row.local_day, {
      day: row.local_day,
      costUsd: Number(row.authoritative_allocated_cost_usd ?? row.estimated_cost_usd ?? 0),
      metrics: parseNumberMap(row.metrics_json),
      sealed: Number(row.sealed) === 1,
    });
  }
  // Unsealed days (today, and any day the sealer has not reached) live in the
  // accumulator shards; merge them so the chart ends at today.
  for (const shard of shards.results) {
    const entry = accumulatorEntry(shard.payload_json, id);
    if (!entry) continue;
    const existing = byDay.get(shard.local_day);
    if (existing?.sealed) continue;
    const point = existing ?? { day: shard.local_day, costUsd: 0, metrics: {}, sealed: false };
    for (const [metric, value] of Object.entries(entry)) {
      point.metrics[metric] = (point.metrics[metric] ?? 0) + value.day;
      point.costUsd += value.estimatedDayUsd;
    }
    byDay.set(shard.local_day, point);
  }
  const series = [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day));
  const present = new Set(series.flatMap(point => Object.keys(point.metrics)));
  const metrics = Object.fromEntries(definitions.results
    .filter(definition => present.has(definition.id))
    .map(definition => [definition.id, { key: definition.metric_key, label: definition.display_name, unit: definition.unit, billable: Boolean(definition.billing_mapping) }]));

  const body: UsageSeriesResponse = {
    scope, resourceId: id, found: Boolean(resource), today, metrics, series,
    cycles: cycles.results.map(cycle => ({ startsAt: cycle.starts_at, endsAt: cycle.ends_at, approximate: cycle.approximate === 1 })),
  };
  return Response.json(body);
}

function parseNumberMap(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed ?? {}).filter(([, item]) => typeof item === "number" && Number.isFinite(item))) as Record<string, number>;
  } catch { return {}; }
}

function accumulatorEntry(payload: string, id: string): Record<string, { day: number; estimatedDayUsd: number }> | null {
  try {
    const parsed = JSON.parse(payload) as { resources?: Record<string, { metrics?: Record<string, { day?: number; estimatedDayUsd?: number }> }> };
    const metrics = parsed.resources?.[id]?.metrics;
    if (!metrics) return null;
    return Object.fromEntries(Object.entries(metrics).map(([metric, item]) => [metric, { day: Number(item.day ?? 0), estimatedDayUsd: Number(item.estimatedDayUsd ?? 0) }]));
  } catch { return null; }
}
