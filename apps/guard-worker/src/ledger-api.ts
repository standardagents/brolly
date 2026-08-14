import type { AlertLine, AlertRule, LedgerRunLimits } from "@standardagents/brolly-core";
import { silenceAlertInstance } from "./alert-engine.js";
import type { Env } from "./env.js";
import {
  DEFAULT_LEDGER_RUN_LIMITS,
  MAX_LEDGER_RUN_LIMITS,
  configuredLedgerRunLimits,
  saveLedgerRunLimits,
  validateLedgerRunLimits,
} from "./ledger-settings.js";

const MAX_PAGE = 500;

export async function ledgerApiRoute(request: Request, env: Env, actor: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/usage" && request.method === "GET") return usageResponse(env.DB, url);
  if (url.pathname === "/api/metric-definitions" && request.method === "GET") return metricDefinitionsResponse(env.DB, url);
  if (url.pathname === "/api/ledger/resources" && request.method === "GET") return resourcesResponse(env.DB, env.BROLLY_ACCOUNT_ID, url);
  if (url.pathname === "/api/coverage" && request.method === "GET") return coverageResponse(env.DB, env.BROLLY_ACCOUNT_ID);
  if (url.pathname === "/api/monitoring-cost" && request.method === "GET") return monitoringCostResponse(env.DB, env.BROLLY_ACCOUNT_ID);
  if (url.pathname === "/api/monitoring-limits" && request.method === "GET") return monitoringLimitsResponse(env.DB);
  if (url.pathname === "/api/monitoring-limits" && request.method === "PUT") return updateMonitoringLimits(request, env.DB, actor);
  if (url.pathname === "/api/retention" && request.method === "GET") return retentionResponse(env.DB, env.BROLLY_ACCOUNT_ID);
  if (url.pathname === "/api/backfill" && request.method === "GET") return backfillResponse(env.DB, env.BROLLY_ACCOUNT_ID);
  if (url.pathname === "/api/backfill" && request.method === "POST") return createBackfill(request, env.DB, env.BROLLY_ACCOUNT_ID, actor);
  if (url.pathname === "/api/alert-rules" && request.method === "GET") return rulesResponse(env.DB, env.BROLLY_ACCOUNT_ID);
  if (url.pathname === "/api/alert-rules" && request.method === "POST") return createRule(request, env.DB, env.BROLLY_ACCOUNT_ID, actor);
  if (url.pathname === "/api/alert-instances" && request.method === "GET") return instancesResponse(env.DB, env.BROLLY_ACCOUNT_ID, url);

  const ruleMatch = url.pathname.match(/^\/api\/alert-rules\/([^/]+)$/);
  if (ruleMatch && request.method === "PUT") return updateRule(request, env.DB, decodeURIComponent(ruleMatch[1]!), env.BROLLY_ACCOUNT_ID, actor);
  if (ruleMatch && request.method === "DELETE") return deleteRule(env.DB, decodeURIComponent(ruleMatch[1]!), env.BROLLY_ACCOUNT_ID, actor);
  const ruleLinesMatch = url.pathname.match(/^\/api\/alert-rules\/([^/]+)\/lines$/);
  if (ruleLinesMatch && request.method === "POST") return createLine(request, env.DB, decodeURIComponent(ruleLinesMatch[1]!), actor);
  const lineMatch = url.pathname.match(/^\/api\/alert-lines\/([^/]+)$/);
  if (lineMatch && request.method === "PUT") return updateLine(request, env.DB, decodeURIComponent(lineMatch[1]!), actor);
  if (lineMatch && request.method === "DELETE") return deleteLine(env.DB, decodeURIComponent(lineMatch[1]!), actor);
  const silenceMatch = url.pathname.match(/^\/api\/alert-instances\/([^/]+)\/silence$/);
  if (silenceMatch && request.method === "POST") {
    const ok = await silenceAlertInstance(env.DB, decodeURIComponent(silenceMatch[1]!), actor);
    return ok ? Response.json({ ok: true }) : Response.json({ error: "Open alert instance not found" }, { status: 404 });
  }
  const protectionMatch = url.pathname.match(/^\/api\/ledger\/resources\/([^/]+)\/protection$/);
  if (protectionMatch && request.method === "PUT") return updateResourceProtection(request, env.DB, decodeURIComponent(protectionMatch[1]!), actor);
  return null;
}

async function metricDefinitionsResponse(db: D1Database, url: URL): Promise<Response> {
  const family = url.searchParams.get("family");
  const result = await db.prepare(
    `SELECT * FROM metric_definitions WHERE active=1 AND (?1 IS NULL OR product_family=?1)
     ORDER BY product_family,display_name`,
  ).bind(family).all<Record<string, unknown>>();
  return Response.json({ metricDefinitions: result.results.map(mapMetricDefinition) });
}

async function usageResponse(db: D1Database, url: URL): Promise<Response> {
  const resourceId = url.searchParams.get("resourceId");
  if (!resourceId) return Response.json({ error: "resourceId is required" }, { status: 400 });
  const metricId = url.searchParams.get("metricId");
  const from = validDay(url.searchParams.get("from")) ?? "0000-01-01";
  const to = validDay(url.searchParams.get("to")) ?? "9999-12-31";
  const [resource, daily, current, definitions, oldest] = await Promise.all([
    db.prepare(`SELECT * FROM resources WHERE id=?1 LIMIT 1`).bind(resourceId).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT local_day,period_start_at,period_end_at,metrics_json,estimated_cost_usd,
         authoritative_allocated_cost_usd,completeness,sampling_json,sealed,revision,revised_at
       FROM usage_daily WHERE resource_id=?1 AND local_day>=?2 AND local_day<=?3
       ORDER BY local_day ASC LIMIT 731`,
    ).bind(resourceId, from, to).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT local_day,payload_json,updated_at FROM usage_accumulator_shards
       WHERE product_family=(SELECT product_family FROM resources WHERE id=?1)
         AND local_day>=?2 AND local_day<=?3
         AND (json_extract(payload_json,'$.sealedAt') IS NULL
           OR updated_at>json_extract(payload_json,'$.sealedAt'))
       ORDER BY local_day ASC`,
    ).bind(resourceId, from, to).all<{ local_day: string; payload_json: string; updated_at: number }>(),
    db.prepare(`SELECT * FROM metric_definitions WHERE active=1 ORDER BY product_family,display_name`).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT MIN(u.local_day) AS oldest FROM usage_daily u JOIN resources r ON r.id=u.resource_id
       WHERE r.account_id=(SELECT account_id FROM resources WHERE id=?1)
         AND r.resource_type NOT IN ('account','product')
         AND r.resource_type NOT LIKE '%:namespace'`,
    ).bind(resourceId).first<{ oldest: string | null }>(),
  ]);
  if (!resource) return Response.json({ error: "Resource not found" }, { status: 404 });
  const pointsByDay = new Map(daily.results.map(row => [String(row.local_day), usagePoint(row, metricId)]));
  const currentDays = new Set<string>();
  for (const shard of current.results) {
    const entry = accumulatorResource(shard.payload_json, resourceId);
    if (!entry) continue;
    const shardMetrics = filterMetrics(Object.fromEntries(Object.entries(entry.metrics).map(([id, metric]) => [id, metric.day])), metricId);
    const shardSampling = Object.fromEntries(Object.entries(entry.metrics).map(([id, metric]) => [id, metric.sampleInterval]));
    const shardQuality = worstAccumulatorQuality(entry.metrics);
    const existing = currentDays.has(shard.local_day) ? pointsByDay.get(shard.local_day) : undefined;
    pointsByDay.set(shard.local_day, {
      localDay: shard.local_day,
      metrics: mergeNumberObjects(existing?.metrics, shardMetrics),
      estimatedCostUsd: Number(existing?.estimatedCostUsd ?? 0) + Object.values(entry.metrics).reduce((total, metric) => total + metric.estimatedDayUsd, 0),
      authoritativeCostUsd: null,
      quality: existing ? worstUsageQuality(String(existing.quality), shardQuality) : shardQuality,
      sampling: mergeSampling(existing?.sampling, shardSampling),
      sealed: false, revision: 0, revisedAt: Math.max(Number(existing?.revisedAt ?? 0), shard.updated_at),
    });
    currentDays.add(shard.local_day);
  }
  const points = [...pointsByDay.values()];
  points.sort((left, right) => String(left.localDay).localeCompare(String(right.localDay)));
  return Response.json({
    resource: mapResource(resource), metricDefinitions: definitions.results.map(mapMetricDefinition),
    metricId, period: "day", points, oldestRetainedAt: oldest?.oldest ?? null,
    freshnessAt: points.reduce<number | null>((latest, point) => Math.max(latest ?? 0, Number(point.revisedAt)), null),
  });
}

function mergeNumberObjects(left: unknown, right: Record<string, number>): Record<string, number> {
  const output = { ...(left && typeof left === "object" ? left as Record<string, number> : {}) };
  for (const [key, value] of Object.entries(right)) output[key] = (output[key] ?? 0) + value;
  return output;
}

function mergeSampling(left: unknown, right: Record<string, number | null>): Record<string, number | null> {
  const output = left && typeof left === "object" ? { ...left as Record<string, number | null> } : {};
  for (const [key, value] of Object.entries(right)) {
    const current = output[key];
    output[key] = current === null || value === null ? null : Math.max(current ?? 1, value);
  }
  return output;
}

function worstUsageQuality(left: string, right: string): string {
  const rank: Record<string, number> = { complete: 0, sampled: 1, partial: 2, stale: 3, missing: 4 };
  return (rank[left] ?? 4) >= (rank[right] ?? 4) ? left : right;
}

async function resourcesResponse(db: D1Database, accountId: string, url: URL): Promise<Response> {
  const parent = url.searchParams.get("parent");
  const family = url.searchParams.get("family");
  const query = url.searchParams.get("q")?.trim().toLowerCase();
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get("limit") ?? 250)));
  const cursor = parseResourceCursor(url.searchParams.get("cursor"));
  const [result, families] = await Promise.all([db.prepare(
    `SELECT r.*,
       (SELECT COUNT(*) FROM resources child WHERE child.parent_resource_id=r.id) AS child_count,
       (SELECT MAX(u.revised_at) FROM usage_daily u WHERE u.resource_id=r.id) AS usage_updated_at,
       (SELECT MIN(u.local_day) FROM usage_daily u WHERE u.resource_id=r.id) AS oldest_day,
       (SELECT COUNT(*) FROM alert_instances i WHERE i.target_resource_id=r.id AND i.status='open') AS open_alerts
     FROM resources r WHERE r.account_id=?1
       AND (?2 IS NULL OR r.parent_resource_id=?2)
       AND (?3 IS NULL OR r.product_family=?3)
       AND (?4 IS NULL OR lower(r.display_name) LIKE '%' || ?4 || '%' OR lower(r.cloudflare_id) LIKE '%' || ?4 || '%')
       AND (?5 IS NULL
         OR r.product_family>?5
         OR r.product_family=?5 AND r.resource_type>?6
         OR r.product_family=?5 AND r.resource_type=?6 AND r.display_name>?7
         OR r.product_family=?5 AND r.resource_type=?6 AND r.display_name=?7 AND r.id>?8)
     ORDER BY r.product_family,r.resource_type,r.display_name,r.id LIMIT ?9`,
  ).bind(accountId, parent, family, query, cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null, cursor?.[3] ?? null, limit + 1).all<Record<string, unknown>>(),
  db.prepare(`SELECT DISTINCT product_family FROM resources WHERE account_id=?1 AND product_family!='account' ORDER BY product_family`)
    .bind(accountId).all<{ product_family: string }>()]);
  const page = result.results.slice(0, limit);
  const last = page.at(-1);
  return Response.json({
    resources: page.map(mapResource),
    nextCursor: result.results.length > limit && last
      ? JSON.stringify([last.product_family, last.resource_type, last.display_name, last.id])
      : null,
    families: families.results.map(row => row.product_family),
    generatedAt: Date.now(),
  });
}

function parseResourceCursor(value: string | null): [string, string, string, string] | null {
  if (!value || value.length > 2_000) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.length === 4 && parsed.every(item => typeof item === "string" && item.length <= 1_000)
      ? parsed as [string, string, string, string] : null;
  } catch { return null; }
}

async function coverageResponse(db: D1Database, accountId: string): Promise<Response> {
  const [capabilities, state] = await Promise.all([
    db.prepare(`SELECT * FROM collector_capabilities WHERE account_id=?1 ORDER BY collector_key,dataset`).bind(accountId).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM collector_state WHERE account_id=?1 ORDER BY collector_key,partition_key`).bind(accountId).all<Record<string, unknown>>(),
  ]);
  return Response.json({ generatedAt: Date.now(), capabilities: capabilities.results.map(mapCapability), collectors: state.results.map(mapCollectorState) });
}

async function monitoringCostResponse(db: D1Database, accountId: string): Promise<Response> {
  const [daily, runs, limits] = await Promise.all([
    db.prepare(`SELECT * FROM monitor_usage_daily WHERE account_id=?1 ORDER BY local_day DESC LIMIT 31`).bind(accountId).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM monitor_runs WHERE account_id=?1 ORDER BY started_at DESC LIMIT 100`).bind(accountId).all<Record<string, unknown>>(),
    configuredLedgerRunLimits(db),
  ]);
  return Response.json({
    generatedAt: Date.now(), daily: daily.results.map(camelRow), runs: runs.results.map(camelRow),
    limits, defaults: DEFAULT_LEDGER_RUN_LIMITS, hardMaximums: MAX_LEDGER_RUN_LIMITS,
  });
}

async function monitoringLimitsResponse(db: D1Database): Promise<Response> {
  return Response.json({
    limits: await configuredLedgerRunLimits(db),
    defaults: DEFAULT_LEDGER_RUN_LIMITS,
    hardMaximums: MAX_LEDGER_RUN_LIMITS,
  });
}

async function updateMonitoringLimits(request: Request, db: D1Database, actor: string): Promise<Response> {
  const body = await request.json<LedgerRunLimits>();
  const error = validateLedgerRunLimits(body);
  if (error) return Response.json({ error }, { status: 400 });
  const limits = await saveLedgerRunLimits(db, body);
  await audit(db, actor, "monitoring.limits.update", "ledger", limits);
  return Response.json({ ok: true, limits });
}

async function retentionResponse(db: D1Database, accountId: string): Promise<Response> {
  const [oldest, counts, setting, backfill] = await Promise.all([
    db.prepare(
      `SELECT MIN(CASE WHEN r.resource_type NOT IN ('account','product') AND r.resource_type NOT LIKE '%:namespace' THEN u.local_day END) AS oldest_resource_day,
         MIN(CASE WHEN r.resource_type IN ('account','product') OR r.resource_type LIKE '%:namespace' THEN u.local_day END) AS oldest_aggregate_day
       FROM usage_daily u JOIN resources r ON r.id=u.resource_id WHERE r.account_id=?1`,
    ).bind(accountId).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT COUNT(*) AS daily_rows,SUM(length(metrics_json)+length(sampling_json)+160) AS projected_bytes
       FROM usage_daily WHERE resource_id IN (SELECT id FROM resources WHERE account_id=?1)`,
    ).bind(accountId).first<Record<string, unknown>>(),
    db.prepare(`SELECT value FROM settings WHERE key='d1_capacity_bytes' LIMIT 1`).first<{ value: string }>(),
    db.prepare(`SELECT COUNT(*) AS pending FROM backfill_slices WHERE status IN ('pending','running')`).first<{ pending: number }>(),
  ]);
  const capacityBytes = Number(setting?.value ?? 500_000_000);
  const projectedBytes = Number(counts?.projected_bytes ?? 0);
  return Response.json({
    generatedAt: Date.now(), oldestResourceDay: oldest?.oldest_resource_day ?? null,
    oldestAggregateDay: oldest?.oldest_aggregate_day ?? null, dailyRows: Number(counts?.daily_rows ?? 0),
    projectedBytes, capacityBytes, pressure: capacityBytes > 0 ? projectedBytes / capacityBytes : null,
    backfillPending: Number(backfill?.pending ?? 0), targetRetentionDays: 730,
  });
}

async function backfillResponse(db: D1Database, accountId: string): Promise<Response> {
  const [jobs, slices] = await Promise.all([
    db.prepare(`SELECT * FROM backfill_jobs WHERE account_id=?1 ORDER BY created_at DESC LIMIT 20`).bind(accountId).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT s.* FROM backfill_slices s JOIN backfill_jobs j ON j.id=s.backfill_job_id
       WHERE j.account_id=?1 ORDER BY s.ends_at DESC LIMIT 500`,
    ).bind(accountId).all<Record<string, unknown>>(),
  ]);
  return Response.json({ jobs: jobs.results.map(camelRow), slices: slices.results.map(camelRow) });
}

async function createBackfill(request: Request, db: D1Database, accountId: string, actor: string): Promise<Response> {
  const body = await request.json<{ startsAt?: number; endsAt?: number }>();
  const endsAt = finiteTimestamp(body.endsAt) ?? Date.now();
  const startsAt = finiteTimestamp(body.startsAt) ?? endsAt - 30 * 86_400_000;
  if (startsAt >= endsAt || endsAt - startsAt > 730 * 86_400_000) return Response.json({ error: "Backfill range must be between one day and 730 days" }, { status: 400 });
  const capabilities = await db.prepare(
    `SELECT DISTINCT collector_key FROM collector_capabilities WHERE account_id=?1 AND available=1 AND collector_key LIKE 'graphql:%' LIMIT 50`,
  ).bind(accountId).all<{ collector_key: string }>();
  const collectors = capabilities.results.length ? capabilities.results.map(row => row.collector_key) : ["graphql:durable-objects", "graphql:workers"];
  const id = crypto.randomUUID();
  const now = Date.now();
  const statements = [
    db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,requested_start_at,requested_end_at,newest_first,status,created_at,updated_at)
       VALUES(?1,?2,?3,?4,1,'pending',?5,?5)`,
    ).bind(id, accountId, startsAt, endsAt, now),
  ];
  for (let end = endsAt; end > startsAt; end -= 86_400_000) {
    const start = Math.max(startsAt, end - 86_400_000);
    for (const collector of collectors) statements.push(db.prepare(
      `INSERT INTO backfill_slices(
         id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at
       ) VALUES(?1,?2,?3,'',?4,?5,'pending','missing',?6)`,
    ).bind(crypto.randomUUID(), id, collector, start, end, now));
  }
  await runBatches(db, statements);
  await audit(db, actor, "backfill.create", id, { startsAt, endsAt, collectors });
  return Response.json({ ok: true, id, slices: statements.length - 1 }, { status: 201 });
}

async function rulesResponse(db: D1Database, accountId: string): Promise<Response> {
  const [rules, lines] = await Promise.all([
    db.prepare(
      `SELECT r.*,target.display_name AS target_display_name,target.resource_type AS target_resource_type
       FROM alert_rules r LEFT JOIN resources target ON target.id=r.target_resource_id
       WHERE r.account_id=?1 AND r.retired=0 ORDER BY r.created_at,r.id`,
    ).bind(accountId).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT l.* FROM alert_lines l JOIN alert_rules r ON r.id=l.alert_rule_id
       WHERE r.account_id=?1 AND r.retired=0 AND l.retired=0
       ORDER BY l.alert_rule_id,l.priority,l.created_at`,
    ).bind(accountId).all<Record<string, unknown>>(),
  ]);
  const byRule = new Map<string, unknown[]>();
  for (const line of lines.results) byRule.set(String(line.alert_rule_id), [...(byRule.get(String(line.alert_rule_id)) ?? []), mapLine(line)]);
  return Response.json({ rules: rules.results.map(row => ({ ...mapRule(row), lines: byRule.get(String(row.id)) ?? [] })) });
}

async function createRule(request: Request, db: D1Database, accountId: string, actor: string): Promise<Response> {
  const body = await request.json<Partial<AlertRule> & { lines?: Array<Partial<AlertLine>> }>();
  const error = await validateRule(db, accountId, body);
  if (error) return Response.json({ error }, { status: 400 });
  const id = body.id?.trim() || crypto.randomUUID();
  const now = Date.now();
  const lines = body.lines?.length ? body.lines : [
    { label: "Warning", color: "#f59e0b", priority: 50, thresholdValue: 1, action: "notify" as const, repeatIntervalMs: null, enabled: true },
    { label: "Emergency", color: "#ef4444", priority: 100, thresholdValue: 2, action: "quarantine" as const, repeatIntervalMs: 6 * 60 * 60_000, enabled: true },
  ];
  const lineError = validateLines(lines);
  if (lineError) return Response.json({ error: lineError }, { status: 400 });
  const statements = [ruleInsert(db, id, accountId, body, now)];
  for (const line of lines) statements.push(lineInsert(db, id, line, now));
  await runBatches(db, statements);
  await audit(db, actor, "alert_rule.create", id, { metricDefinitionId: body.metricDefinitionId, lines: lines.length });
  return Response.json({ ok: true, id }, { status: 201 });
}

async function updateRule(request: Request, db: D1Database, id: string, accountId: string, actor: string): Promise<Response> {
  const body = await request.json<Partial<AlertRule>>();
  const error = await validateRule(db, accountId, body);
  if (error) return Response.json({ error }, { status: 400 });
  const result = await db.prepare(
    `UPDATE alert_rules SET
       target_resource_id=?3,target_selector_json=?4,metric_definition_id=?5,measurement=?6,period=?7,
       notification_target_ids_json=?8,auto_quarantine=?9,auto_quarantine_contributors=?10,
       confirmation_window_ms=?11,enabled=?12,updated_at=?13
     WHERE id=?1 AND account_id=?2 AND retired=0`,
  ).bind(
    id, accountId, body.targetResourceId ?? null, body.targetSelector ? JSON.stringify(body.targetSelector) : null,
    body.metricDefinitionId, body.measurement, body.period, JSON.stringify(body.notificationTargetIds ?? []),
    body.autoQuarantine ? 1 : 0, body.autoQuarantineContributors ? 1 : 0,
    validConfirmation(body.confirmationWindowMs), body.enabled === false ? 0 : 1, Date.now(),
  ).run();
  if (Number(result.meta.changes ?? 0) !== 1) return Response.json({ error: "Alert rule not found" }, { status: 404 });
  await audit(db, actor, "alert_rule.update", id, body);
  return Response.json({ ok: true });
}

async function deleteRule(db: D1Database, id: string, accountId: string, actor: string): Promise<Response> {
  const open = await db.prepare(`SELECT 1 AS present FROM alert_instances WHERE alert_rule_id=?1 AND status IN ('open','silenced') LIMIT 1`).bind(id).first();
  if (open) return Response.json({ error: "Resolve or expire open alert instances before deleting this rule" }, { status: 409 });
  const history = await db.prepare(`SELECT 1 AS present FROM alert_instances WHERE alert_rule_id=?1 LIMIT 1`).bind(id).first();
  const now = Date.now();
  const results = history
    ? await db.batch([
      db.prepare(`UPDATE alert_lines SET enabled=0,retired=1,updated_at=?2 WHERE alert_rule_id=?1`).bind(id, now),
      db.prepare(`UPDATE alert_rules SET enabled=0,retired=1,updated_at=?3 WHERE id=?1 AND account_id=?2`).bind(id, accountId, now),
    ])
    : await db.batch([
      db.prepare(`DELETE FROM alert_lines WHERE alert_rule_id=?1`).bind(id),
      db.prepare(`DELETE FROM alert_rules WHERE id=?1 AND account_id=?2`).bind(id, accountId),
    ]);
  if (Number(results[1]?.meta.changes ?? 0) !== 1) return Response.json({ error: "Alert rule not found" }, { status: 404 });
  await audit(db, actor, history ? "alert_rule.retire" : "alert_rule.delete", id, {});
  return Response.json({ ok: true, retired: Boolean(history) });
}

async function createLine(request: Request, db: D1Database, ruleId: string, actor: string): Promise<Response> {
  const line = await request.json<Partial<AlertLine>>();
  const error = validateLines([line]);
  if (error) return Response.json({ error }, { status: 400 });
  const exists = await db.prepare(`SELECT 1 AS present FROM alert_rules WHERE id=?1 AND retired=0 LIMIT 1`).bind(ruleId).first();
  if (!exists) return Response.json({ error: "Alert rule not found" }, { status: 404 });
  const matching = await db.prepare(`SELECT id,retired FROM alert_lines WHERE alert_rule_id=?1 AND lower(label)=lower(?2) LIMIT 1`)
    .bind(ruleId, line.label?.trim()).first<{ id: string; retired: number }>();
  if (matching?.retired === 0) return Response.json({ error: "A threshold line with this label already exists" }, { status: 409 });
  const id = matching?.id ?? (line.id?.trim() || undefined) ?? crypto.randomUUID();
  const now = Date.now();
  if (matching) {
    await db.prepare(
      `UPDATE alert_lines SET label=?2,color=?3,priority=?4,threshold_value=?5,action=?6,
         repeat_interval_ms=?7,enabled=?8,retired=0,updated_at=?9 WHERE id=?1`,
    ).bind(
      id, line.label?.trim(), line.color, line.priority, line.thresholdValue, line.action ?? null,
      line.repeatIntervalMs ?? null, line.enabled === false ? 0 : 1, now,
    ).run();
  } else {
    await lineInsert(db, ruleId, { ...line, id }, now).run();
  }
  await audit(db, actor, "alert_line.create", id, { ruleId });
  return Response.json({ ok: true, id }, { status: 201 });
}

async function updateLine(request: Request, db: D1Database, id: string, actor: string): Promise<Response> {
  const line = await request.json<Partial<AlertLine>>();
  const error = validateLines([line]);
  if (error) return Response.json({ error }, { status: 400 });
  const conflict = await db.prepare(
    `SELECT 1 AS present FROM alert_lines current
     JOIN alert_lines sibling ON sibling.alert_rule_id=current.alert_rule_id
     WHERE current.id=?1 AND sibling.id!=current.id AND sibling.retired=0
       AND lower(sibling.label)=lower(?2) LIMIT 1`,
  ).bind(id, line.label?.trim()).first();
  if (conflict) return Response.json({ error: "A threshold line with this label already exists" }, { status: 409 });
  const result = await db.prepare(
    `UPDATE alert_lines SET label=?2,color=?3,priority=?4,threshold_value=?5,action=?6,
       repeat_interval_ms=?7,enabled=?8,updated_at=?9 WHERE id=?1 AND retired=0`,
  ).bind(
    id, line.label, line.color, line.priority, line.thresholdValue, line.action ?? null,
    line.repeatIntervalMs ?? null, line.enabled === false ? 0 : 1, Date.now(),
  ).run();
  if (Number(result.meta.changes ?? 0) !== 1) return Response.json({ error: "Alert line not found" }, { status: 404 });
  await audit(db, actor, "alert_line.update", id, line);
  return Response.json({ ok: true });
}

async function deleteLine(db: D1Database, id: string, actor: string): Promise<Response> {
  const line = await db.prepare(`SELECT alert_rule_id FROM alert_lines WHERE id=?1 AND retired=0 LIMIT 1`).bind(id).first<{ alert_rule_id: string }>();
  if (!line) return Response.json({ error: "Alert line not found" }, { status: 404 });
  const count = await db.prepare(`SELECT COUNT(*) AS count FROM alert_lines WHERE alert_rule_id=?1 AND retired=0`).bind(line.alert_rule_id).first<{ count: number }>();
  if (Number(count?.count ?? 0) <= 1) return Response.json({ error: "A rule must retain at least one threshold line" }, { status: 409 });
  const open = await db.prepare(`SELECT 1 AS present FROM alert_instances WHERE alert_line_id=?1 AND status IN ('open','silenced') LIMIT 1`).bind(id).first();
  if (open) return Response.json({ error: "Resolve or expire open instances before deleting this line" }, { status: 409 });
  const history = await db.prepare(`SELECT 1 AS present FROM alert_instances WHERE alert_line_id=?1 LIMIT 1`).bind(id).first();
  const result = history
    ? await db.prepare(`UPDATE alert_lines SET enabled=0,retired=1,updated_at=?2 WHERE id=?1`).bind(id, Date.now()).run()
    : await db.prepare(`DELETE FROM alert_lines WHERE id=?1`).bind(id).run();
  if (Number(result.meta.changes ?? 0) !== 1) return Response.json({ error: "Alert line not found" }, { status: 404 });
  await audit(db, actor, history ? "alert_line.retire" : "alert_line.delete", id, {});
  return Response.json({ ok: true, retired: Boolean(history) });
}

async function instancesResponse(db: D1Database, accountId: string, url: URL): Promise<Response> {
  const status = url.searchParams.get("status");
  const result = await db.prepare(
    `SELECT i.*,r.metric_definition_id,l.label,l.color,l.priority,target.display_name,target.product_family,target.cloudflare_id
     FROM alert_instances i JOIN alert_rules r ON r.id=i.alert_rule_id
     JOIN alert_lines l ON l.id=i.alert_line_id JOIN resources target ON target.id=i.target_resource_id
     WHERE r.account_id=?1 AND (?2 IS NULL OR i.status=?2)
     ORDER BY i.last_breached_at DESC LIMIT 500`,
  ).bind(accountId, status).all<Record<string, unknown>>();
  return Response.json({ instances: result.results.map(camelRow) });
}

async function updateResourceProtection(request: Request, db: D1Database, id: string, actor: string): Promise<Response> {
  const body = await request.json<{ policy?: string; excluded?: boolean; tier?: string }>();
  if (body.policy !== undefined && !["inherit", "allow", "deny"].includes(body.policy)) return Response.json({ error: "Invalid automatic-quarantine policy" }, { status: 400 });
  if (body.tier !== undefined && !["control_plane", "critical", "standard", "disposable", "unclassified"].includes(body.tier)) return Response.json({ error: "Invalid resource tier" }, { status: 400 });
  const row = await db.prepare(
    `SELECT account_id,product_family,resource_type,cloudflare_id,excluded,tier
     FROM resources WHERE id=?1 LIMIT 1`,
  ).bind(id).first<{
    account_id: string; product_family: string; resource_type: string;
    cloudflare_id: string; excluded: number; tier: string;
  }>();
  if (!row) return Response.json({ error: "Resource not found" }, { status: 404 });
  if (row.tier === "control_plane" && body.tier !== undefined && body.tier !== "control_plane") {
    return Response.json({ error: "Brolly control-plane classification cannot be removed" }, { status: 409 });
  }
  if ((row.excluded === 1 || row.tier === "control_plane") && (body.excluded === false || body.policy === "allow")) {
    return Response.json({ error: "Brolly control-plane resources cannot be included in automatic control" }, { status: 409 });
  }
  const statements = [
    db.prepare(
      `UPDATE resources SET auto_quarantine_policy=COALESCE(?2,auto_quarantine_policy),
         excluded=COALESCE(?3,excluded),tier=COALESCE(?4,tier) WHERE id=?1`,
    ).bind(id, body.policy ?? null, body.excluded === undefined ? null : body.excluded ? 1 : 0, body.tier ?? null),
  ];
  if (body.tier !== undefined && isLegacyAssetResource(row.resource_type)) {
    statements.push(db.prepare(
      `UPDATE assets SET tier=?4
       WHERE account_id=?1 AND family=?2 AND asset_id=?3`,
    ).bind(row.account_id, row.product_family, row.cloudflare_id, body.tier));
  }
  await db.batch(statements);
  await audit(db, actor, "resource.protection.update", id, body);
  return Response.json({ ok: true });
}

function isLegacyAssetResource(resourceType: string): boolean {
  return resourceType.endsWith(":resource") || resourceType.endsWith(":object") || resourceType.endsWith(":namespace");
}

async function validateRule(db: D1Database, accountId: string, rule: Partial<AlertRule>): Promise<string | null> {
  if (!rule.targetResourceId && !rule.targetSelector) return "Choose an exact resource or a target selector";
  if (rule.targetResourceId && rule.targetSelector) return "Choose one target form";
  if (!rule.metricDefinitionId) return "Choose an active metric definition";
  const metric = await db.prepare(`SELECT product_family FROM metric_definitions WHERE id=?1 AND active=1 LIMIT 1`)
    .bind(rule.metricDefinitionId).first<{ product_family: string }>();
  if (!metric) return "Choose an active metric definition";
  if (!rule.measurement || !["usage", "estimated_cost", "billed_cost"].includes(rule.measurement)) return "Choose a supported measurement";
  if (!rule.period || !["day", "billing_cycle"].includes(rule.period)) return "Choose a supported period";
  const target = rule.targetResourceId
    ? await db.prepare(`SELECT resource_type,product_family FROM resources WHERE id=?1 AND account_id=?2 LIMIT 1`)
      .bind(rule.targetResourceId, accountId).first<{ resource_type: string; product_family: string }>()
    : null;
  if (rule.targetResourceId && !target) return "Choose a resource from this account";
  if (target && target.resource_type !== "account" && target.product_family !== metric.product_family) {
    return "Choose a metric from the target resource's product family";
  }
  if (rule.targetSelector?.productFamily && rule.targetSelector.productFamily !== metric.product_family) {
    return "Choose a metric from the selector's product family";
  }
  if (rule.autoQuarantine && !rule.targetResourceId) return "Exact automatic quarantine requires an exact resource target";
  if (rule.autoQuarantine && target && !target.resource_type.endsWith(":object") && !target.resource_type.endsWith(":resource")) {
    return "Exact automatic quarantine requires a Worker or Durable Object resource";
  }
  if (rule.autoQuarantineContributors && !rule.targetResourceId) return "Contributor quarantine requires an aggregate resource target";
  if (rule.autoQuarantineContributors && rule.targetResourceId) {
    if (target?.resource_type.endsWith(":object") || target?.resource_type.endsWith(":resource")) return "Contributor quarantine applies to aggregate targets";
  }
  return null;
}

function validateLines(lines: Array<Partial<AlertLine>>): string | null {
  if (!lines.length) return "Add at least one threshold line";
  const labels = new Set<string>();
  for (const line of lines) {
    if (!line.label?.trim() || line.label.length > 80) return "Each line needs a label of at most 80 characters";
    if (labels.has(line.label.toLowerCase())) return "Line labels must be unique within a rule";
    labels.add(line.label.toLowerCase());
    if (!line.color || !/^#[0-9a-f]{6}$/i.test(line.color)) return "Each line needs a six-digit hex color";
    if (!Number.isFinite(line.priority) || !Number.isInteger(line.priority)) return "Each line needs an integer priority";
    if (!Number.isFinite(line.thresholdValue) || Number(line.thresholdValue) < 0) return "Thresholds must be finite and nonnegative";
    if (line.action !== undefined && line.action !== null && !["notify", "quarantine"].includes(line.action)) return "Invalid line action";
    if (line.repeatIntervalMs !== undefined && line.repeatIntervalMs !== null && (!Number.isFinite(line.repeatIntervalMs) || line.repeatIntervalMs < 60_000)) return "Repeat intervals must be at least one minute";
  }
  return null;
}

function ruleInsert(db: D1Database, id: string, accountId: string, body: Partial<AlertRule>, now: number): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO alert_rules(
       id,account_id,target_resource_id,target_selector_json,metric_definition_id,measurement,period,
       notification_target_ids_json,auto_quarantine,auto_quarantine_contributors,
       confirmation_window_ms,enabled,created_at,updated_at
     ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)`,
  ).bind(
    id, accountId, body.targetResourceId ?? null, body.targetSelector ? JSON.stringify(body.targetSelector) : null,
    body.metricDefinitionId, body.measurement, body.period, JSON.stringify(body.notificationTargetIds ?? []),
    body.autoQuarantine ? 1 : 0, body.autoQuarantineContributors ? 1 : 0,
    validConfirmation(body.confirmationWindowMs), body.enabled === false ? 0 : 1, now,
  );
}

function lineInsert(db: D1Database, ruleId: string, line: Partial<AlertLine>, now: number): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO alert_lines(
       id,alert_rule_id,label,color,priority,threshold_value,action,repeat_interval_ms,enabled,created_at,updated_at
     ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)
     ON CONFLICT(alert_rule_id,label) DO UPDATE SET
       color=excluded.color,priority=excluded.priority,threshold_value=excluded.threshold_value,
       action=excluded.action,repeat_interval_ms=excluded.repeat_interval_ms,
       enabled=excluded.enabled,retired=0,updated_at=excluded.updated_at`,
  ).bind(
    line.id?.trim() || crypto.randomUUID(), ruleId, line.label?.trim(), line.color,
    line.priority, line.thresholdValue, line.action ?? null, line.repeatIntervalMs ?? null,
    line.enabled === false ? 0 : 1, now,
  );
}

async function audit(db: D1Database, actor: string, action: string, target: string, detail: unknown): Promise<void> {
  await db.prepare(
    `INSERT INTO audit_log(id,actor,action,target,detail_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)`,
  ).bind(crypto.randomUUID(), actor, action, target, JSON.stringify(detail), Date.now()).run();
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let offset = 0; offset < statements.length; offset += 100) await db.batch(statements.slice(offset, offset + 100));
}

function validConfirmation(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) >= 60_000 ? Math.min(Number(value), 24 * 60 * 60_000) : 5 * 60_000;
}

function finiteTimestamp(value: number | undefined): number | null {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : null;
}

function validDay(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function mapResource(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id, accountId: row.account_id, parentResourceId: row.parent_resource_id,
    productFamily: row.product_family, resourceType: row.resource_type, cloudflareId: row.cloudflare_id,
    displayName: row.display_name, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
    lastActiveAt: row.last_active_at, coverageStatus: row.coverage_status,
    controlCapability: row.control_capability, runtimeFuseStatus: row.runtime_fuse_status,
    autoQuarantinePolicy: row.auto_quarantine_policy, tier: row.tier, excluded: Number(row.excluded) === 1,
    metadata: parseObject(String(row.metadata_json ?? "{}")), childCount: Number(row.child_count ?? 0),
    usageUpdatedAt: row.usage_updated_at ?? null, oldestDay: row.oldest_day ?? null, openAlerts: Number(row.open_alerts ?? 0),
  };
}

function mapMetricDefinition(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id, productFamily: row.product_family, metricKey: row.metric_key, displayName: row.display_name,
    unit: row.unit, aggregationKind: row.aggregation_kind, billingMapping: row.billing_mapping,
    collectorKey: row.collector_key, finestScope: row.finest_scope, pricingVersionId: row.pricing_version_id,
    active: Number(row.active) === 1,
  };
}

function mapCapability(row: Record<string, unknown>): Record<string, unknown> {
  return {
    accountId: row.account_id, collectorKey: row.collector_key, dataset: row.dataset,
    available: Number(row.available) === 1, retentionDays: row.retention_days, samplingBehavior: row.sampling_behavior,
    finestScope: row.finest_scope, lastVerifiedAt: row.last_verified_at, errorCode: row.error_code,
    humanExplanation: row.human_explanation, state: row.state, watermarkAt: row.watermark_at,
  };
}

function mapCollectorState(row: Record<string, unknown>): Record<string, unknown> {
  return {
    accountId: row.account_id, collectorKey: row.collector_key, partitionKey: row.partition_key,
    cursor: row.cursor_json ? parseObject(String(row.cursor_json)) : null, highWatermarkAt: row.high_watermark_at,
    retryCount: row.retry_count, nextEligibleAt: row.next_eligible_at, lastStartedAt: row.last_started_at,
    lastCompletedAt: row.last_completed_at, lastError: row.last_error, status: row.last_status,
  };
}

function mapRule(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id, accountId: row.account_id, targetResourceId: row.target_resource_id,
    targetDisplayName: row.target_display_name ?? null, targetResourceType: row.target_resource_type ?? null,
    targetSelector: row.target_selector_json ? parseObject(String(row.target_selector_json)) : null,
    metricDefinitionId: row.metric_definition_id, measurement: row.measurement, period: row.period,
    notificationTargetIds: parseArray(String(row.notification_target_ids_json ?? "[]")),
    autoQuarantine: Number(row.auto_quarantine) === 1,
    autoQuarantineContributors: Number(row.auto_quarantine_contributors) === 1,
    confirmationWindowMs: row.confirmation_window_ms, enabled: Number(row.enabled) === 1,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapLine(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id, alertRuleId: row.alert_rule_id, label: row.label, color: row.color,
    priority: row.priority, thresholdValue: row.threshold_value, action: row.action,
    repeatIntervalMs: row.repeat_interval_ms, enabled: Number(row.enabled) === 1,
  };
}

function usagePoint(row: Record<string, unknown>, metricId: string | null): Record<string, unknown> {
  return {
    localDay: row.local_day, periodStartAt: row.period_start_at, periodEndAt: row.period_end_at,
    metrics: filterMetrics(parseNumberObject(String(row.metrics_json)), metricId),
    estimatedCostUsd: row.estimated_cost_usd, authoritativeCostUsd: row.authoritative_allocated_cost_usd,
    quality: row.completeness, sampling: parseObject(String(row.sampling_json)), sealed: Number(row.sealed) === 1,
    revision: row.revision, revisedAt: row.revised_at,
  };
}

function accumulatorResource(value: string, resourceId: string): null | {
  metrics: Record<string, { day: number; estimatedDayUsd: number; quality: string; sampleInterval: number | null }>;
} {
  try {
    const parsed = JSON.parse(value) as { resources?: Record<string, unknown> };
    return (parsed.resources?.[resourceId] as ReturnType<typeof accumulatorResource>) ?? null;
  } catch { return null; }
}

function worstAccumulatorQuality(metrics: Record<string, { quality: string }>): string {
  const rank: Record<string, number> = { complete: 0, sampled: 1, partial: 2, stale: 3, missing: 4 };
  return Object.values(metrics).reduce((worst, metric) => (rank[metric.quality] ?? 4) > (rank[worst] ?? 0) ? metric.quality : worst, "complete");
}

function filterMetrics(metrics: Record<string, number>, metricId: string | null): Record<string, number> {
  if (!metricId) return metrics;
  return metrics[metricId] === undefined ? {} : { [metricId]: metrics[metricId] };
}

function parseObject(value: string): Record<string, unknown> {
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
}

function parseNumberObject(value: string): Record<string, number> {
  const parsed = parseObject(value);
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}

function parseArray(value: string): unknown[] {
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function camelRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), jsonValue(value)]));
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string" || !/^[\[{]/.test(value)) return value;
  try { return JSON.parse(value); } catch { return value; }
}
