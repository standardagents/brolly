/**
 * Pull real per-product daily usage from one Cloudflare account into the
 * demo fixture the dashboard preview loads instead of synthetic data.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/fetch-demo-usage.mjs
 *   DAYS=90  # optional window length, default 90, max 120
 *
 * Token scope: Account → Account Analytics: Read.
 *
 * Output: demo/usage-series.json (git-ignored local data; see the
 * `RealUsageFixture` loader in vite.demo.config.ts). Families the account
 * does not use, or whose dataset the token cannot read, are skipped with a
 * note; the demo renders no usage for a skipped family rather than inventing
 * numbers.
 *
 * GraphQL dataset names, field names, and metric-id mapping mirror the real
 * collectors in src/cloudflare.ts and src/product-usage.ts. Days are queried
 * as per-day aliases in chunks, using only filters those collectors already
 * use. Durable Objects storage-bytes datasets are not fetched (point-in-time
 * datasets the fixture can live without).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.cloudflare.com/client/v4/graphql";

/**
 * CLOUDFLARE_API_TOKEN wins. Without it, fall back to the local wrangler
 * OAuth session (`wrangler login`), the same credential wrangler itself uses.
 * The token value never leaves this process.
 */
function resolveToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  for (const file of [
    join(homedir(), "Library", "Preferences", ".wrangler", "config", "default.toml"),
    join(homedir(), ".config", ".wrangler", "config", "default.toml"),
    join(homedir(), ".wrangler", "config", "default.toml"),
  ]) {
    if (!existsSync(file)) continue;
    const match = readFileSync(file, "utf8").match(/oauth_token\s*=\s*"([^"]+)"/);
    if (match) {
      console.error(`using the wrangler OAuth session from ${file}`);
      return match[1];
    }
  }
  return undefined;
}

const token = resolveToken();
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID, plus CLOUDFLARE_API_TOKEN (Account Analytics: Read) or a `wrangler login` session.");
  process.exit(1);
}
// Cloudflare GraphQL retention is 12w6d (90 days) on paid accounts, measured
// from the query moment; a full 90-day window of complete UTC days starts a
// few hours past it. 88 keeps every dataset inside retention.
const DAYS = Math.min(88, Math.max(1, Number(process.env.DAYS ?? 88) || 88));
const CHUNK = 30; // day aliases per GraphQL request

const DAY_MS = 86_400_000;
const todayStart = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
/** Last complete UTC day. */
const lastDay = new Date(todayStart - DAY_MS).toISOString().slice(0, 10);
const days = Array.from({ length: DAYS }, (_, index) => new Date(todayStart - (DAYS - index) * DAY_MS).toISOString().slice(0, 10));

// Mirrors R2_CLASS_A_ACTIONS in src/product-usage.ts.
const R2_CLASS_A = new Set([
  "putobject", "copyobject", "listbuckets", "listobjects", "createmultipartupload",
  "uploadpart", "completemultipartupload", "abortmultipartupload", "deleteobject",
]);

/**
 * Rough gross unit rates in USD, only to give the fixture's cost row a
 * realistic shape. Sources: the hardcoded estimator rates in
 * src/cloudflare.ts and src/estimated-billable-cost.ts, plus list prices for
 * families those files do not price. Not billing math.
 */
const RATES = {
  "workers:requests": 0.30 / 1e6,
  "workers:cpu_ms": 0.02 / 1e6,
  "durable_objects:requests": 0.15 / 1e6,
  "durable_objects:incoming_websocket_messages": (0.15 / 1e6) / 20,
  "durable_objects:duration_gb_seconds": 12.50 / 1e6,
  "durable_objects:rows_read": 0.001 / 1e6,
  "durable_objects:rows_written": 1 / 1e6,
  "durable_objects:kv_read_units": 0.20 / 1e6,
  "durable_objects:kv_write_units": 1 / 1e6,
  "durable_objects:kv_delete_requests": 1 / 1e6,
  "kv:reads": 0.20 / 1e6,
  "kv:writes": 1 / 1e6,
  "kv:deletes": 1 / 1e6,
  "kv:lists": 1 / 1e6,
  "d1:rows_read": 0.001 / 1e6,
  "d1:rows_written": 1 / 1e6,
  "r2:class_a": 4.50 / 1e6,
  "r2:class_b": 0.36 / 1e6,
  "queues:operations": 0.40 / 1e6,
};
/** USD per GB-month for storage metrics; charged per day as rate/30. */
const STORAGE_RATES = {
  "kv:storage_bytes": 0.50,
  "d1:storage_bytes": 0.75,
  "r2:storage_bytes": 0.015,
};

/** Metric catalog entries for the fixture, matching UsageSeriesResponse["metrics"]. */
const METRICS = {
  workers: {
    "workers:requests": { key: "requests", label: "Requests", unit: "requests", aggregationKind: "sum", billable: true },
    "workers:cpu_ms": { key: "cpu_ms", label: "CPU time", unit: "ms", aggregationKind: "sum", billable: true },
  },
  durable_objects: {
    "durable_objects:requests": { key: "requests", label: "Requests", unit: "requests", aggregationKind: "sum", billable: true },
    "durable_objects:duration_gb_seconds": { key: "duration_gb_seconds", label: "Compute duration", unit: "GB-s", aggregationKind: "sum", billable: true },
    "durable_objects:incoming_websocket_messages": { key: "incoming_websocket_messages", label: "WebSocket messages", unit: "messages", aggregationKind: "sum", billable: true },
    "durable_objects:rows_read": { key: "rows_read", label: "Rows read", unit: "rows", aggregationKind: "sum", billable: true },
    "durable_objects:rows_written": { key: "rows_written", label: "Rows written", unit: "rows", aggregationKind: "sum", billable: true },
    "durable_objects:kv_read_units": { key: "kv_read_units", label: "KV read units", unit: "count", aggregationKind: "sum", billable: true },
    "durable_objects:kv_write_units": { key: "kv_write_units", label: "KV write units", unit: "count", aggregationKind: "sum", billable: true },
    "durable_objects:kv_delete_requests": { key: "kv_delete_requests", label: "KV delete requests", unit: "reqs", aggregationKind: "sum", billable: true },
  },
  kv: {
    "kv:reads": { key: "reads", label: "Reads", unit: "requests", aggregationKind: "sum", billable: true },
    "kv:writes": { key: "writes", label: "Writes", unit: "requests", aggregationKind: "sum", billable: true },
    "kv:deletes": { key: "deletes", label: "Deletes", unit: "requests", aggregationKind: "sum", billable: true },
    "kv:lists": { key: "lists", label: "Lists", unit: "requests", aggregationKind: "sum", billable: true },
    "kv:storage_bytes": { key: "storage_bytes", label: "Storage", unit: "bytes", aggregationKind: "maximum", billable: true },
  },
  d1: {
    "d1:rows_read": { key: "rows_read", label: "Rows read", unit: "rows", aggregationKind: "sum", billable: true },
    "d1:rows_written": { key: "rows_written", label: "Rows written", unit: "rows", aggregationKind: "sum", billable: true },
    "d1:storage_bytes": { key: "storage_bytes", label: "Storage", unit: "bytes", aggregationKind: "maximum", billable: true },
  },
  r2: {
    "r2:class_a": { key: "class_a", label: "Class A operations", unit: "operations", aggregationKind: "sum", billable: true },
    "r2:class_b": { key: "class_b", label: "Class B operations", unit: "operations", aggregationKind: "sum", billable: true },
    "r2:egress_bytes": { key: "egress_bytes", label: "Egress", unit: "bytes", aggregationKind: "sum", billable: false },
    "r2:storage_bytes": { key: "storage_bytes", label: "Storage", unit: "bytes", aggregationKind: "maximum", billable: true },
  },
  queues: {
    "queues:operations": { key: "operations", label: "Operations", unit: "operations", aggregationKind: "sum", billable: true },
    "queues:messages": { key: "messages", label: "Messages", unit: "messages", aggregationKind: "sum", billable: false },
    "queues:bytes": { key: "bytes", label: "Bytes", unit: "bytes", aggregationKind: "sum", billable: false },
  },
};
const LABELS = { workers: "Workers", durable_objects: "Durable Objects", kv: "Workers KV", d1: "D1", r2: "R2", queues: "Queues" };

/** dayAlias(index) → per-day filter clause. */
function dayFilter(day, timeKind, timeField) {
  if (timeKind === "date") return `${timeField}_geq: "${day}", ${timeField}_leq: "${day}"`;
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString();
  return `${timeField}_geq: "${day}T00:00:00Z", ${timeField}_lt: "${next.slice(0, 19)}Z"`;
}

async function graphql(query) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(API, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { account } }),
    });
    if (response.status === 429 && attempt < 3) {
      await new Promise(resolve => setTimeout(resolve, 2_000 * (attempt + 1)));
      continue;
    }
    if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const payload = await response.json();
    if (payload.errors?.length) throw new Error(payload.errors.map(error => error.message).join("; "));
    return payload.data?.viewer?.accounts?.[0] ?? {};
  }
}

/**
 * Query one dataset for every day, as chunked per-day aliases. Returns
 * day → rows (each row: { dimensions?, count?, sum?, max? }).
 */
async function datasetByDay({ dataset, timeKind, timeField, dimensions = [], selections }) {
  const byDay = new Map();
  for (let start = 0; start < days.length; start += CHUNK) {
    const chunk = days.slice(start, start + CHUNK);
    const aliases = chunk.map((day, index) =>
      `d${index}: ${dataset}(limit: 10000, filter: { ${dayFilter(day, timeKind, timeField)} }) { ${dimensions.length ? `dimensions { ${dimensions.join(" ")} }` : ""} ${selections} }`,
    ).join("\n");
    const result = await graphql(`query BrollyFixture($account: String!) { viewer { accounts(filter: { accountTag: $account }) {\n${aliases}\n} } }`);
    chunk.forEach((day, index) => {
      const rows = Array.isArray(result[`d${index}`]) ? result[`d${index}`] : [];
      if (rows.length) byDay.set(day, rows);
    });
  }
  return byDay;
}

const families = {};
function add(family, day, metricId, value) {
  if (!Number.isFinite(value) || value === 0) return;
  const record = (families[family] ??= new Map());
  const point = record.get(day) ?? {};
  point[metricId] = (point[metricId] ?? 0) + value;
  record.set(day, point);
}

const number = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Each fetcher fills `families`; a thrown error skips the family. */
const FETCHERS = {
  async workers() {
    const byDay = await datasetByDay({ dataset: "workersInvocationsAdaptive", timeKind: "time", timeField: "datetime", selections: "sum { requests cpuTimeUs }" });
    for (const [day, rows] of byDay) for (const row of rows) {
      add("workers", day, "workers:requests", number(row.sum?.requests));
      add("workers", day, "workers:cpu_ms", number(row.sum?.cpuTimeUs) / 1_000);
    }
  },
  async durable_objects() {
    const invocations = await datasetByDay({ dataset: "durableObjectsInvocationsAdaptiveGroups", timeKind: "time", timeField: "datetime", dimensions: ["type"], selections: "sum { requests }" });
    for (const [day, rows] of invocations) for (const row of rows) {
      // Hibernation-type invocations are incoming WebSocket messages, the
      // same split the live collector makes (src/cloudflare.ts).
      const metricId = row.dimensions?.type === "hibernation" ? "durable_objects:incoming_websocket_messages" : "durable_objects:requests";
      add("durable_objects", day, metricId, number(row.sum?.requests));
    }
    const periodic = await datasetByDay({
      dataset: "durableObjectsPeriodicGroups", timeKind: "time", timeField: "datetime",
      selections: "sum { duration rowsRead rowsWritten storageReadUnits storageWriteUnits storageDeletes inboundWebsocketMsgCount }",
    });
    for (const [day, rows] of periodic) for (const row of rows) {
      add("durable_objects", day, "durable_objects:duration_gb_seconds", number(row.sum?.duration));
      add("durable_objects", day, "durable_objects:rows_read", number(row.sum?.rowsRead));
      add("durable_objects", day, "durable_objects:rows_written", number(row.sum?.rowsWritten));
      add("durable_objects", day, "durable_objects:kv_read_units", number(row.sum?.storageReadUnits));
      add("durable_objects", day, "durable_objects:kv_write_units", number(row.sum?.storageWriteUnits));
      add("durable_objects", day, "durable_objects:kv_delete_requests", number(row.sum?.storageDeletes));
      add("durable_objects", day, "durable_objects:incoming_websocket_messages", number(row.sum?.inboundWebsocketMsgCount));
    }
  },
  async kv() {
    const operations = await datasetByDay({ dataset: "kvOperationsAdaptiveGroups", timeKind: "date", timeField: "date", dimensions: ["actionType"], selections: "sum { requests }" });
    for (const [day, rows] of operations) for (const row of rows) {
      const action = String(row.dimensions?.actionType ?? "").toLowerCase();
      const metricId = action === "read" ? "kv:reads" : action === "write" ? "kv:writes" : action === "delete" ? "kv:deletes" : action === "list" ? "kv:lists" : null;
      if (metricId) add("kv", day, metricId, number(row.sum?.requests));
    }
    const storage = await datasetByDay({ dataset: "kvStorageAdaptiveGroups", timeKind: "date", timeField: "date", dimensions: ["namespaceId"], selections: "max { byteCount }" });
    for (const [day, rows] of storage) for (const row of rows) add("kv", day, "kv:storage_bytes", number(row.max?.byteCount));
  },
  async d1() {
    const analytics = await datasetByDay({ dataset: "d1AnalyticsAdaptiveGroups", timeKind: "date", timeField: "date", selections: "sum { rowsRead rowsWritten }" });
    for (const [day, rows] of analytics) for (const row of rows) {
      add("d1", day, "d1:rows_read", number(row.sum?.rowsRead));
      add("d1", day, "d1:rows_written", number(row.sum?.rowsWritten));
    }
    const storage = await datasetByDay({ dataset: "d1StorageAdaptiveGroups", timeKind: "date", timeField: "date", dimensions: ["databaseId"], selections: "max { databaseSizeBytes }" });
    for (const [day, rows] of storage) for (const row of rows) add("d1", day, "d1:storage_bytes", number(row.max?.databaseSizeBytes));
  },
  async r2() {
    const operations = await datasetByDay({ dataset: "r2OperationsAdaptiveGroups", timeKind: "time", timeField: "datetime", dimensions: ["actionType"], selections: "sum { requests responseBytes }" });
    for (const [day, rows] of operations) for (const row of rows) {
      const action = String(row.dimensions?.actionType ?? "").toLowerCase();
      add("r2", day, R2_CLASS_A.has(action) ? "r2:class_a" : "r2:class_b", number(row.sum?.requests));
      add("r2", day, "r2:egress_bytes", number(row.sum?.responseBytes));
    }
    const storage = await datasetByDay({ dataset: "r2StorageAdaptiveGroups", timeKind: "time", timeField: "datetime", dimensions: ["bucketName"], selections: "max { payloadSize metadataSize }" });
    for (const [day, rows] of storage) for (const row of rows) add("r2", day, "r2:storage_bytes", number(row.max?.payloadSize) + number(row.max?.metadataSize));
  },
  async queues() {
    const byDay = await datasetByDay({ dataset: "queueMessageOperationsAdaptiveGroups", timeKind: "time", timeField: "datetime", selections: "count sum { billableOperations bytes }" });
    for (const [day, rows] of byDay) for (const row of rows) {
      add("queues", day, "queues:operations", number(row.sum?.billableOperations));
      add("queues", day, "queues:messages", number(row.count));
      add("queues", day, "queues:bytes", number(row.sum?.bytes));
    }
  },
};

const output = { today: lastDay, families: {} };
for (const [family, fetcher] of Object.entries(FETCHERS)) {
  try {
    await fetcher();
    const record = families[family];
    if (!record || record.size === 0) {
      console.error(`skip ${family}: no usage in the window`);
      continue;
    }
    const series = days
      .filter(day => record.has(day))
      .map(day => {
        const metrics = record.get(day);
        let costUsd = 0;
        for (const [metricId, value] of Object.entries(metrics)) {
          if (RATES[metricId]) costUsd += value * RATES[metricId];
          if (STORAGE_RATES[metricId]) costUsd += (value / 1e9) * (STORAGE_RATES[metricId] / 30);
        }
        return { day, costUsd: Number(costUsd.toFixed(6)), metrics, sealed: day !== lastDay };
      });
    const present = new Set(series.flatMap(point => Object.keys(point.metrics)));
    const metrics = Object.fromEntries(Object.entries(METRICS[family]).filter(([id]) => present.has(id)));
    output.families[family] = { label: LABELS[family], metrics, series };
    console.error(`ok   ${family}: ${series.length} days, ${present.size} metrics`);
  } catch (error) {
    console.error(`skip ${family}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (!Object.keys(output.families).length) {
  console.error("Nothing fetched; demo keeps its synthetic data.");
  process.exit(1);
}
const file = join(dirname(fileURLToPath(import.meta.url)), "..", "demo", "usage-series.json");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(output, null, 2));
console.error(`wrote ${file}`);
