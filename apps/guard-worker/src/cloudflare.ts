import type { AssetRef, BoundedRunContext, CollectorCoverage, CoverageResult, LedgerRunBudget, MetricSample } from "@standardagents/brolly-core";
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
  BillingCurrency?: string;
  BillingPeriodStart?: string;
  BillingPeriodEnd?: string;
  ChargeDescription?: string;
}

interface PaygoBillingUsageRecord {
  BilledCost: number;
  ChargePeriodStart: string;
  ChargePeriodEnd: string;
  ConsumedQuantity: number;
  ConsumedUnit: string;
  EffectiveCost?: number;
  ListCost?: number;
  ServiceName: string;
  ServiceFamilyName?: string;
  ZoneId?: string;
  ZoneName?: string;
  BillingPeriodStart?: string;
  BillingPeriodEnd?: string;
}

export interface DurableObjectUsageCursor {
  requests?: string;
  duration?: string;
  websocket?: string;
  rowsRead?: string;
  rowsWritten?: string;
  storageReads?: string;
  storageWrites?: string;
  storageDeletes?: string;
}

export interface DurableObjectUsageResult {
  samples: MetricSample[];
  coverage: CoverageResult[];
  continuation: DurableObjectUsageCursor | null;
  complete: boolean;
  pages: number;
  watermarkAt: number;
}

export interface WorkerUsageCursor {
  requests?: string;
  cpu?: string;
}

export interface WorkerUsageResult {
  samples: MetricSample[];
  coverage: CoverageResult[];
  continuation: WorkerUsageCursor | null;
  complete: boolean;
  pages: number;
  watermarkAt: number;
}

export class CloudflareClient {
  private tokenPromise: Promise<string> | null = null;
  constructor(
    private readonly env: Env,
    private readonly budget: BoundedRunContext,
    private readonly ledgerBudget?: LedgerRunBudget,
  ) {}

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
            scope, tier: family === "workers" && (isBrollyScript(id, this.env.BROLLY_SELF_WORKER_NAME) || isBrollyScript(name, this.env.BROLLY_SELF_WORKER_NAME))
              ? "control_plane" : "unclassified", tags,
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

  async analyticsCapabilities(): Promise<CollectorCoverage[]> {
    const datasets = [
      ["durableObjectsInvocationsAdaptiveGroups", "object"],
      ["durableObjectsPeriodicGroups", "object"],
      ["durableObjectsSqlStorageGroups", "namespace"],
      ["durableObjectsStorageGroups", "account"],
      ["workersInvocationsAdaptive", "resource"],
    ] as const;
    const query = `query BrollyAnalyticsCapabilities($account: String!) {
      viewer { accounts(filter: { accountTag: $account }) { settings {
        durableObjectsInvocationsAdaptiveGroups { enabled availableFields maxDuration maxNumberOfFields maxPageSize notOlderThan }
        durableObjectsPeriodicGroups { enabled availableFields maxDuration maxNumberOfFields maxPageSize notOlderThan }
        durableObjectsSqlStorageGroups { enabled availableFields maxDuration maxNumberOfFields maxPageSize notOlderThan }
        durableObjectsStorageGroups { enabled availableFields maxDuration maxNumberOfFields maxPageSize notOlderThan }
        workersInvocationsAdaptive { enabled availableFields maxDuration maxNumberOfFields maxPageSize notOlderThan }
      } } }
    }`;
    const checkedAt = Date.now();
    try {
      this.budget.charge("apiCalls");
      this.ledgerBudget?.charge("graphqlQueries", datasets.length);
      const response = await fetch(`${API}/graphql`, {
        method: "POST", headers: authHeaders(await this.token()),
        body: JSON.stringify({ query, variables: { account: this.env.BROLLY_ACCOUNT_ID } }),
        signal: this.budget.signal,
      });
      if (!response.ok) throw await cloudflareApiError(response);
      type Setting = { enabled?: boolean; availableFields?: string[]; maxDuration?: number; maxNumberOfFields?: number; maxPageSize?: number; notOlderThan?: number };
      const payload = await response.json() as { data?: { viewer?: { accounts?: Array<{ settings?: Record<string, Setting> }> } }; errors?: Array<{ message: string }> };
      if (payload.errors?.length) throw new Error(payload.errors.map(error => error.message).join("; "));
      const settings = payload.data?.viewer?.accounts?.[0]?.settings ?? {};
      const discovered = datasets.map(([dataset, scope]) => {
        const setting = settings[dataset];
        const available = setting?.enabled === true;
        return {
          accountId: this.env.BROLLY_ACCOUNT_ID, collectorKey: `graphql:${dataset}`, dataset,
          available, retentionDays: setting?.notOlderThan ? Math.floor(setting.notOlderThan / 86_400) : null,
          samplingBehavior: setting?.availableFields?.some(field => field.toLowerCase().includes("sampleinterval"))
            ? "Adaptive sampling; sampleInterval is recorded per result" : "Dataset sampling follows Cloudflare Analytics settings",
          finestScope: scope, lastVerifiedAt: checkedAt, errorCode: available ? null : "dataset_disabled",
          humanExplanation: available
            ? `Available with page size ${setting?.maxPageSize ?? "unknown"} and duration limit ${setting?.maxDuration ?? "unknown"} seconds`
            : "Cloudflare reports this Analytics dataset as unavailable for the current token or plan",
          state: available ? "healthy" : "unavailable", watermarkAt: null,
        } satisfies CollectorCoverage;
      });
      return [...discovered, ...catalogCapabilityGaps(this.env.BROLLY_ACCOUNT_ID, checkedAt)];
    } catch (error) {
      const state = error instanceof CloudflareApiError && error.status === 403 ? "permission_denied" : "unavailable";
      const detail = error instanceof Error ? error.message : String(error);
      return [
        ...datasets.map(([dataset, scope]) => ({
        accountId: this.env.BROLLY_ACCOUNT_ID, collectorKey: `graphql:${dataset}`, dataset,
        available: false, retentionDays: null, samplingBehavior: null, finestScope: scope,
        lastVerifiedAt: checkedAt, errorCode: state, humanExplanation: detail, state, watermarkAt: null,
        } satisfies CollectorCoverage)),
        ...catalogCapabilityGaps(this.env.BROLLY_ACCOUNT_ID, checkedAt),
      ];
    }
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

  async durableObjectUsagePaged(
    since: number,
    until: number,
    options: { cursor?: DurableObjectUsageCursor; maxPages?: number; expectedActiveObjects?: number } = {},
  ): Promise<DurableObjectUsageResult> {
    const pageSize = 10_000;
    const maxPages = Math.max(1, Math.min(options.maxPages ?? 30, 30));
    const query = `query BrollyDurableObjectLedger(
      $account: String!, $since: Time!, $until: Time!,
      $requestsCursor: String!, $durationCursor: String!, $websocketCursor: String!,
      $rowsReadCursor: String!, $rowsWrittenCursor: String!,
      $storageReadsCursor: String!, $storageWritesCursor: String!, $storageDeletesCursor: String!,
      $requestsMore: Boolean!, $durationMore: Boolean!, $websocketMore: Boolean!,
      $rowsReadMore: Boolean!, $rowsWrittenMore: Boolean!,
      $storageReadsMore: Boolean!, $storageWritesMore: Boolean!, $storageDeletesMore: Boolean!,
      $firstPage: Boolean!
    ) {
      viewer { accounts(filter: { accountTag: $account }) {
        requests: durableObjectsInvocationsAdaptiveGroups(
          limit: 10000, orderBy: [dimensions_objectId_ASC],
          filter: { datetime_geq: $since, datetime_lt: $until, objectId_gt: $requestsCursor }
        ) @include(if: $requestsMore) { dimensions { namespaceId objectId type } sum { requests } }
        duration: durableObjectsPeriodicGroups(
          limit: 10000, orderBy: [dimensions_objectId_ASC],
          filter: { datetime_geq: $since, datetime_lt: $until, objectId_gt: $durationCursor }
        ) @include(if: $durationMore) { dimensions { namespaceId objectId } sum { duration } }
        websocket: durableObjectsPeriodicGroups(
          limit: 10000, orderBy: [dimensions_objectId_ASC],
          filter: { datetime_geq: $since, datetime_lt: $until, objectId_gt: $websocketCursor }
        ) @include(if: $websocketMore) { dimensions { namespaceId objectId } sum { inboundWebsocketMsgCount } }
        rowsRead: durableObjectsPeriodicGroups(
          limit: 10000, orderBy: [dimensions_objectId_ASC],
          filter: { datetime_geq: $since, datetime_lt: $until, objectId_gt: $rowsReadCursor }
        ) @include(if: $rowsReadMore) { dimensions { namespaceId objectId } sum { rowsRead } }
        rowsWritten: durableObjectsPeriodicGroups(
          limit: 10000, orderBy: [dimensions_objectId_ASC],
          filter: { datetime_geq: $since, datetime_lt: $until, objectId_gt: $rowsWrittenCursor }
        ) @include(if: $rowsWrittenMore) { dimensions { namespaceId objectId } sum { rowsWritten } }
        storageReads: durableObjectsPeriodicGroups(
          limit: 10000, orderBy: [dimensions_objectId_ASC],
          filter: { datetime_geq: $since, datetime_lt: $until, objectId_gt: $storageReadsCursor }
        ) @include(if: $storageReadsMore) { dimensions { namespaceId objectId } sum { storageReadUnits } }
        storageWrites: durableObjectsPeriodicGroups(
          limit: 10000, orderBy: [dimensions_objectId_ASC],
          filter: { datetime_geq: $since, datetime_lt: $until, objectId_gt: $storageWritesCursor }
        ) @include(if: $storageWritesMore) { dimensions { namespaceId objectId } sum { storageWriteUnits } }
        storageDeletes: durableObjectsPeriodicGroups(
          limit: 10000, orderBy: [dimensions_objectId_ASC],
          filter: { datetime_geq: $since, datetime_lt: $until, objectId_gt: $storageDeletesCursor }
        ) @include(if: $storageDeletesMore) { dimensions { namespaceId objectId } sum { storageDeletes } }
        sqlStorage: durableObjectsSqlStorageGroups(
          limit: 10000, filter: { datetime_geq: $since, datetime_lt: $until }, orderBy: [dimensions_namespaceId_ASC]
        ) @include(if: $firstPage) { dimensions { namespaceId } max { storedBytes } }
        kvStorage: durableObjectsStorageGroups(
          limit: 1, filter: { datetime_geq: $since, datetime_lt: $until }, orderBy: [max_storedBytes_DESC]
        ) @include(if: $firstPage) { max { storedBytes } }
      } }
    }`;
    type Group = {
      dimensions: { namespaceId: string; objectId: string; type?: string };
      sum: {
        requests?: number; duration?: number; inboundWebsocketMsgCount?: number; rowsRead?: number;
        rowsWritten?: number; storageReadUnits?: number; storageWriteUnits?: number; storageDeletes?: number;
      };
    };
    type Account = {
      requests?: Group[]; duration?: Group[]; websocket?: Group[]; rowsRead?: Group[]; rowsWritten?: Group[];
      storageReads?: Group[]; storageWrites?: Group[]; storageDeletes?: Group[];
      sqlStorage?: Array<{ dimensions: { namespaceId: string }; max: { storedBytes?: number } }>;
      kvStorage?: Array<{ max: { storedBytes?: number } }>;
    };
    const names = ["requests", "duration", "websocket", "rowsRead", "rowsWritten", "storageReads", "storageWrites", "storageDeletes"] as const;
    const cursors: Required<DurableObjectUsageCursor> = {
      requests: options.cursor?.requests ?? "", duration: options.cursor?.duration ?? "",
      websocket: options.cursor?.websocket ?? "", rowsRead: options.cursor?.rowsRead ?? "",
      rowsWritten: options.cursor?.rowsWritten ?? "", storageReads: options.cursor?.storageReads ?? "",
      storageWrites: options.cursor?.storageWrites ?? "", storageDeletes: options.cursor?.storageDeletes ?? "",
    };
    const more: Record<(typeof names)[number], boolean> = Object.fromEntries(names.map(name => [name, true])) as Record<(typeof names)[number], boolean>;
    const seen = Object.fromEntries(names.map(name => [name, 0])) as Record<(typeof names)[number], number>;
    const samples = new Map<string, MetricSample>();
    let pages = 0;
    let sqlStorage: Account["sqlStorage"] = [];
    let kvStorage: Account["kvStorage"] = [];
    try {
      while (pages < maxPages && names.some(name => more[name])) {
        this.budget.charge("apiCalls");
        this.ledgerBudget?.charge("pagesPerDataset");
        this.ledgerBudget?.charge("graphqlQueries", names.filter(name => more[name]).length + (pages === 0 ? 2 : 0));
        const variables = {
          account: this.env.BROLLY_ACCOUNT_ID,
          since: new Date(since).toISOString(), until: new Date(until).toISOString(),
          ...Object.fromEntries(names.flatMap(name => [[`${name}Cursor`, cursors[name]], [`${name}More`, more[name]]])),
          firstPage: pages === 0,
        };
        const response = await fetch(`${API}/graphql`, {
          method: "POST", headers: authHeaders(await this.token()), body: JSON.stringify({ query, variables }),
          signal: this.budget.signal,
        });
        if (!response.ok) throw await cloudflareApiError(response);
        const payload = await response.json() as { data?: { viewer?: { accounts?: Account[] } }; errors?: Array<{ message: string }> };
        if (payload.errors?.length) throw new Error(payload.errors.map(error => error.message).join("; "));
        const account = payload.data?.viewer?.accounts?.[0] ?? {};
        if (pages === 0) {
          sqlStorage = account.sqlStorage ?? [];
          kvStorage = account.kvStorage ?? [];
        }
        for (const name of names) {
          if (!more[name]) continue;
          const groups = account[name] ?? [];
          seen[name] += groups.length;
          for (const group of groups) addDurableObjectGroup(samples, this.env.BROLLY_ACCOUNT_ID, name, group, since, until);
          const lastId = groups.at(-1)?.dimensions.objectId;
          if (lastId) cursors[name] = lastId;
          more[name] = groups.length === pageSize
            && (!options.expectedActiveObjects || seen[name] < options.expectedActiveObjects);
        }
        pages += 1;
      }
      for (const group of sqlStorage ?? []) {
        if (group.max.storedBytes === undefined) continue;
        const asset: AssetRef = {
          accountId: this.env.BROLLY_ACCOUNT_ID, family: "durable_objects", id: group.dimensions.namespaceId,
          scope: "namespace", tier: "unclassified",
        };
        samples.set(`${asset.id}:sql_storage_bytes`, metric(asset, "sql_storage_bytes", "bytes", group.max.storedBytes, since, until, false));
      }
      if ((kvStorage?.length ?? 0) > 0) {
        const value = Math.max(0, ...(kvStorage ?? []).map(group => group.max.storedBytes ?? 0));
        const asset: AssetRef = {
          accountId: this.env.BROLLY_ACCOUNT_ID, family: "durable_objects", id: "legacy-kv-storage",
          name: "Legacy key-value Durable Object storage", scope: "account", tier: "control_plane",
        };
        samples.set(`${asset.id}:kv_storage_bytes`, metric(asset, "kv_storage_bytes", "bytes", value, since, until, false));
      }
      const complete = !names.some(name => more[name]);
      const detail = complete ? undefined : `Durable Object keyset pagination paused after ${pages} pages; the continuation is persisted`;
      const result = [...samples.values()];
      this.budget.charge("samples", result.length);
      return {
        samples: result,
        coverage: [
          ...coverageForMetrics("durable_objects", ["requests", "duration_gb_seconds", "incoming_websocket_messages", "rows_read", "rows_written", "kv_read_units", "kv_write_units", "kv_delete_requests"], complete ? "healthy" : "delayed", detail, "object"),
          ...coverageForMetrics("durable_objects", ["sql_storage_bytes"], (sqlStorage?.length ?? 0) >= pageSize ? "delayed" : "healthy", undefined, "namespace"),
          ...coverageForMetrics("durable_objects", ["kv_storage_bytes"], "healthy", undefined, "account"),
        ],
        continuation: complete ? null : Object.fromEntries(names.filter(name => more[name]).map(name => [name, cursors[name]])),
        complete, pages, watermarkAt: until,
      };
    } catch (error) {
      const state = error instanceof CloudflareApiError && error.status === 403 ? "permission_denied" : "unavailable";
      const detail = error instanceof Error ? error.message : String(error);
      return {
        samples: [...samples.values()],
        coverage: coverageForMetrics("durable_objects", ["requests", "duration_gb_seconds", "incoming_websocket_messages", "rows_read", "rows_written", "kv_read_units", "kv_write_units", "kv_delete_requests", "sql_storage_bytes", "kv_storage_bytes"], state, detail, "object"),
        continuation: Object.fromEntries(names.filter(name => more[name]).map(name => [name, cursors[name]])),
        complete: false, pages, watermarkAt: until,
      };
    }
  }

  async workerUsage(
    since: number,
    until: number,
    options: { cursor?: WorkerUsageCursor; maxPages?: number } = {},
  ): Promise<WorkerUsageResult> {
    const pageSize = 10_000;
    const maxPages = Math.max(1, Math.min(options.maxPages ?? 10, 30));
    const query = `query BrollyWorkers(
      $account: String!, $since: Time!, $until: Time!,
      $requestsCursor: String!, $cpuCursor: String!,
      $requestsMore: Boolean!, $cpuMore: Boolean!
    ) {
      viewer { accounts(filter: { accountTag: $account }) {
        byRequests: workersInvocationsAdaptive(
          limit: 10000
          filter: { datetime_geq: $since, datetime_lt: $until, isPreview: 0, scriptName_gt: $requestsCursor }
          orderBy: [dimensions_scriptName_ASC]
        ) @include(if: $requestsMore) {
          dimensions { scriptName }
          sum { requests }
        }
        byCpu: workersInvocationsAdaptive(
          limit: 10000
          filter: { datetime_geq: $since, datetime_lt: $until, isPreview: 0, scriptName_gt: $cpuCursor }
          orderBy: [dimensions_scriptName_ASC]
        ) @include(if: $cpuMore) {
          dimensions { scriptName }
          sum { cpuTimeUs }
        }
      } }
    }`;
    const cursors = { requests: options.cursor?.requests ?? "", cpu: options.cursor?.cpu ?? "" };
    const more = { requests: true, cpu: true };
    const samples = new Map<string, MetricSample>();
    let pages = 0;
    try {
      while (pages < maxPages && (more.requests || more.cpu)) {
        this.budget.charge("apiCalls");
        this.ledgerBudget?.charge("pagesPerDataset");
        this.ledgerBudget?.charge("graphqlQueries", Number(more.requests) + Number(more.cpu));
        const response = await fetch(`${API}/graphql`, {
          method: "POST",
          headers: authHeaders(await this.token()),
          body: JSON.stringify({
            query,
            variables: {
              account: this.env.BROLLY_ACCOUNT_ID,
              since: new Date(since).toISOString(),
              until: new Date(until).toISOString(),
              requestsCursor: cursors.requests,
              cpuCursor: cursors.cpu,
              requestsMore: more.requests,
              cpuMore: more.cpu,
            },
          }),
          signal: this.budget.signal,
        });
        if (!response.ok) throw await cloudflareApiError(response);
        type Group = { dimensions: { scriptName: string }; sum: { requests?: number; cpuTimeUs?: number } };
        const payload = await response.json() as { data?: { viewer?: { accounts?: Array<{ byRequests?: Group[]; byCpu?: Group[] }> } }; errors?: Array<{ message: string }> };
        if (payload.errors?.length) throw new Error(payload.errors.map(error => error.message).join("; "));
        const account = payload.data?.viewer?.accounts?.[0];
        const requestGroups = account?.byRequests ?? [];
        const cpuGroups = account?.byCpu ?? [];
        for (const group of requestGroups) {
          if (group.sum.requests === undefined || !group.dimensions.scriptName) continue;
          const value = workerMetric(this.env.BROLLY_ACCOUNT_ID, group.dimensions.scriptName, "requests", "requests", group.sum.requests, since, until, false, this.env.BROLLY_SELF_WORKER_NAME);
          samples.set(`${group.dimensions.scriptName}:requests`, value);
        }
        for (const group of cpuGroups) {
          if (group.sum.cpuTimeUs === undefined || !group.dimensions.scriptName) continue;
          const value = workerMetric(this.env.BROLLY_ACCOUNT_ID, group.dimensions.scriptName, "cpu_ms", "milliseconds", group.sum.cpuTimeUs / 1000, since, until, false, this.env.BROLLY_SELF_WORKER_NAME);
          samples.set(`${group.dimensions.scriptName}:cpu_ms`, value);
        }
        const lastRequest = requestGroups.at(-1)?.dimensions.scriptName;
        const lastCpu = cpuGroups.at(-1)?.dimensions.scriptName;
        if (lastRequest) cursors.requests = lastRequest;
        if (lastCpu) cursors.cpu = lastCpu;
        more.requests = requestGroups.length === pageSize;
        more.cpu = cpuGroups.length === pageSize;
        pages += 1;
      }
      const complete = !more.requests && !more.cpu;
      const detail = complete ? undefined : `Worker keyset pagination paused after ${pages} pages; the continuation is persisted`;
      const result = [...samples.values()];
      this.budget.charge("samples", result.length);
      return {
        samples: result,
        coverage: [
          ...coverageForMetrics("workers", ["requests", "cpu_ms"], complete ? "healthy" : "delayed", detail, "resource"),
          ...coverageForMetrics("workers", ["cache_requests"], "unavailable", "Brolly has the complete per-Worker data Cloudflare provides: requests and CPU time. Cloudflare reports cache charges only at the account level, so Brolly protects those costs with account and product limits instead of assigning them to individual Workers.", "resource"),
        ],
        continuation: complete ? null : {
          ...(more.requests ? { requests: cursors.requests } : {}),
          ...(more.cpu ? { cpu: cursors.cpu } : {}),
        },
        complete,
        pages,
        watermarkAt: until,
      };
    } catch (error) {
      const state = error instanceof CloudflareApiError && error.status === 403 ? "permission_denied" : "unavailable";
      return {
        samples: [...samples.values()],
        coverage: coverageForMetrics("workers", ["requests", "cpu_ms", "cache_requests"], state, error instanceof Error ? error.message : String(error), "resource"),
        continuation: { ...(more.requests ? { requests: cursors.requests } : {}), ...(more.cpu ? { cpu: cursors.cpu } : {}) },
        complete: false,
        pages,
        watermarkAt: until,
      };
    }
  }

  async billingUsage(since: number, until: number): Promise<BillingUsageRecord[] | null> {
    const token = await configuredBillingToken(this.env);
    if (!token) return null;
    try {
      const requested = await this.getBillingUsage(since, until, token);
      const aligned = billingAlignedStart(requested, since, until);
      if (aligned !== null) return await this.getBillingUsage(aligned, until, token);
      return requested;
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || ![403, 404].includes(error.status)) throw error;
      const requested = await this.getPaygoBillingUsage(since, until, token);
      const alignedRecords = requested.map(normalizePaygoBillingRecord);
      const aligned = billingAlignedStart(alignedRecords, since, until);
      if (aligned !== null) return (await this.getPaygoBillingUsage(aligned, until, token)).map(normalizePaygoBillingRecord);
      return alignedRecords;
    }
  }

  private async getBillingUsage(since: number, until: number, token: string): Promise<BillingUsageRecord[]> {
    const from = new Date(since).toISOString().slice(0, 10);
    const to = new Date(until).toISOString().slice(0, 10);
    const records = await this.get<BillingUsageRecord[]>(
      `/accounts/${this.env.BROLLY_ACCOUNT_ID}/billable/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      token,
    );
    // BillingPeriodStart is present on the v2 response. It tells us the
    // account's actual cycle boundary, which can differ from the first day of
    // the month. A query beginning mid-cycle silently omits that cycle.
    return records;
  }

  private async getPaygoBillingUsage(since: number, until: number, token: string): Promise<PaygoBillingUsageRecord[]> {
    const from = new Date(since).toISOString().slice(0, 10);
    return this.get<PaygoBillingUsageRecord[]>(
      `/accounts/${this.env.BROLLY_ACCOUNT_ID}/billable-usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date(until).toISOString().slice(0, 10))}`,
      token,
    );
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
    const authorization = authHeaders(token ?? await this.token());
    let response: Response;
    for (let attempt = 0; ; attempt += 1) {
      this.budget.charge("apiCalls");
      this.ledgerBudget?.charge("restRequests");
      response = await fetch(`${API}${path}`, {
        headers: authorization,
        signal: AbortSignal.any([this.budget.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (response.status !== 429 || attempt > 0) break;
      const retryAfter = retryAfterMilliseconds(response.headers.get("Retry-After"));
      if (retryAfter === null) break;
      await delayWithSignal(retryAfter, this.budget.signal);
    }
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

function normalizePaygoBillingRecord(row: PaygoBillingUsageRecord): BillingUsageRecord {
  const family = row.ServiceFamilyName ?? row.ServiceName;
  return {
    ChargePeriodStart: row.ChargePeriodStart,
    ChargePeriodEnd: row.ChargePeriodEnd,
    ConsumedQuantity: row.ConsumedQuantity,
    ConsumedUnit: row.ConsumedUnit,
    x_BillableMetricId: slug(row.ServiceName),
    x_BillableMetricName: row.ServiceName,
    x_ProductFamilyId: slug(family),
    x_ProductFamilyName: family,
    x_ZoneId: row.ZoneId,
    x_ZoneName: row.ZoneName,
    BillingPeriodStart: row.BillingPeriodStart,
    BillingPeriodEnd: row.BillingPeriodEnd,
    BilledCost: row.BilledCost,
    EffectiveCost: row.EffectiveCost,
    ListCost: row.ListCost,
  };
}

function startOfUtcDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function billingCycleStart(records: BillingUsageRecord[]): number | null {
  const starts = records.map(record => record.BillingPeriodStart ? Date.parse(record.BillingPeriodStart) : NaN)
    .filter(Number.isFinite);
  return starts.length ? Math.min(...starts) : null;
}

function billingAlignedStart(records: BillingUsageRecord[], since: number, until: number): number | null {
  const cycleStart = billingCycleStart(records);
  if (cycleStart === null) return null;
  // A short recurring window can begin after the current cycle's start. Walk
  // back one cycle when the resulting request remains within 90 days. A full
  // initial window keeps its first returned boundary to respect that maximum.
  const previous = previousCycleStart(cycleStart);
  const aligned = previous !== null && until - previous <= 90 * 86_400_000 ? previous : cycleStart;
  return aligned === startOfUtcDay(since) ? null : aligned;
}

function previousCycleStart(timestamp: number): number | null {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const previous = new Date(Date.UTC(year, month - 1, day));
  return previous.getUTCDate() === day ? previous.getTime() : null;
}

function retryAfterMilliseconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, REQUEST_TIMEOUT_MS);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.min(timestamp - Date.now(), REQUEST_TIMEOUT_MS));
}

async function delayWithSignal(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Cloudflare request aborted"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function catalogCapabilityGaps(accountId: string, checkedAt: number): CollectorCoverage[] {
  return METRIC_CATALOG
    .filter(product => product.family !== "workers" && product.family !== "durable_objects")
    .map(product => ({
      accountId,
      collectorKey: product.fastSource ? `${product.fastSource}:${product.family}` : "billing:catchall",
      dataset: product.family,
      available: false,
      retentionDays: null,
      samplingBehavior: null,
      finestScope: product.preferredScope,
      lastVerifiedAt: checkedAt,
      errorCode: "detailed_collector_unavailable",
      humanExplanation: product.billingSource
        ? "Authoritative billing lines remain visible. Detailed resource attribution is unavailable for this product."
        : "Cloudflare does not expose a supported account collector for this product.",
      state: "unavailable",
      watermarkAt: null,
    }));
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
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
function addDurableObjectGroup(
  samples: Map<string, MetricSample>,
  accountId: string,
  source: "requests" | "duration" | "websocket" | "rowsRead" | "rowsWritten" | "storageReads" | "storageWrites" | "storageDeletes",
  group: {
    dimensions: { namespaceId: string; objectId: string; type?: string };
    sum: {
      requests?: number; duration?: number; inboundWebsocketMsgCount?: number; rowsRead?: number;
      rowsWritten?: number; storageReadUnits?: number; storageWriteUnits?: number; storageDeletes?: number;
    };
  },
  since: number,
  until: number,
): void {
  const definition = source === "requests"
    ? group.dimensions.type === "hibernation"
      ? ["incoming_websocket_messages", "count", group.sum.requests]
      : ["requests", "requests", group.sum.requests]
    : source === "duration" ? ["duration_gb_seconds", "gb_seconds", group.sum.duration]
      : source === "websocket" ? ["incoming_websocket_messages", "count", group.sum.inboundWebsocketMsgCount]
        : source === "rowsRead" ? ["rows_read", "rows", group.sum.rowsRead]
          : source === "rowsWritten" ? ["rows_written", "rows", group.sum.rowsWritten]
            : source === "storageReads" ? ["kv_read_units", "count", group.sum.storageReadUnits]
              : source === "storageWrites" ? ["kv_write_units", "count", group.sum.storageWriteUnits]
                : ["kv_delete_requests", "requests", group.sum.storageDeletes];
  const [name, unit, rawValue] = definition as [string, MetricSample["unit"], number | undefined];
  if (rawValue === undefined || !group.dimensions.objectId) return;
  const asset: AssetRef = {
    accountId, family: "durable_objects", id: group.dimensions.objectId,
    parentId: group.dimensions.namespaceId, scope: "object", tier: "unclassified",
  };
  const key = `${asset.parentId}:${asset.id}:${name}`;
  const next = metric(asset, name, unit, rawValue, since, until, false);
  const existing = samples.get(key);
  if (!existing) {
    samples.set(key, next);
    return;
  }
  existing.value += next.value;
  existing.estimatedCostUsd = (existing.estimatedCostUsd ?? 0) + (next.estimatedCostUsd ?? 0);
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
function workerMetric(accountId: string, scriptName: string, name: "requests" | "cpu_ms", unit: MetricSample["unit"], value: number, start: number, end: number, sampled: boolean, selfWorker?: string): MetricSample {
  const asset: AssetRef = { accountId, family: "workers", id: scriptName, name: scriptName, scope: "resource", tier: isBrollyScript(scriptName, selfWorker) ? "control_plane" : "unclassified" };
  const unitPrice = name === "requests" ? 0.30 / 1_000_000 : 0.02 / 1_000_000;
  return { asset, metric: name, unit, value, start, end, source: "graphql", estimatedCostUsd: value * unitPrice, sampled };
}
function isBrollyScript(value: string, configured?: string): boolean {
  return value === (configured ?? "brolly-guard") || value === "brolly-guard" || value.startsWith("brolly-guard-");
}
function coverageForMetrics(family: string, metrics: string[], state: CoverageResult["state"], detail?: string, scope?: AssetRef["scope"]): CoverageResult[] {
  const definition = METRIC_CATALOG.find(item => item.family === family);
  if (!definition) return [];
  return metrics.map(metric => ({ family, metric, finestScope: scope ?? definition.preferredScope, state, checkedAt: Date.now(), detail }));
}
function inventoryCoverage(family: string, scope: AssetRef["scope"], state: CoverageResult["state"], detail?: string): CoverageResult {
  return { family, metric: "asset_inventory", finestScope: scope, state, checkedAt: Date.now(), detail };
}
