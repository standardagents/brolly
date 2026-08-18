#!/usr/bin/env node
/**
 * Pull 90 days of real per-product daily usage from Cloudflare's GraphQL
 * Analytics API and write it as the demo dashboard's usage fixture, so
 * `pnpm dev:demo` shows real shapes (and real "no usage" products).
 *
 * Auth: CLOUDFLARE_API_TOKEN, or the wrangler OAuth token from
 * ~/Library/Preferences/.wrangler/config/default.toml (run `wrangler whoami`
 * first to refresh it). Account: CLOUDFLARE_ACCOUNT_ID or --account <id>.
 *
 * Costs are estimates from public list prices; GraphQL has no billing.
 * Output: apps/guard-worker/demo/usage-series.json (git-ignored).
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const accountFlag = args.indexOf("--account");
const ACCOUNT = accountFlag >= 0 ? args[accountFlag + 1] : process.env.CLOUDFLARE_ACCOUNT_ID;
if (!ACCOUNT) { console.error("Set CLOUDFLARE_ACCOUNT_ID or pass --account <id>."); process.exit(1); }
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? wranglerToken();
if (!TOKEN) { console.error("Set CLOUDFLARE_API_TOKEN or log in with wrangler."); process.exit(1); }

const DAY = 86_400_000;
const today = new Date();
const todayDay = today.toISOString().slice(0, 10);
const start = new Date(today.getTime() - 89 * DAY);
const startDay = start.toISOString().slice(0, 10);

/** Per-family GraphQL datasets: which fields to sum per day and how to price them. */
const FAMILIES = {
  workers: { label: "Workers", queries: [
    { dataset: "workersInvocationsAdaptive", time: "datetime", fields: { requests: "sum { requests }", cpu_ms: "sum { cpuTimeUs }" }, scale: { cpu_ms: 1 / 1000 } },
  ], metrics: { requests: ["Requests", "requests", 0.30 / 1e6], cpu_ms: ["CPU time", "ms", 0.02 / 1e6] } },
  durable_objects: { label: "Durable Objects", queries: [
    { dataset: "durableObjectsInvocationsAdaptiveGroups", time: "datetime", fields: { requests: "sum { requests }" } },
    { dataset: "durableObjectsPeriodicGroups", time: "datetime", fields: { rows_read: "sum { rowsRead }", rows_written: "sum { rowsWritten }", duration_gb_seconds: "sum { activeTime }", incoming_websocket_messages: "sum { inboundWebsocketMsgCount }" }, scale: { duration_gb_seconds: 128 / 1024 / 1e6 } },
    { dataset: "durableObjectsStorageGroups", time: "datetime", fields: { sql_storage_bytes: "max { storedBytes }" }, aggregate: "max" },
  ], metrics: { requests: ["Requests", "requests", 0.15 / 1e6], rows_read: ["Rows read", "rows", 0.001 / 1e6], rows_written: ["Rows written", "rows", 1 / 1e6], duration_gb_seconds: ["Duration", "GB-s", 12.5 / 1e6], incoming_websocket_messages: ["WebSocket messages", "messages", 0.15 / 20e6], sql_storage_bytes: ["SQL storage", "bytes", 0.20 / 1e9 / 30] } },
  kv: { label: "Workers KV", queries: [
    { dataset: "kvOperationsAdaptiveGroups", time: "date", fields: { reads: "sum { requests }", writes: "sum { requests }", deletes: "sum { requests }", lists: "sum { requests }" }, byAction: { reads: "read", writes: "write", deletes: "delete", lists: "list" } },
    { dataset: "kvStorageAdaptiveGroups", time: "date", fields: { storage_bytes: "max { byteCount }" }, aggregate: "max" },
  ], metrics: { reads: ["Reads", "requests", 0.50 / 1e6], writes: ["Writes", "requests", 5 / 1e6], deletes: ["Deletes", "requests", 5 / 1e6], lists: ["Lists", "requests", 5 / 1e6], storage_bytes: ["Storage", "bytes", 0.50 / 1e9 / 30] } },
  d1: { label: "D1", queries: [
    { dataset: "d1AnalyticsAdaptiveGroups", time: "date", fields: { rows_read: "sum { rowsRead }", rows_written: "sum { rowsWritten }" } },
    { dataset: "d1StorageAdaptiveGroups", time: "date", fields: { storage_bytes: "max { databaseSizeBytes }" }, aggregate: "max" },
  ], metrics: { rows_read: ["Rows read", "rows", 0.001 / 1e6], rows_written: ["Rows written", "rows", 1 / 1e6], storage_bytes: ["Storage", "bytes", 0.75 / 1e9 / 30] } },
  r2: { label: "R2", queries: [
    { dataset: "r2OperationsAdaptiveGroups", time: "datetime", fields: { class_a: "sum { requests }", class_b: "sum { requests }", egress_bytes: "sum { responseBytes }" }, byAction: { class_a: ["PutObject", "CopyObject", "ListBuckets", "ListObjects", "CreateMultipartUpload", "UploadPart", "CompleteMultipartUpload", "AbortMultipartUpload", "DeleteObject"], class_b: "OTHER" } },
    { dataset: "r2StorageAdaptiveGroups", time: "datetime", fields: { storage_bytes: "max { payloadSize }" }, aggregate: "max" },
  ], metrics: { class_a: ["Class A operations", "operations", 4.5 / 1e6], class_b: ["Class B operations", "operations", 0.36 / 1e6], egress_bytes: ["Egress", "bytes", 0], storage_bytes: ["Storage", "bytes", 0.015 / 1e9 / 30] } },
  queues: { label: "Queues", queries: [
    { dataset: "queueMessageOperationsAdaptiveGroups", time: "datetime", fields: { operations: "sum { billableOperations }", bytes: "sum { bytes }" } },
  ], metrics: { operations: ["Operations", "operations", 0.40 / 1e6], bytes: ["Bytes", "bytes", 0] } },
  workers_ai: { label: "Workers AI", retentionDays: 30, queries: [
    { dataset: "aiInferenceAdaptiveGroups", time: "datetime", fields: { neurons: "sum { totalNeurons }", requests: "count" } },
  ], metrics: { neurons: ["Neurons", "neurons", 0.011 / 1000], requests: ["Requests", "requests", 0] } },
  vectorize: { label: "Vectorize", retentionDays: 30, queries: [
    { dataset: "vectorizeV2QueriesAdaptiveGroups", time: "datetime", fields: { queried_dimensions: "sum { queriedVectorDimensions }" } },
  ], metrics: { queried_dimensions: ["Queried dimensions", "dimensions", 0.01 / 1e6] } },
  workflows: { label: "Workflows", retentionDays: 30, queries: [
    { dataset: "workflowsAdaptiveGroups", time: "datetime", fields: { requests: "count" } },
  ], metrics: { requests: ["Requests", "requests", 0.30 / 1e6] } },
};

const out = { generatedAt: Date.now(), account: ACCOUNT.slice(0, 6) + "…", today: todayDay, families: {} };
for (const [family, spec] of Object.entries(FAMILIES)) {
  const perDay = new Map();
  for (const query of spec.queries) {
    for (const [metric, field] of Object.entries(query.fields)) {
      const rows = await fetchDaily(query, field, query.byAction?.[metric], spec.retentionDays).catch(error => { console.warn(`  ${family}.${metric}: ${error.message}`); return []; });
      for (const [day, value] of rows) {
        const scaled = value * (query.scale?.[metric] ?? 1);
        const entry = perDay.get(day) ?? {};
        entry[`${family}.${metric}`] = query.aggregate === "max" ? Math.max(entry[`${family}.${metric}`] ?? 0, scaled) : (entry[`${family}.${metric}`] ?? 0) + scaled;
        perDay.set(day, entry);
      }
    }
  }
  const series = [];
  for (let at = start.getTime(); at <= today.getTime(); at += DAY) {
    const day = new Date(at).toISOString().slice(0, 10);
    const metrics = perDay.get(day) ?? {};
    const costUsd = Object.entries(metrics).reduce((sum, [id, value]) => sum + value * (spec.metrics[id.split(".")[1]]?.[2] ?? 0), 0);
    series.push({ day, costUsd: Number(costUsd.toFixed(4)), metrics: Object.fromEntries(Object.entries(metrics).map(([id, value]) => [id, Math.round(value)])), sealed: day !== todayDay });
  }
  const total = series.reduce((sum, point) => sum + point.costUsd, 0);
  console.log(`${family.padEnd(16)} ${series.filter(point => Object.keys(point.metrics).length).length} days with data, est. $${total.toFixed(2)} / 90d`);
  out.families[family] = {
    label: spec.label,
    metrics: Object.fromEntries(Object.entries(spec.metrics).map(([key, [label, unit]]) => [`${family}.${key}`, { key, label, unit, billable: true }])),
    series,
  };
}

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "guard-worker", "demo", "usage-series.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(out));
console.log(`\nWrote ${target}`);

/** The API caps one query at about 31 days, so the 90-day window goes out as 30-day chunks. */
async function fetchDaily(query, field, action, retentionDays) {
  const earliest = retentionDays ? Math.max(start.getTime(), today.getTime() - (retentionDays - 1) * DAY) : start.getTime();
  const filterExtra = action ? (Array.isArray(action) ? `, actionType_in: ${JSON.stringify(action)}` : action === "OTHER" ? `, actionType_notin: ${JSON.stringify(FAMILIES.r2.queries[0].byAction.class_a)}` : `, actionType: "${action}"`) : "";
  const selection = field === "count" ? "count" : field;
  const rows = [];
  for (let from = earliest; from <= today.getTime(); from += 30 * DAY) {
    const to = Math.min(from + 30 * DAY, today.getTime() + DAY);
    const fromDay = new Date(from).toISOString().slice(0, 10);
    const toDay = new Date(to).toISOString().slice(0, 10);
    const timeFilter = query.time === "date"
      ? `date_geq: "${fromDay}", date_lt: "${toDay}"`
      : `datetime_geq: "${fromDay}T00:00:00Z", datetime_lt: "${toDay}T00:00:00Z"`;
    const gql = `{ viewer { accounts(filter: { accountTag: "${ACCOUNT}" }) { rows: ${query.dataset}(limit: 10000, filter: { ${timeFilter}${filterExtra} }, orderBy: [date_ASC]) { dimensions { date } ${selection} } } } }`;
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ query: gql }) });
    const body = await response.json();
    if (body.errors?.length) throw new Error(body.errors[0].message);
    for (const row of body.data?.viewer?.accounts?.[0]?.rows ?? []) rows.push([row.dimensions.date, field === "count" ? row.count : Object.values(row.sum ?? row.max ?? {})[0] ?? 0]);
  }
  return rows;
}

function wranglerToken() {
  try {
    const text = readFileSync(join(homedir(), "Library", "Preferences", ".wrangler", "config", "default.toml"), "utf8");
    return text.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  } catch { return null; }
}
