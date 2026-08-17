import type { AssetRef, MetricSample } from "@standardagents/brolly-core";

export type ProductUsageFamily =
  | "workers_ai" | "queues" | "d1" | "r2" | "kv" | "pages" | "images"
  | "stream" | "vectorize" | "hyperdrive" | "ai_gateway" | "containers"
  | "browser_rendering" | "workflows" | "worker_builds" | "analytics_engine"
  | "log_explorer" | "zones" | "email";

export type ProductUsageCollector = `graphql:${ProductUsageFamily}`;

type Aggregate = "count" | "sum" | "max";
type QueryRoot = "account" | "zone";
type TimeKind = "date" | "time";

export interface DatasetMetric {
  metric: string;
  unit: MetricSample["unit"];
  aggregate: Aggregate;
  fields?: string[];
  factor?: number;
  actions?: string[];
}

export interface ProductDatasetDefinition {
  dataset: string;
  alias: string;
  root?: QueryRoot;
  timeKind: TimeKind;
  timeField: string;
  dimensions?: string[];
  resourceDimension?: string;
  parentDimension?: string;
  metrics: DatasetMetric[];
}

export interface ProductUsageDefinition {
  collector: ProductUsageCollector;
  family: ProductUsageFamily;
  label: string;
  retentionDays: number;
  scope: AssetRef["scope"];
  datasets: ProductDatasetDefinition[];
  billingOnlyMetrics: string[];
}

const metric = (
  name: string,
  unit: MetricSample["unit"],
  aggregate: Aggregate,
  fields: string[] = [],
  extras: Pick<DatasetMetric, "factor" | "actions"> = {},
): DatasetMetric => ({ metric: name, unit, aggregate, fields, ...extras });

const dataset = (
  name: string,
  timeKind: TimeKind,
  timeField: string,
  metrics: DatasetMetric[],
  options: Partial<Omit<ProductDatasetDefinition, "dataset" | "alias" | "timeKind" | "timeField" | "metrics">> = {},
): ProductDatasetDefinition => ({ dataset: name, alias: name.replace(/[^A-Za-z0-9_]/g, "_"), timeKind, timeField, metrics, ...options });

const R2_CLASS_A_ACTIONS = [
  "PutObject", "CopyObject", "ListBuckets", "ListObjects", "CreateMultipartUpload",
  "UploadPart", "CompleteMultipartUpload", "AbortMultipartUpload", "DeleteObject",
];

/**
 * Explicit billable-usage adapters for Cloudflare product datasets. Settings
 * discovery decides whether each dataset is enabled for the connected account.
 */
export const PRODUCT_USAGE_DEFINITIONS: readonly ProductUsageDefinition[] = [
  definition("workers_ai", "Workers AI", 32, "resource", [
    dataset("aiInferenceAdaptiveGroups", "time", "datetime", [
      metric("requests", "requests", "count"), metric("neurons", "count", "sum", ["totalNeurons"]),
    ], { dimensions: ["modelId"], resourceDimension: "modelId" }),
  ]),
  definition("queues", "Queues", 90, "resource", [
    dataset("queueMessageOperationsAdaptiveGroups", "time", "datetime", [
      metric("operations", "count", "sum", ["billableOperations"]), metric("messages", "count", "count"), metric("bytes", "bytes", "sum", ["bytes"]),
    ], { dimensions: ["queueId"], resourceDimension: "queueId" }),
  ]),
  definition("d1", "D1", 90, "resource", [
    dataset("d1AnalyticsAdaptiveGroups", "date", "date", [
      metric("rows_read", "rows", "sum", ["rowsRead"]), metric("rows_written", "rows", "sum", ["rowsWritten"]),
    ], { dimensions: ["databaseId"], resourceDimension: "databaseId" }),
    dataset("d1StorageAdaptiveGroups", "date", "date", [metric("storage_bytes", "bytes", "max", ["databaseSizeBytes"])], {
      dimensions: ["databaseId"], resourceDimension: "databaseId",
    }),
  ]),
  definition("r2", "R2", 90, "resource", [
    dataset("r2OperationsAdaptiveGroups", "time", "datetime", [
      metric("class_a", "count", "sum", ["requests"], { actions: R2_CLASS_A_ACTIONS }),
      metric("class_b", "count", "sum", ["requests"], { actions: R2_CLASS_A_ACTIONS }),
      metric("egress_bytes", "bytes", "sum", ["responseBytes"]),
    ], { dimensions: ["bucketName", "actionType"], resourceDimension: "bucketName" }),
    dataset("r2StorageAdaptiveGroups", "time", "datetime", [metric("storage_bytes", "bytes", "max", ["payloadSize", "metadataSize"])], {
      dimensions: ["bucketName"], resourceDimension: "bucketName",
    }),
  ]),
  definition("kv", "Workers KV", 90, "namespace", [
    dataset("kvOperationsAdaptiveGroups", "date", "date", [
      metric("reads", "count", "sum", ["requests"], { actions: ["read"] }),
      metric("writes", "count", "sum", ["requests"], { actions: ["write"] }),
      metric("deletes", "count", "sum", ["requests"], { actions: ["delete"] }),
      metric("lists", "count", "sum", ["requests"], { actions: ["list"] }),
    ], { dimensions: ["namespaceId", "actionType"], resourceDimension: "namespaceId" }),
    dataset("kvStorageAdaptiveGroups", "date", "date", [metric("storage_bytes", "bytes", "max", ["byteCount"])], {
      dimensions: ["namespaceId"], resourceDimension: "namespaceId",
    }),
  ]),
  definition("pages", "Pages Functions", 90, "resource", [
    dataset("pagesFunctionsInvocationsAdaptiveGroups", "time", "datetime", [metric("requests", "requests", "sum", ["requests"])], {
      dimensions: ["scriptName"], resourceDimension: "scriptName",
    }),
  ], ["builds"]),
  definition("images", "Images", 31, "account", [
    dataset("imagesRequestsAdaptiveGroups", "date", "date", [metric("delivery", "requests", "sum", ["requests"])]),
    dataset("imagesTransformationsAdaptiveGroups", "date", "date", [metric("transformations", "count", "sum", ["billableEventCount"])]),
  ], ["stored_images"]),
  definition("stream", "Stream", 90, "resource", [
    dataset("streamMinutesViewedAdaptiveGroups", "date", "date", [metric("minutes_delivered", "milliseconds", "sum", ["minutesViewed"], { factor: 60_000 })], {
      dimensions: ["uid"], resourceDimension: "uid",
    }),
  ], ["minutes_stored"]),
  definition("vectorize", "Vectorize", 32, "resource", [
    dataset("vectorizeV2QueriesAdaptiveGroups", "time", "datetime", [metric("queried_dimensions", "count", "sum", ["queriedVectorDimensions"])], {
      dimensions: ["indexName"], resourceDimension: "indexName",
    }),
    dataset("vectorizeV2StorageAdaptiveGroups", "time", "datetime", [metric("stored_dimensions", "count", "max", ["storedVectorDimensions"])], {
      dimensions: ["indexName"], resourceDimension: "indexName",
    }),
  ]),
  definition("hyperdrive", "Hyperdrive", 32, "resource", [
    dataset("hyperdriveQueriesAdaptiveGroups", "time", "datetime", [metric("database_queries", "count", "count")], {
      dimensions: ["configId"], resourceDimension: "configId",
    }),
  ]),
  definition("ai_gateway", "AI Gateway", 62, "resource", [
    dataset("aiGatewayRequestsAdaptiveGroups", "time", "datetimeHour", [
      metric("requests", "requests", "count"),
      metric("tokens", "count", "sum", ["cachedTokensIn", "cachedTokensOut", "uncachedTokensIn", "uncachedTokensOut"]),
      metric("cost_usd", "usd", "sum", ["cost"]),
    ], { dimensions: ["gateway"], resourceDimension: "gateway" }),
  ]),
  definition("containers", "Containers", 32, "resource", [
    dataset("containersUsageAdaptiveGroups", "date", "date", [
      metric("vcpu_seconds", "milliseconds", "sum", ["cpuTimeSec"], { factor: 1_000 }),
      metric("memory_gb_seconds", "gb_seconds", "sum", ["allocatedMemory"], { factor: 1 / 1_000_000_000 }),
      metric("disk_gb_seconds", "gb_seconds", "sum", ["allocatedDisk"], { factor: 1 / 1_000_000_000 }),
      metric("egress_bytes", "bytes", "sum", ["txBytes"]),
    ], { dimensions: ["instanceId", "applicationId"], resourceDimension: "instanceId", parentDimension: "applicationId" }),
  ]),
  definition("browser_rendering", "Browser Rendering", 32, "account", [
    dataset("browserRenderingBrowserTimeUsageAdaptiveGroups", "time", "datetime", [
      metric("sessions", "count", "count"), metric("session_minutes", "milliseconds", "sum", ["totalSessionDurationMs"]),
    ]),
  ]),
  definition("workflows", "Workflows", 32, "resource", [
    dataset("workflowsAdaptiveGroups", "time", "datetimeHour", [metric("requests", "requests", "count")], {
      dimensions: ["workflowName"], resourceDimension: "workflowName",
    }),
  ], ["cpu_ms", "steps", "storage_bytes"]),
  definition("worker_builds", "Worker Builds", 32, "account", [
    dataset("workersBuildsBuildMinutesAdaptiveGroups", "date", "date", [metric("build_minutes", "milliseconds", "sum", ["buildMinutes"], { factor: 60_000 })]),
  ]),
  definition("analytics_engine", "Analytics Engine", 31, "resource", [
    dataset("workersAnalyticsEngineAdaptiveGroups", "time", "datetime", [metric("data_points_written", "count", "count")], {
      dimensions: ["dataset"], resourceDimension: "dataset",
    }),
  ], ["data_points_read", "queries", "storage_bytes"]),
  definition("log_explorer", "Log Explorer", 32, "resource", [
    dataset("logExplorerIngestionAdaptiveGroups", "time", "datetime", [metric("ingested_bytes", "bytes", "sum", ["billableBytes"])], {
      dimensions: ["dataset", "zoneTag"], resourceDimension: "dataset", parentDimension: "zoneTag",
    }),
  ], ["queries", "storage_bytes"]),
  definition("zones", "Zones", 30, "zone", [
    dataset("httpRequestsAdaptiveGroups", "time", "datetime", [
      metric("requests", "requests", "count"), metric("bandwidth_bytes", "bytes", "sum", ["edgeResponseBytes"]),
    ], { root: "zone" }),
  ]),
  definition("email", "Email", 30, "zone", [
    dataset("emailSendingAdaptiveGroups", "time", "datetime", [metric("sent", "count", "count")], { root: "zone" }),
    dataset("emailRoutingAdaptiveGroups", "time", "datetime", [metric("routed", "count", "count")], { root: "zone" }),
  ]),
] as const;

const BY_COLLECTOR = new Map(PRODUCT_USAGE_DEFINITIONS.map(item => [item.collector, item]));
const BY_DATASET = new Map(PRODUCT_USAGE_DEFINITIONS.flatMap(item => item.datasets.map(value => [value.dataset, item] as const)));

export function productUsageDefinition(collector: string): ProductUsageDefinition | undefined {
  return BY_COLLECTOR.get(collector as ProductUsageCollector);
}

export function productDefinitionForDataset(name: string): ProductUsageDefinition | undefined {
  return BY_DATASET.get(name);
}

export function buildProductDatasetQuery(definition: ProductUsageDefinition, source: ProductDatasetDefinition): string {
  const variableType = source.timeKind === "date" ? "Date" : "Time";
  const filter = source.timeKind === "date"
    ? `${source.timeField}_geq: $start, ${source.timeField}_leq: $end`
    : `${source.timeField}_geq: $start, ${source.timeField}_lt: $end`;
  const aggregates = [...new Set(source.metrics.map(item => item.aggregate))];
  const body = [
    source.dimensions?.length ? `dimensions { ${source.dimensions.join(" ")} }` : "",
    aggregates.includes("count") ? "count" : "",
    ...(["sum", "max"] as const).map(aggregate => {
      const fields = [...new Set(source.metrics.filter(item => item.aggregate === aggregate).flatMap(item => item.fields ?? []))];
      return fields.length ? `${aggregate} { ${fields.join(" ")} }` : "";
    }),
  ].filter(Boolean).join("\n");
  const selection = `${source.alias}: ${source.dataset}(limit: 10000, filter: { ${filter} }) { ${body} }`;
  if ((source.root ?? "account") === "zone") {
    return `query BrollyProductUsage($zones: [string!]!, $start: ${variableType}!, $end: ${variableType}!) { viewer { zones(filter: { zoneTag_in: $zones }) { zoneTag ${selection} } } }`;
  }
  return `query BrollyProductUsage($account: String!, $start: ${variableType}!, $end: ${variableType}!) { viewer { accounts(filter: { accountTag: $account }) { ${selection} } } }`;
}

export function productDatasetVariables(source: ProductDatasetDefinition, accountId: string, startsAt: number, endsAt: number, zoneIds: string[] = []): Record<string, string | string[]> {
  const scope: Record<string, string | string[]> = (source.root ?? "account") === "zone"
    ? { zones: zoneIds }
    : { account: accountId };
  if (source.timeKind === "date") {
    const day = new Date(startsAt).toISOString().slice(0, 10);
    return { ...scope, start: day, end: day };
  }
  return { ...scope, start: new Date(startsAt).toISOString(), end: new Date(endsAt).toISOString() };
}

export function normalizeProductDataset(
  definition: ProductUsageDefinition,
  source: ProductDatasetDefinition,
  roots: Array<Record<string, unknown>>,
  accountId: string,
  startsAt: number,
  endsAt: number,
): MetricSample[] {
  const samples = new Map<string, MetricSample>();
  for (const root of roots) {
    const zoneTag = stringValue(root.zoneTag);
    const rows = Array.isArray(root[source.alias]) ? root[source.alias] as Array<Record<string, unknown>> : [];
    for (const row of rows) {
      const dimensions = recordValue(row.dimensions);
      const action = stringValue(dimensions.actionType)?.toLowerCase();
      const resource = source.resourceDimension ? stringValue(dimensions[source.resourceDimension]) : undefined;
      const parent = source.parentDimension ? stringValue(dimensions[source.parentDimension]) : undefined;
      const scope = zoneTag ? "zone" : resource ? definition.scope : "account";
      const id = zoneTag ?? resource ?? definition.family;
      const asset: AssetRef = {
        accountId, family: definition.family, id, name: id, scope,
        ...(parent ? { parentId: parent } : {}), tier: "unclassified",
      };
      for (const item of source.metrics) {
        if (item.actions?.length) {
          const actions = item.actions.map(value => value.toLowerCase());
          const matches = action ? actions.includes(action) : false;
          if (item.metric === "class_b" ? matches : !matches) continue;
        }
        const aggregate = item.aggregate === "count" ? row : recordValue(row[item.aggregate]);
        const raw = item.aggregate === "count"
          ? numberValue(row.count)
          : (item.fields ?? []).reduce((sum, field) => sum + numberValue(aggregate[field]), 0);
        const value = raw * (item.factor ?? 1);
        if (!Number.isFinite(value)) continue;
        const key = `${asset.scope}:${asset.id}:${item.metric}`;
        const existing = samples.get(key);
        if (existing) {
          existing.value = item.aggregate === "max" ? Math.max(existing.value, value) : existing.value + value;
        } else {
          samples.set(key, {
            asset, metric: item.metric, unit: item.unit, value, start: startsAt, end: endsAt,
            source: "graphql", sampled: false,
          });
        }
      }
    }
  }
  return [...samples.values()];
}

function definition(
  family: ProductUsageFamily,
  label: string,
  retentionDays: number,
  scope: AssetRef["scope"],
  datasets: ProductDatasetDefinition[],
  billingOnlyMetrics: string[] = [],
): ProductUsageDefinition {
  return { collector: `graphql:${family}`, family, label, retentionDays, scope, datasets, billingOnlyMetrics };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }
function numberValue(value: unknown): number { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
