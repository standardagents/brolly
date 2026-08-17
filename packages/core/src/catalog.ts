import type { MetricDefinition } from "./ledger-types.js";

export interface ProductMetricDefinition {
  family: string;
  metrics: string[];
  preferredScope: "account" | "zone" | "resource" | "namespace" | "object";
  fastSource: "graphql" | "rest" | "runtime" | null;
  billingSource: boolean;
}

export const METRIC_CATALOG_VERSION = "2026-08-17";

/**
 * Families Brolly can act on, as opposed to only watch, and how. Workers and
 * Durable Objects are quarantined through the deployment-carried fuse
 * (`runtime_quarantine`; Workers can also lose their triggers via
 * `disable_trigger`). Queues are paused by disabling the consumer
 * (`pause_consumer`). Every other family has no control action: Brolly
 * monitors usage and billing for it and alerts, but cannot cap its spend.
 */
export const FAMILY_CONTROLS = { workers: "quarantine", durable_objects: "quarantine", queues: "pause" } as const;
export type EnforceableFamily = keyof typeof FAMILY_CONTROLS;
export type FamilyControl = (typeof FAMILY_CONTROLS)[EnforceableFamily];
export const ENFORCEABLE_FAMILIES = Object.keys(FAMILY_CONTROLS) as EnforceableFamily[];
export function familyControl(family: string): FamilyControl | null {
  return family in FAMILY_CONTROLS ? FAMILY_CONTROLS[family as EnforceableFamily] : null;
}

export const METRIC_CATALOG: ProductMetricDefinition[] = [
  { family: "workers", metrics: ["requests", "cpu_ms", "cache_requests"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  {
    family: "durable_objects",
    metrics: [
      "requests",
      "duration_gb_seconds",
      "incoming_websocket_messages",
      "rows_read",
      "rows_written",
      "kv_read_units",
      "kv_write_units",
      "kv_delete_requests",
      "sql_storage_bytes",
      "kv_storage_bytes",
    ],
    preferredScope: "object",
    fastSource: "graphql",
    billingSource: true,
  },
  { family: "workers_ai", metrics: ["neurons", "requests"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "queues", metrics: ["operations", "messages", "bytes"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "d1", metrics: ["rows_read", "rows_written", "storage_bytes"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "r2", metrics: ["class_a", "class_b", "storage_bytes", "egress_bytes"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "kv", metrics: ["reads", "writes", "deletes", "lists", "storage_bytes"], preferredScope: "namespace", fastSource: "graphql", billingSource: true },
  { family: "pages", metrics: ["requests", "builds"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "images", metrics: ["transformations", "stored_images", "delivery"], preferredScope: "account", fastSource: "graphql", billingSource: true },
  { family: "stream", metrics: ["minutes_stored", "minutes_delivered"], preferredScope: "account", fastSource: "graphql", billingSource: true },
  { family: "vectorize", metrics: ["queried_dimensions", "stored_dimensions"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "hyperdrive", metrics: ["database_queries"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "ai_gateway", metrics: ["requests", "tokens", "cost_usd"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "containers", metrics: ["vcpu_seconds", "memory_gb_seconds", "disk_gb_seconds", "egress_bytes"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "browser_rendering", metrics: ["sessions", "session_minutes"], preferredScope: "account", fastSource: "graphql", billingSource: true },
  { family: "workflows", metrics: ["requests", "cpu_ms", "steps", "storage_bytes"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "worker_builds", metrics: ["build_minutes"], preferredScope: "account", fastSource: "graphql", billingSource: true },
  { family: "analytics_engine", metrics: ["data_points_written", "data_points_read", "queries", "storage_bytes"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "log_explorer", metrics: ["ingested_bytes", "queries", "storage_bytes"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "zones", metrics: ["requests", "bandwidth_bytes"], preferredScope: "zone", fastSource: "graphql", billingSource: true },
  { family: "email", metrics: ["sent", "routed"], preferredScope: "zone", fastSource: "graphql", billingSource: true },
  { family: "unknown", metrics: ["authoritative_usage", "authoritative_cost_usd"], preferredScope: "account", fastSource: null, billingSource: true },
];

const DISPLAY_NAMES: Record<string, string> = {
  cpu_ms: "CPU time",
  duration_gb_seconds: "Duration",
  incoming_websocket_messages: "Incoming WebSocket messages",
  rows_read: "Rows read",
  rows_written: "Rows written",
  storage_bytes: "Storage",
  egress_bytes: "Egress",
  cost_usd: "Provider cost",
  authoritative_cost_usd: "Authoritative cost",
};

const MAXIMUM_METRICS = new Set(["storage_bytes", "sql_storage_bytes", "kv_storage_bytes", "stored_dimensions"]);

const USAGE_METRIC_DEFINITIONS: MetricDefinition[] = METRIC_CATALOG.flatMap(product =>
  product.metrics.map(metricKey => ({
    id: `${product.family}:${metricKey}`,
    productFamily: product.family,
    metricKey,
    displayName: DISPLAY_NAMES[metricKey] ?? metricKey.replaceAll("_", " ").replace(/\b\w/g, value => value.toUpperCase()),
    unit: metricUnit(metricKey),
    aggregationKind: MAXIMUM_METRICS.has(metricKey) ? "maximum" as const : "sum" as const,
    billingMapping: product.billingSource ? metricKey : null,
    collectorKey: product.fastSource ? `${product.fastSource}:${product.family}` : "billing:catchall",
    finestScope: product.preferredScope,
    active: true,
  })),
);

const COST_METRIC_DEFINITIONS: MetricDefinition[] = [
  {
    id: "account:estimated_cost_usd",
    productFamily: "account",
    metricKey: "estimated_cost_usd",
    displayName: "Estimated cost",
    unit: "usd",
    aggregationKind: "sum",
    billingMapping: null,
    collectorKey: "ledger:cost",
    finestScope: "account",
    active: true,
  },
  {
    id: "account:billed_cost_usd",
    productFamily: "account",
    metricKey: "billed_cost_usd",
    displayName: "Billed cost",
    unit: "usd",
    aggregationKind: "sum",
    billingMapping: "billed_cost",
    collectorKey: "billing:billable-usage",
    finestScope: "account",
    active: true,
  },
  ...METRIC_CATALOG.flatMap(product => [
    {
      id: `${product.family}:estimated_cost_usd`,
      productFamily: product.family,
      metricKey: "estimated_cost_usd",
      displayName: "Estimated cost",
      unit: "usd" as const,
      aggregationKind: "sum" as const,
      billingMapping: null,
      collectorKey: "ledger:cost",
      finestScope: product.preferredScope,
      active: true,
    },
    {
      id: `${product.family}:billed_cost_usd`,
      productFamily: product.family,
      metricKey: "billed_cost_usd",
      displayName: "Billed cost",
      unit: "usd" as const,
      aggregationKind: "sum" as const,
      billingMapping: "billed_cost",
      collectorKey: "billing:billable-usage",
      finestScope: "product" as const,
      active: true,
    },
  ]),
];

export const METRIC_DEFINITIONS: MetricDefinition[] = [
  ...USAGE_METRIC_DEFINITIONS,
  ...COST_METRIC_DEFINITIONS,
];

function metricUnit(metric: string): MetricDefinition["unit"] {
  if (metric.includes("cost")) return "usd";
  if (metric.includes("gb_seconds")) return "gb_seconds";
  if (metric.includes("byte") || metric.includes("storage") || metric.includes("egress")) return "bytes";
  if (metric.includes("row")) return "rows";
  if (metric.includes("request")) return "requests";
  if (metric.includes("duration_gb")) return "gb_seconds";
  if (metric.includes("cpu") || metric.includes("minute") || metric.includes("second")) return "milliseconds";
  return "count";
}
