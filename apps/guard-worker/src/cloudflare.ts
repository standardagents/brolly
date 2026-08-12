import type { AssetRef, BoundedRunContext, CoverageResult, MetricSample } from "@standardagents/brolly-core";
import { METRIC_CATALOG } from "@standardagents/brolly-core";
import type { Env } from "./env.js";
import { configuredBillingToken, operationalToken } from "./credentials.js";

const API = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 8_000;

interface ApiEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
  result_info?: { page?: number; per_page?: number; count?: number; total_count?: number; total_pages?: number };
}
export interface BillingUsageRecord {
  ChargePeriodStart: string;
  ChargePeriodEnd: string;
  ConsumedQuantity: number;
  ConsumedUnit: string;
  x_BillableMetricId: string;
  x_BillableMetricName: string;
  x_ProductFamilyId?: string;
  x_ProductFamilyName?: string;
  x_ZoneId?: string;
  x_ZoneName?: string;
  BilledCost?: number;
  EffectiveCost?: number;
  ListCost?: number;
}

export class CloudflareClient {
  private tokenPromise: Promise<string> | null = null;
  constructor(private readonly env: Env, private readonly budget: BoundedRunContext) {}

  async inventory(): Promise<{ assets: AssetRef[]; coverage: CoverageResult[] }> {
    const endpoints = [
      ["workers", `/accounts/${this.env.BROLLY_ACCOUNT_ID}/workers/scripts`, "resource"],
      ["durable_objects", `/accounts/${this.env.BROLLY_ACCOUNT_ID}/workers/durable_objects/namespaces`, "namespace"],
      ["queues", `/accounts/${this.env.BROLLY_ACCOUNT_ID}/queues`, "resource"],
      ["d1", `/accounts/${this.env.BROLLY_ACCOUNT_ID}/d1/database`, "resource"],
      ["r2", `/accounts/${this.env.BROLLY_ACCOUNT_ID}/r2/buckets`, "resource"],
      ["kv", `/accounts/${this.env.BROLLY_ACCOUNT_ID}/storage/kv/namespaces`, "namespace"],
      ["vectorize", `/accounts/${this.env.BROLLY_ACCOUNT_ID}/vectorize/v2/indexes`, "resource"],
      ["hyperdrive", `/accounts/${this.env.BROLLY_ACCOUNT_ID}/hyperdrive/configs`, "resource"],
      ["pages", `/accounts/${this.env.BROLLY_ACCOUNT_ID}/pages/projects`, "resource"],
      ["ai_gateway", `/accounts/${this.env.BROLLY_ACCOUNT_ID}/ai-gateway/gateways`, "resource"],
      ["zones", `/zones?account.id=${encodeURIComponent(this.env.BROLLY_ACCOUNT_ID)}&per_page=50`, "zone"],
    ] as const;
    const results = await Promise.all(endpoints.map(async ([family, path, scope]) => {
      try {
        const listed = await this.listRows(path);
        const assets: AssetRef[] = [];
        for (const row of listed.rows) {
          const id = stringValue(row.id) ?? stringValue(row.uuid) ?? stringValue(row.queue_id)
            ?? stringValue(row.name) ?? stringValue(row.namespace_id);
          if (!id) continue;
          const name = stringValue(row.name) ?? stringValue(row.queue_name) ?? stringValue(row.title) ?? id;
          const tags: Record<string, string> = {};
          if (family === "durable_objects") {
            const workerScript = stringValue(row.script);
            const className = stringValue(row.class);
            if (workerScript) tags.cloudflareWorkerScript = workerScript;
            if (className) tags.durableObjectClass = className;
            if (typeof row.use_sqlite === "boolean") tags.durableObjectStorage = row.use_sqlite ? "SQLite" : "key-value";
          }
          if (family === "workers") {
            const etag = stringValue(row.etag);
            const modifiedOn = stringValue(row.modified_on);
            if (etag) tags.cloudflareEtag = etag;
            if (modifiedOn) tags.cloudflareModifiedOn = modifiedOn;
          }
          assets.push({
            accountId: this.env.BROLLY_ACCOUNT_ID, family, id,
            name,
            scope, tier: name === "brolly-guard" ? "control_plane" : "unclassified", tags,
          });
        }
        return {
          assets,
          coverage: inventoryCoverage(
            family, scope, listed.truncated ? "delayed" : "healthy",
            listed.truncated ? "Inventory exceeded the bounded 10-page collector; discovered pages are retained" : undefined,
          ),
        };
      } catch (error) {
        const state = error instanceof CloudflareApiError && error.status === 403 ? "permission_denied" : "unavailable";
        return {
          assets: [],
          coverage: inventoryCoverage(family, scope, state, error instanceof Error ? error.message : String(error)),
        };
      }
    }));
    return {
      assets: results.flatMap(result => result.assets),
      coverage: results.map(result => result.coverage),
    };
  }

  async durableObjectUsage(since: number, until: number): Promise<{ samples: MetricSample[]; coverage: CoverageResult[] }> {
    const query = `query BrollyDurableObjects($account: String!, $since: Time!, $until: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        byRowsRead: durableObjectsPeriodicGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [sum_rowsRead_DESC]
        ) {
          dimensions { namespaceId objectId }
          sum { rowsRead rowsWritten }
        }
        byRowsWritten: durableObjectsPeriodicGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [sum_rowsWritten_DESC]
        ) {
          dimensions { namespaceId objectId }
          sum { rowsRead rowsWritten }
        }
        byRequests: durableObjectsInvocationsAdaptiveGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [sum_requests_DESC]
        ) {
          dimensions { namespaceId objectId type }
          sum { requests }
        }
        byDuration: durableObjectsPeriodicGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [sum_duration_DESC]
        ) {
          dimensions { namespaceId objectId }
          sum { duration }
        }
        byIncomingWebsocketMessages: durableObjectsPeriodicGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [sum_inboundWebsocketMsgCount_DESC]
        ) {
          dimensions { namespaceId objectId }
          sum { inboundWebsocketMsgCount }
        }
        byStorageReadUnits: durableObjectsPeriodicGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [sum_storageReadUnits_DESC]
        ) {
          dimensions { namespaceId objectId }
          sum { storageReadUnits }
        }
        byStorageWriteUnits: durableObjectsPeriodicGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [sum_storageWriteUnits_DESC]
        ) {
          dimensions { namespaceId objectId }
          sum { storageWriteUnits }
        }
        byStorageDeletes: durableObjectsPeriodicGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [sum_storageDeletes_DESC]
        ) {
          dimensions { namespaceId objectId }
          sum { storageDeletes }
        }
        sqlStorage: durableObjectsSqlStorageGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [max_storedBytes_DESC]
        ) {
          dimensions { namespaceId }
          max { storedBytes }
        }
        kvStorage: durableObjectsStorageGroups(
          limit: 1
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [max_storedBytes_DESC]
        ) {
          max { storedBytes }
        }
      } }
    }`;
    try {
      this.budget.charge("apiCalls");
      const response = await fetch(`${API}/graphql`, {
        method: "POST",
        headers: authHeaders(await this.token()),
        body: JSON.stringify({ query, variables: { account: this.env.BROLLY_ACCOUNT_ID, since: new Date(since).toISOString(), until: new Date(until).toISOString() } }),
        signal: this.budget.signal,
      });
      if (!response.ok) throw await cloudflareApiError(response);
      type Group = {
        dimensions: { namespaceId: string; objectId: string; type?: string };
        sum: {
          requests?: number;
          duration?: number;
          inboundWebsocketMsgCount?: number;
          rowsRead?: number;
          rowsWritten?: number;
          storageReadUnits?: number;
          storageWriteUnits?: number;
          storageDeletes?: number;
        };
      };
      type SqlStorageGroup = { dimensions: { namespaceId: string }; max: { storedBytes?: number } };
      type KvStorageGroup = { max: { storedBytes?: number } };
      type AccountUsage = {
        byRowsRead?: Group[];
        byRowsWritten?: Group[];
        byRequests?: Group[];
        byDuration?: Group[];
        byIncomingWebsocketMessages?: Group[];
        byStorageReadUnits?: Group[];
        byStorageWriteUnits?: Group[];
        byStorageDeletes?: Group[];
        sqlStorage?: SqlStorageGroup[];
        kvStorage?: KvStorageGroup[];
      };
      const payload = await response.json() as { data?: { viewer?: { accounts?: AccountUsage[] } }; errors?: Array<{ message: string }> };
      if (payload.errors?.length) throw new Error(payload.errors.map(error => error.message).join("; "));
      const account = payload.data?.viewer?.accounts?.[0];
      const lists = [
        account?.byRequests ?? [],
        account?.byDuration ?? [],
        account?.byIncomingWebsocketMessages ?? [],
        account?.byRowsRead ?? [],
        account?.byRowsWritten ?? [],
        account?.byStorageReadUnits ?? [],
        account?.byStorageWriteUnits ?? [],
        account?.byStorageDeletes ?? [],
      ];
      const truncated = lists.some(list => list.length >= 1000);
      const operationDefinitions = [
        [account?.byDuration ?? [], "duration_gb_seconds", "gb_seconds", (group: Group) => group.sum.duration],
        [account?.byIncomingWebsocketMessages ?? [], "incoming_websocket_messages", "count", (group: Group) => group.sum.inboundWebsocketMsgCount],
        [account?.byRowsRead ?? [], "rows_read", "rows", (group: Group) => group.sum.rowsRead],
        [account?.byRowsWritten ?? [], "rows_written", "rows", (group: Group) => group.sum.rowsWritten],
        [account?.byStorageReadUnits ?? [], "kv_read_units", "count", (group: Group) => group.sum.storageReadUnits],
        [account?.byStorageWriteUnits ?? [], "kv_write_units", "count", (group: Group) => group.sum.storageWriteUnits],
        [account?.byStorageDeletes ?? [], "kv_delete_requests", "requests", (group: Group) => group.sum.storageDeletes],
      ] as const;
      const operationSamples = new Map<string, MetricSample>();
      const addOperationSample = (asset: AssetRef, name: string, unit: MetricSample["unit"], value: number) => {
        const key = `${asset.parentId ?? ""}:${asset.id}:${name}`;
        const next = metric(asset, name, unit, value, since, until, truncated);
        const existing = operationSamples.get(key);
        if (!existing) {
          operationSamples.set(key, next);
          return;
        }
        existing.value += next.value;
        existing.estimatedCostUsd = (existing.estimatedCostUsd ?? 0) + (next.estimatedCostUsd ?? 0);
      };
      for (const group of account?.byRequests ?? []) {
        const value = group.sum.requests;
        if (value === undefined) continue;
        const asset: AssetRef = {
          accountId: this.env.BROLLY_ACCOUNT_ID,
          family: "durable_objects",
          id: group.dimensions.objectId,
          parentId: group.dimensions.namespaceId,
          scope: "object",
          tier: "unclassified",
        };
        const hibernatedWebsocketMessage = group.dimensions.type === "hibernation";
        addOperationSample(asset, hibernatedWebsocketMessage ? "incoming_websocket_messages" : "requests", hibernatedWebsocketMessage ? "count" : "requests", value);
      }
      for (const [groups, name, unit, read] of operationDefinitions) {
        for (const group of groups) {
          const value = read(group);
          if (value === undefined) continue;
          const asset: AssetRef = {
            accountId: this.env.BROLLY_ACCOUNT_ID,
            family: "durable_objects",
            id: group.dimensions.objectId,
            parentId: group.dimensions.namespaceId,
            scope: "object",
            tier: "unclassified",
          };
          addOperationSample(asset, name, unit, value);
        }
      }
      const samples = [...operationSamples.values()];
      for (const group of account?.sqlStorage ?? []) {
        const value = group.max.storedBytes;
        if (value === undefined) continue;
        const asset: AssetRef = {
          accountId: this.env.BROLLY_ACCOUNT_ID,
          family: "durable_objects",
          id: group.dimensions.namespaceId,
          scope: "namespace",
          tier: "unclassified",
        };
        samples.push(metric(asset, "sql_storage_bytes", "bytes", value, since, until, truncated));
      }
      const kvStoredBytes = Math.max(0, ...(account?.kvStorage ?? []).map(group => group.max.storedBytes ?? 0));
      if ((account?.kvStorage?.length ?? 0) > 0) {
        const asset: AssetRef = {
          accountId: this.env.BROLLY_ACCOUNT_ID,
          family: "durable_objects",
          id: "legacy-kv-storage",
          name: "Legacy key-value Durable Object storage",
          scope: "account",
          tier: "control_plane",
        };
        samples.push(metric(asset, "kv_storage_bytes", "bytes", kvStoredBytes, since, until, false));
      }
      this.budget.charge("samples", samples.length);
      const operationMetrics = ["requests", "duration_gb_seconds", "incoming_websocket_messages", "rows_read", "rows_written", "kv_read_units", "kv_write_units", "kv_delete_requests"];
      return {
        samples,
        coverage: [
          ...coverageForMetrics(
            "durable_objects", operationMetrics, truncated ? "delayed" : "healthy",
            truncated ? "Per-metric top-1000 response was truncated; high consumers are included but the long tail is not enumerable" : undefined,
            "object",
          ),
          ...coverageForMetrics("durable_objects", ["sql_storage_bytes"], (account?.sqlStorage?.length ?? 0) >= 1000 ? "delayed" : "healthy", undefined, "namespace"),
          ...coverageForMetrics("durable_objects", ["kv_storage_bytes"], "healthy", undefined, "account"),
        ],
      };
    } catch (error) {
      const state = error instanceof CloudflareApiError && error.status === 403 ? "permission_denied" : "unavailable";
      const detail = error instanceof Error ? error.message : String(error);
      return {
        samples: [],
        coverage: [
          ...coverageForMetrics("durable_objects", ["requests", "duration_gb_seconds", "incoming_websocket_messages", "rows_read", "rows_written", "kv_read_units", "kv_write_units", "kv_delete_requests"], state, detail, "object"),
          ...coverageForMetrics("durable_objects", ["sql_storage_bytes"], state, detail, "namespace"),
          ...coverageForMetrics("durable_objects", ["kv_storage_bytes"], state, detail, "account"),
        ],
      };
    }
  }

  async workerUsage(since: number, until: number): Promise<{ samples: MetricSample[]; coverage: CoverageResult[] }> {
    const query = `query BrollyWorkers($account: String!, $since: Time!, $until: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        byRequests: workersInvocationsAdaptive(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until, isPreview: 0 }
          orderBy: [sum_requests_DESC]
        ) {
          dimensions { scriptName }
          sum { requests }
        }
        byCpu: workersInvocationsAdaptive(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until, isPreview: 0 }
          orderBy: [sum_cpuTimeUs_DESC]
        ) {
          dimensions { scriptName }
          sum { cpuTimeUs }
        }
      } }
    }`;
    try {
      this.budget.charge("apiCalls");
      const response = await fetch(`${API}/graphql`, {
        method: "POST",
        headers: authHeaders(await this.token()),
        body: JSON.stringify({ query, variables: { account: this.env.BROLLY_ACCOUNT_ID, since: new Date(since).toISOString(), until: new Date(until).toISOString() } }),
        signal: this.budget.signal,
      });
      if (!response.ok) throw await cloudflareApiError(response);
      type Group = { dimensions: { scriptName: string }; sum: { requests?: number; cpuTimeUs?: number } };
      const payload = await response.json() as { data?: { viewer?: { accounts?: Array<{ byRequests?: Group[]; byCpu?: Group[] }> } }; errors?: Array<{ message: string }> };
      if (payload.errors?.length) throw new Error(payload.errors.map(error => error.message).join("; "));
      const account = payload.data?.viewer?.accounts?.[0];
      const requestGroups = account?.byRequests ?? [];
      const cpuGroups = account?.byCpu ?? [];
      const truncated = requestGroups.length >= 1000 || cpuGroups.length >= 1000;
      const samples: MetricSample[] = [];
      for (const group of requestGroups) {
        if (group.sum.requests === undefined || !group.dimensions.scriptName) continue;
        samples.push(workerMetric(this.env.BROLLY_ACCOUNT_ID, group.dimensions.scriptName, "requests", "requests", group.sum.requests, since, until, truncated));
      }
      for (const group of cpuGroups) {
        if (group.sum.cpuTimeUs === undefined || !group.dimensions.scriptName) continue;
        samples.push(workerMetric(this.env.BROLLY_ACCOUNT_ID, group.dimensions.scriptName, "cpu_ms", "milliseconds", group.sum.cpuTimeUs / 1000, since, until, truncated));
      }
      this.budget.charge("samples", samples.length);
      const detail = truncated ? "Per-metric top-1000 response was truncated; highest-cost Workers are included" : undefined;
      return {
        samples,
        coverage: [
          ...coverageForMetrics("workers", ["requests", "cpu_ms"], truncated ? "delayed" : "healthy", detail, "resource"),
          ...coverageForMetrics("workers", ["cache_requests"], "unavailable", "Cache-side billed requests are not yet separated from invocation misses without double-counting", "resource"),
        ],
      };
    } catch (error) {
      const state = error instanceof CloudflareApiError && error.status === 403 ? "permission_denied" : "unavailable";
      return { samples: [], coverage: coverageForMetrics("workers", ["requests", "cpu_ms", "cache_requests"], state, error instanceof Error ? error.message : String(error), "resource") };
    }
  }

  async billingUsage(since: number, until: number): Promise<BillingUsageRecord[] | null> {
    const token = await configuredBillingToken(this.env);
    if (!token) return null;
    const date = (value: number) => new Date(value).toISOString().slice(0, 10);
    const params = new URLSearchParams({ from: date(since), to: date(until) });
    return this.get<BillingUsageRecord[]>(`/accounts/${this.env.BROLLY_ACCOUNT_ID}/billable/usage?${params}`, token);
  }

  private async get<T>(path: string, token?: string): Promise<T> {
    return (await this.request<T>(path, token)).result;
  }

  private async listRows(path: string): Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean }> {
    const rows: Array<Record<string, unknown>> = [];
    let page = 1;
    let totalPages = 1;
    let perPage: number | undefined;
    do {
      const pagePath = page === 1 ? path : withPage(path, page, perPage);
      const envelope = await this.request<unknown>(pagePath);
      rows.push(...unwrapRows(envelope.result));
      totalPages = Math.max(1, envelope.result_info?.total_pages ?? 1);
      perPage ??= envelope.result_info?.per_page;
      page += 1;
    } while (page <= totalPages && page <= 10);
    return { rows, truncated: totalPages >= page };
  }

  private async request<T>(path: string, token?: string): Promise<ApiEnvelope<T>> {
    this.budget.charge("apiCalls");
    const response = await fetch(`${API}${path}`, {
      headers: authHeaders(token ?? await this.token()),
      signal: AbortSignal.any([this.budget.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) throw await cloudflareApiError(response);
    const envelope = await response.json() as ApiEnvelope<T>;
    if (!envelope.success) throw new Error(envelope.errors?.map(error => error.message).join("; ") || "Cloudflare API error");
    return envelope;
  }

  private token(): Promise<string> {
    this.tokenPromise ??= operationalToken(this.env);
    return this.tokenPromise;
  }
}

class CloudflareApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: number) { super(message); }
}

async function cloudflareApiError(response: Response): Promise<CloudflareApiError> {
  const raw = await response.text();
  try {
    const envelope = JSON.parse(raw) as { errors?: Array<{ code?: number; message?: string }>; message?: string };
    const first = envelope.errors?.[0];
    return new CloudflareApiError(response.status, first?.message ?? envelope.message ?? `Cloudflare API request failed (${response.status})`, first?.code);
  } catch {
    return new CloudflareApiError(response.status, raw || `Cloudflare API request failed (${response.status})`);
  }
}
function authHeaders(token: string): Record<string, string> { return { authorization: `Bearer ${token}`, "content-type": "application/json" }; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function withPage(path: string, page: number, perPage?: number): string {
  const url = new URL(path, API);
  url.searchParams.set("page", String(page));
  if (perPage && !url.searchParams.has("per_page")) url.searchParams.set("per_page", String(perPage));
  return `${url.pathname}${url.search}`;
}
function unwrapRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(item => item && typeof item === "object") as Array<Record<string, unknown>>;
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  for (const key of ["buckets", "queues", "result", "items"]) {
    if (Array.isArray(object[key])) return object[key] as Array<Record<string, unknown>>;
  }
  return [];
}
function metric(asset: AssetRef, name: string, unit: MetricSample["unit"], value: number, start: number, end: number, sampled: boolean): MetricSample {
  // Conservative gross-rate estimates intentionally ignore monthly included
  // usage. Authoritative invoices are reconciled separately.
  const unitPrice = name === "rows_read" ? 0.001 / 1_000_000
    : name === "rows_written" ? 1 / 1_000_000
      : name === "requests" ? 0.15 / 1_000_000
        : name === "duration_gb_seconds" ? 12.50 / 1_000_000
          : name === "incoming_websocket_messages" ? (0.15 / 1_000_000) / 20
            : name === "kv_read_units" ? 0.20 / 1_000_000
              : name === "kv_write_units" || name === "kv_delete_requests" ? 1 / 1_000_000 : 0;
  const storageCost = name === "sql_storage_bytes" || name === "kv_storage_bytes"
    ? (value / 1_000_000_000) * 0.20 * ((end - start) / (30 * 86_400_000))
    : 0;
  return { asset, metric: name, unit, value, start, end, source: "graphql", estimatedCostUsd: value * unitPrice + storageCost, sampled };
}
function workerMetric(accountId: string, scriptName: string, name: "requests" | "cpu_ms", unit: MetricSample["unit"], value: number, start: number, end: number, sampled: boolean): MetricSample {
  const asset: AssetRef = { accountId, family: "workers", id: scriptName, name: scriptName, scope: "resource", tier: scriptName === "brolly-guard" ? "control_plane" : "unclassified" };
  const unitPrice = name === "requests" ? 0.30 / 1_000_000 : 0.02 / 1_000_000;
  return { asset, metric: name, unit, value, start, end, source: "graphql", estimatedCostUsd: value * unitPrice, sampled };
}
function coverageForMetrics(family: string, metrics: string[], state: CoverageResult["state"], detail?: string, scope?: AssetRef["scope"]): CoverageResult[] {
  const definition = METRIC_CATALOG.find(item => item.family === family);
  if (!definition) return [];
  return metrics.map(metric => ({ family, metric, finestScope: scope ?? definition.preferredScope, state, checkedAt: Date.now(), detail }));
}
function inventoryCoverage(family: string, scope: AssetRef["scope"], state: CoverageResult["state"], detail?: string): CoverageResult {
  return { family, metric: "asset_inventory", finestScope: scope, state, checkedAt: Date.now(), detail };
}
