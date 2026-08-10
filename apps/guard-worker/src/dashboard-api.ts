import { DEFAULT_FAMILY_DAILY_SPEND, DEFAULT_POLICY, METRIC_CATALOG, assetBudgetKey, type Policy } from "@standardagents/brolly-core";
import type { Env } from "./env.js";

type Row = Record<string, unknown>;

export async function dashboardData(env: Env): Promise<Record<string, unknown>> {
  const now = Date.now();
  const [policyRow, incidentResult, coverageResult, assetFamilyResult, tierResult, spendResult, actionResult] = await Promise.all([
    env.DB.prepare(`SELECT value FROM settings WHERE key='policy' LIMIT 1`).first<{ value: string }>(),
    env.DB.prepare(
      `SELECT i.*,a.name AS asset_name,a.parent_id,a.scope,a.tier,a.metadata_json,
        (SELECT unit FROM metric_samples s WHERE s.account_id=i.account_id AND s.family=i.family AND s.asset_id=i.asset_id AND s.metric=i.metric ORDER BY s.end_at DESC LIMIT 1) AS unit,
        (SELECT id FROM actions x WHERE x.incident_id=i.id ORDER BY x.updated_at DESC LIMIT 1) AS action_id,
        (SELECT state FROM actions x WHERE x.incident_id=i.id ORDER BY x.updated_at DESC LIMIT 1) AS action_state,
        (SELECT kind FROM actions x WHERE x.incident_id=i.id ORDER BY x.updated_at DESC LIMIT 1) AS action_kind
       FROM incidents i LEFT JOIN assets a ON a.account_id=i.account_id AND a.family=i.family AND a.asset_id=i.asset_id
       WHERE i.status!='resolved' AND i.metric!='telemetry_coverage'
       ORDER BY CASE i.severity WHEN 'emergency' THEN 0 WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,i.last_seen DESC LIMIT 250`,
    ).all<Row>(),
    env.DB.prepare(`SELECT family,metric,finest_scope,state,detail,checked_at FROM metric_coverage ORDER BY CASE state WHEN 'permission_denied' THEN 0 WHEN 'unavailable' THEN 1 WHEN 'delayed' THEN 2 ELSE 3 END,family,metric`).all<Row>(),
    env.DB.prepare(`SELECT family,COUNT(*) AS asset_count,MAX(seen_at) AS last_seen FROM assets GROUP BY family ORDER BY asset_count DESC,family`).all<Row>(),
    env.DB.prepare(`SELECT tier,COUNT(*) AS asset_count FROM assets GROUP BY tier`).all<Row>(),
    env.DB.prepare(
      `SELECT family,metric,value,estimated_cost_usd,source,start_at,end_at FROM metric_samples
       WHERE metric IN ('rolling_24h_cost_usd','projected_daily_cost_usd','account_daily_billed_cost_usd')
         AND end_at>=?1 ORDER BY end_at ASC LIMIT 2500`,
    ).bind(now - 86_400_000).all<Row>(),
    env.DB.prepare(`SELECT id,incident_id,family,asset_id,kind,state,reason,error,created_at,updated_at FROM actions ORDER BY updated_at DESC LIMIT 20`).all<Row>(),
  ]);
  const policy = readPolicy(policyRow?.value);
  const incidents = incidentResult.results.map(incidentView);
  const coverage = coverageResult.results.map(row => ({
    family: String(row.family), metric: String(row.metric), scope: String(row.finest_scope), state: String(row.state),
    detail: row.detail == null ? null : String(row.detail), checkedAt: Number(row.checked_at),
  }));
  const coverageGaps = coverage.filter(item => item.state !== "healthy");
  const spend = spendView(spendResult.results, coverage, now);
  const familyDefinitions = new Map(METRIC_CATALOG.map(item => [item.family, item]));
  const assetFamilies = assetFamilyResult.results.map(row => {
    const family = String(row.family);
    const definition = familyDefinitions.get(family);
    return {
      family, label: familyLabel(family), assets: Number(row.asset_count), lastSeen: Number(row.last_seen),
      cloudflareUrl: cloudflareUrl(env.BROLLY_ACCOUNT_ID, family),
      expectedMetrics: definition?.metrics.length ?? 0,
      healthyMetrics: coverage.filter(item => item.family === family && item.state === "healthy").length,
      gaps: coverageGaps.filter(item => item.family === family).length,
    };
  });
  const severityCounts = countBy(incidents, item => String(item.severity));
  const statusCounts = countBy(incidents, item => String(item.status));
  return {
    generatedAt: now,
    account: { id: env.BROLLY_ACCOUNT_ID, timezone: env.BROLLY_TIMEZONE ?? "UTC" },
    policy: { mode: policy.mode, version: policy.version, accountDailySpend: policy.accountDailySpend, familyDailySpend: policy.familyDailySpend ?? DEFAULT_FAMILY_DAILY_SPEND, assetDailySpend: policy.assetDailySpend ?? {} },
    summary: {
      openIncidents: incidents.filter(item => item.status === "open").length,
      acknowledgedIncidents: statusCounts.acknowledged ?? 0,
      emergencyIncidents: severityCounts.emergency ?? 0,
      criticalIncidents: severityCounts.critical ?? 0,
      coverageGaps: coverageGaps.length,
      assets: assetFamilies.reduce((sum, item) => sum + item.assets, 0),
      lastCheckAt: coverage.reduce((latest, item) => Math.max(latest, item.checkedAt), 0) || null,
    },
    spend,
    incidents,
    coverage: { gaps: coverageGaps, all: coverage },
    assets: {
      families: assetFamilies,
      tiers: Object.fromEntries(tierResult.results.map(row => [String(row.tier), Number(row.asset_count)])),
    },
    actions: actionResult.results.map(row => ({
      id: String(row.id), incidentId: String(row.incident_id), family: String(row.family), assetId: String(row.asset_id),
      kind: String(row.kind), state: String(row.state), reason: String(row.reason), error: row.error == null ? null : String(row.error),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    })),
  };
}

export async function onboardingData(env: Env): Promise<Record<string, unknown>> {
  const [completeRow, policyRow, coverageResult, scopedAssetResult] = await Promise.all([
    env.DB.prepare(`SELECT value FROM settings WHERE key='onboarding_complete' LIMIT 1`).first<{ value: string }>(),
    env.DB.prepare(`SELECT value FROM settings WHERE key='policy' LIMIT 1`).first<{ value: string }>(),
    env.DB.prepare(`SELECT family,metric,state FROM metric_coverage`).all<{ family: string; metric: string; state: string }>(),
    env.DB.prepare(`SELECT family,asset_id,name,scope FROM assets WHERE (family='workers' AND scope='resource') OR (family='durable_objects' AND scope='namespace') ORDER BY family,name,asset_id LIMIT 2500`).all<{ family: "workers" | "durable_objects"; asset_id: string; name: string | null; scope: "resource" | "namespace" }>(),
  ]);
  const policy = readPolicy(policyRow?.value);
  const coverage = coverageResult.results;
  return {
    complete: completeRow?.value === "true",
    policy: { ...policy, familyDailySpend: { ...DEFAULT_FAMILY_DAILY_SPEND, ...policy.familyDailySpend }, assetDailySpend: policy.assetDailySpend ?? {} },
    families: METRIC_CATALOG.map(definition => ({
      family: definition.family, label: familyLabel(definition.family), metrics: definition.metrics,
      protection: coverage.some(item => item.family === definition.family && item.state === "healthy") ? "active" : "coverage_gap",
    })),
    scopedAssets: scopedAssetResult.results.map(asset => {
      const definition = METRIC_CATALOG.find(item => item.family === asset.family);
      const protectedMetrics = coverage.filter(item => item.family === asset.family && definition?.metrics.includes(item.metric));
      return {
        key: assetBudgetKey({ family: asset.family, scope: asset.scope, id: asset.asset_id }),
        family: asset.family,
        id: asset.asset_id,
        name: asset.name ?? asset.asset_id,
        scope: asset.scope,
        protection: definition && definition.metrics.every(metric => protectedMetrics.some(item => item.metric === metric && item.state === "healthy")) ? "active" : "coverage_gap",
      };
    }),
  };
}

export async function assetList(request: Request, env: Env): Promise<Record<string, unknown>> {
  const url = new URL(request.url);
  const clauses = ["account_id=?1"];
  const values: unknown[] = [env.BROLLY_ACCOUNT_ID];
  const family = url.searchParams.get("family");
  const tier = url.searchParams.get("tier");
  const search = url.searchParams.get("search")?.trim();
  if (family) { values.push(family); clauses.push(`family=?${values.length}`); }
  if (tier) { values.push(tier); clauses.push(`tier=?${values.length}`); }
  if (search) { values.push(`%${search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`); clauses.push(`(name LIKE ?${values.length} ESCAPE '\\' OR asset_id LIKE ?${values.length} ESCAPE '\\')`); }
  const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(250, Math.floor(requestedLimit))) : 100;
  values.push(limit);
  const result = await env.DB.prepare(
    `SELECT a.*,
      (SELECT COUNT(*) FROM incidents i WHERE i.account_id=a.account_id AND i.family=a.family AND i.asset_id=a.asset_id AND i.status!='resolved' AND i.metric!='telemetry_coverage') AS incident_count,
      (SELECT MAX(end_at) FROM metric_samples s WHERE s.account_id=a.account_id AND s.family=a.family AND s.asset_id=a.asset_id) AS last_signal_at
     FROM assets a WHERE ${clauses.join(" AND ")}
     ORDER BY incident_count DESC,seen_at DESC LIMIT ?${values.length}`,
  ).bind(...values).all<Row>();
  return {
    assets: result.results.map(row => ({
      accountId: String(row.account_id), family: String(row.family), id: String(row.asset_id),
      parentId: row.parent_id == null ? null : String(row.parent_id), name: row.name == null ? null : String(row.name),
      scope: String(row.scope), tier: String(row.tier), tags: parseJson(String(row.metadata_json ?? "{}")),
      discoveredAt: Number(row.discovered_at), seenAt: Number(row.seen_at), incidentCount: Number(row.incident_count),
      lastSignalAt: row.last_signal_at == null ? null : Number(row.last_signal_at),
    })),
  };
}

function incidentView(row: Row): Record<string, unknown> {
  const metric = String(row.metric);
  const windowMs = incidentWindow(String(row.incident_key));
  const unit = row.unit == null ? inferredUnit(metric) : String(row.unit);
  const tags = parseJson(String(row.metadata_json ?? "{}"));
  return {
    id: String(row.id), key: String(row.incident_key), status: String(row.status), severity: String(row.severity),
    family: String(row.family), familyLabel: familyLabel(String(row.family)), assetId: String(row.asset_id),
    assetName: row.asset_name == null ? null : String(row.asset_name), parentId: row.parent_id == null ? null : String(row.parent_id),
    scope: row.scope == null ? (row.family === "durable_objects" ? "object" : "resource") : String(row.scope),
    tier: row.tier == null ? "unclassified" : String(row.tier), tags,
    metric, metricLabel: metricLabel(metric), unit, windowMs,
    observed: Number(row.observed), threshold: row.threshold_value == null ? null : Number(row.threshold_value),
    expected: row.expected == null ? null : Number(row.expected), reason: String(row.reason), proposedAction: String(row.proposed_action),
    firstSeen: Number(row.first_seen), lastSeen: Number(row.last_seen), occurrences: Number(row.occurrences),
    action: row.action_id == null ? null : { id: String(row.action_id), state: String(row.action_state), kind: String(row.action_kind) },
    cloudflareUrl: cloudflareUrl(String(row.account_id), String(row.family)),
  };
}

function spendView(rows: Row[], coverage: Array<{ family: string; metric: string; state: string; checkedAt: number }>, now: number): Record<string, unknown> {
  const rolling = rows.filter(row => row.metric === "rolling_24h_cost_usd");
  const projected = rows.filter(row => row.metric === "projected_daily_cost_usd");
  const preferred = rolling.length > 0 ? rolling : projected;
  const latestByFamily = new Map<string, Row>();
  for (const row of preferred) {
    const current = latestByFamily.get(String(row.family));
    if (!current || Number(row.end_at) > Number(current.end_at)) latestByFamily.set(String(row.family), row);
  }
  const categories = [...latestByFamily.entries()].map(([family, row]) => ({
    family, label: familyLabel(family), estimatedUsd: Number(row.value), updatedAt: Number(row.end_at),
    coverage: coverage.some(item => item.family === family && item.state === "healthy") ? "healthy" : "partial",
  })).sort((a, b) => b.estimatedUsd - a.estimatedUsd);
  const bucketMap = new Map<number, Map<string, number>>();
  for (const row of preferred) {
    const bucket = Math.floor(Number(row.end_at) / 900_000) * 900_000;
    const family = String(row.family);
    const values = bucketMap.get(bucket) ?? new Map<string, number>();
    values.set(family, Number(row.value));
    bucketMap.set(bucket, values);
  }
  const history = [...bucketMap.entries()].sort((a, b) => a[0] - b[0]).slice(-96).map(([at, values]) => ({
    at, totalUsd: [...values.values()].reduce((sum, value) => sum + value, 0), categories: Object.fromEntries(values),
  }));
  const latestAt = categories.reduce((latest, item) => Math.max(latest, item.updatedAt), 0) || null;
  return {
    label: rolling.length > 0 ? "Estimated usage · rolling 24 hours" : "Projected daily usage at current rate",
    estimatedTotalUsd: categories.reduce((sum, item) => sum + item.estimatedUsd, 0), categories, history,
    updatedAt: latestAt, authoritative: false, stale: latestAt === null || now - latestAt > 20 * 60_000,
    note: "Gross estimate from fast telemetry. Included usage, discounts, and invoice adjustments are not applied.",
  };
}

function readPolicy(value?: string): Policy {
  if (!value) return DEFAULT_POLICY;
  try { return JSON.parse(value) as Policy; } catch { return DEFAULT_POLICY; }
}

function parseJson(value: string): Record<string, string> {
  try { return JSON.parse(value) as Record<string, string>; } catch { return {}; }
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) result[key(item)] = (result[key(item)] ?? 0) + 1;
  return result;
}

function incidentWindow(key: string): number | null {
  const value = Number(key.split(":").at(-1));
  return Number.isFinite(value) && value >= 60_000 ? value : null;
}

function inferredUnit(metric: string): string {
  if (metric.includes("cost") || metric.includes("spend")) return "usd";
  if (metric.includes("rows")) return "rows";
  if (metric.includes("request")) return "requests";
  if (metric.includes("bytes")) return "bytes";
  return "count";
}

function metricLabel(metric: string): string {
  const labels: Record<string, string> = {
    rows_read: "Rows read", rows_written: "Rows written", requests: "Requests",
    duration_gb_seconds: "Compute duration", incoming_websocket_messages: "Incoming WebSocket messages",
    kv_read_units: "Legacy storage read units", kv_write_units: "Legacy storage write units",
    kv_delete_requests: "Legacy storage deletes", sql_storage_bytes: "SQLite stored data",
    kv_storage_bytes: "Legacy stored data",
    projected_daily_cost_usd: "Projected daily cost", account_daily_billed_cost_usd: "Daily billed cost",
  };
  return labels[metric] ?? metric.replaceAll("_", " ").replace(/^./, value => value.toUpperCase());
}

function familyLabel(family: string): string {
  const labels: Record<string, string> = {
    durable_objects: "Durable Objects", workers: "Workers", workers_ai: "Workers AI", ai_gateway: "AI Gateway",
    d1: "D1", r2: "R2", kv: "Workers KV", queues: "Queues", vectorize: "Vectorize", hyperdrive: "Hyperdrive",
    pages: "Pages", zones: "Zones", images: "Images", stream: "Stream", billing: "Billing",
  };
  return labels[family] ?? family.replaceAll("_", " ").replace(/\b\w/g, value => value.toUpperCase());
}

function cloudflareUrl(accountId: string, family: string): string {
  const suffix: Record<string, string> = {
    durable_objects: "workers/durable-objects", workers: "workers-and-pages", queues: "workers/queues",
    d1: "workers/d1", r2: "r2/overview", kv: "workers/kv/namespaces", vectorize: "vectorize",
    hyperdrive: "workers/hyperdrive", pages: "workers-and-pages", ai_gateway: "ai/ai-gateway",
  };
  return `https://dash.cloudflare.com/${encodeURIComponent(accountId)}/${suffix[family] ?? "home"}`;
}
