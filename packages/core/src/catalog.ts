import type { MetricDefinition } from "./ledger-types.js";

export interface ProductMetricDefinition {
  family: string;
  metrics: string[];
  preferredScope: "account" | "zone" | "resource" | "namespace" | "object";
  fastSource: "graphql" | "rest" | "runtime" | null;
  billingSource: boolean;
}

export const METRIC_CATALOG_VERSION = "2026-08-31.1";

export type ProductMetricRole = "billable" | "shared_billing" | "quota" | "provider_cost" | "supporting";
export type ProductMetricHistorySource = "graphql" | "billing" | "graphql_or_billing" | "provider" | "none";
export type ProductMetricBillingKind = "independent" | "shared" | "conditional" | "quota_only" | "announced" | "provider" | "none";

export interface ProductLimitMetricPresentation {
  id: string;
  family: string;
  label: string;
  unit: string;
  role: Exclude<ProductMetricRole, "supporting">;
  billingKind: ProductMetricBillingKind;
  condition?: string;
  sharedBillingMetricId?: string;
}

export interface ProductMetricContract {
  id: string;
  family: string;
  metricKey: string;
  label: string;
  unit: string;
  role: ProductMetricRole;
  productLimit: boolean;
  historySource: ProductMetricHistorySource;
  billingKind: ProductMetricBillingKind;
  billingUnit: string;
  condition?: string;
  sharedBillingMetricId?: string;
  pricingReference: string;
  billingAliases?: readonly string[];
}

const PRICING_REFERENCES = {
  workers: "https://developers.cloudflare.com/workers/platform/pricing/",
  durable_objects: "https://developers.cloudflare.com/durable-objects/platform/pricing/",
  workers_ai: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
  queues: "https://developers.cloudflare.com/queues/platform/pricing/",
  d1: "https://developers.cloudflare.com/d1/platform/pricing/",
  r2: "https://developers.cloudflare.com/r2/pricing/",
  kv: "https://developers.cloudflare.com/kv/platform/pricing/",
  pages: "https://developers.cloudflare.com/pages/functions/pricing/",
  images: "https://developers.cloudflare.com/images/pricing/",
  stream: "https://developers.cloudflare.com/stream/pricing/",
  vectorize: "https://developers.cloudflare.com/vectorize/platform/pricing/",
  hyperdrive: "https://developers.cloudflare.com/hyperdrive/platform/pricing/",
  ai_gateway: "https://developers.cloudflare.com/ai-gateway/reference/pricing/",
  containers: "https://developers.cloudflare.com/containers/platform/pricing/",
  browser_rendering: "https://developers.cloudflare.com/browser-run/pricing/",
  workflows: "https://developers.cloudflare.com/workflows/reference/pricing/",
  worker_builds: "https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/",
  analytics_engine: "https://developers.cloudflare.com/analytics/analytics-engine/pricing/",
  log_explorer: "https://developers.cloudflare.com/log-explorer/pricing/",
  email: "https://developers.cloudflare.com/email-service/platform/pricing/",
} as const;

type SupportedProductFamily = keyof typeof PRICING_REFERENCES;

interface ContractOptions {
  billingAliases?: readonly string[];
  billingKind?: ProductMetricBillingKind;
  billingUnit?: string;
  condition?: string;
  sharedBillingMetricId?: string;
}

function createContract(
  family: SupportedProductFamily,
  metricKey: string,
  label: string,
  unit: string,
  role: ProductMetricRole,
  productLimit: boolean,
  historySource: ProductMetricHistorySource,
  options: ContractOptions = {},
): ProductMetricContract {
  const billingKind = options.billingKind ?? (role === "billable" ? "independent"
    : role === "shared_billing" ? "shared"
      : role === "quota" ? "quota_only"
        : role === "provider_cost" ? "provider" : "none");
  return {
    id: `${family}:${metricKey}`,
    family,
    metricKey,
    label,
    unit,
    role,
    productLimit,
    historySource,
    billingKind,
    billingUnit: options.billingUnit ?? unit,
    pricingReference: PRICING_REFERENCES[family],
    ...(options.billingAliases?.length ? { billingAliases: options.billingAliases } : {}),
    ...(options.condition ? { condition: options.condition } : {}),
    ...(options.sharedBillingMetricId ? { sharedBillingMetricId: options.sharedBillingMetricId } : {}),
  };
}

function contract(
  family: SupportedProductFamily,
  metricKey: string,
  label: string,
  unit: string,
  role: Exclude<ProductMetricRole, "supporting" | "provider_cost">,
  historySource: ProductMetricHistorySource,
  options: ContractOptions = {},
): ProductMetricContract {
  return createContract(family, metricKey, label, unit, role, true, historySource, options);
}

function supporting(
  family: SupportedProductFamily,
  metricKey: string,
  label: string,
  unit: string,
  historySource: ProductMetricHistorySource,
): ProductMetricContract {
  return createContract(family, metricKey, label, unit, "supporting", false, historySource);
}

function providerCost(
  family: SupportedProductFamily,
  metricKey: string,
  label: string,
  unit: string,
  historySource: ProductMetricHistorySource,
): ProductMetricContract {
  return createContract(family, metricKey, label, unit, "provider_cost", false, historySource);
}

/**
 * Account-independent Cloudflare meter contract. Product usage changes values
 * and coverage only. It never changes which limits Brolly offers.
 */
export const PRODUCT_METRIC_CONTRACTS: readonly ProductMetricContract[] = [
  contract("workers", "requests", "Requests", "requests", "billable", "graphql_or_billing", { billingAliases: ["workers_requests", "workers_standard_requests"] }),
  contract("workers", "cpu_ms", "CPU time", "ms", "billable", "graphql_or_billing", { billingAliases: ["workers_cpu_time", "workers_standard_cpu_time"] }),
  supporting("workers", "cache_requests", "Cache-served requests", "requests", "graphql"),

  contract("durable_objects", "requests", "Requests", "requests", "billable", "graphql_or_billing", { billingAliases: ["durable_object_requests", "durable_objects_requests"] }),
  contract("durable_objects", "duration_gb_seconds", "Compute duration", "GB-s", "billable", "graphql_or_billing"),
  supporting("durable_objects", "incoming_websocket_messages", "WebSocket messages", "messages", "graphql"),
  contract("durable_objects", "rows_read", "SQLite rows read", "rows", "billable", "graphql_or_billing"),
  contract("durable_objects", "rows_written", "SQLite rows written", "rows", "billable", "graphql_or_billing"),
  contract("durable_objects", "kv_read_units", "KV read units", "4 KiB units", "billable", "graphql_or_billing"),
  contract("durable_objects", "kv_write_units", "KV write units", "4 KiB units", "billable", "graphql_or_billing"),
  contract("durable_objects", "kv_delete_requests", "KV deletes", "requests", "billable", "graphql_or_billing"),
  contract("durable_objects", "sql_storage_bytes", "SQLite storage", "bytes", "billable", "graphql_or_billing", { billingUnit: "GB-month" }),
  contract("durable_objects", "kv_storage_bytes", "KV storage", "bytes", "billable", "graphql_or_billing", { billingUnit: "GB-month" }),

  contract("workers_ai", "neurons", "Neurons", "neurons", "billable", "graphql_or_billing"),
  supporting("workers_ai", "requests", "Inference requests", "requests", "graphql"),
  contract("queues", "operations", "Billable operations", "operations", "billable", "graphql_or_billing", { billingAliases: ["queue_operations"], billingUnit: "64 KiB operation chunks" }),
  supporting("queues", "messages", "Messages", "messages", "graphql"),
  supporting("queues", "bytes", "Message bytes", "bytes", "graphql"),
  contract("d1", "rows_read", "Rows read", "rows", "billable", "graphql_or_billing"),
  contract("d1", "rows_written", "Rows written", "rows", "billable", "graphql_or_billing"),
  contract("d1", "storage_bytes", "Storage", "bytes", "billable", "graphql_or_billing", { billingAliases: ["d1_storage"], billingUnit: "GB-month" }),

  contract("r2", "class_a", "Class A operations", "operations", "billable", "graphql_or_billing", { billingAliases: ["class_a_operations"] }),
  contract("r2", "class_b", "Class B operations", "operations", "billable", "graphql_or_billing", { billingAliases: ["class_b_operations"] }),
  contract("r2", "storage_bytes", "Storage", "bytes", "billable", "graphql_or_billing", { billingAliases: ["r2_storage"], billingUnit: "GB-month" }),
  contract("r2", "retrieval_bytes", "Infrequent Access retrieval", "bytes", "billable", "billing", {
    billingKind: "conditional", billingUnit: "GB retrieved", condition: "Applies to objects stored in Infrequent Access.",
  }),
  supporting("r2", "egress_bytes", "Egress", "bytes", "graphql"),

  contract("kv", "reads", "Reads", "operations", "billable", "graphql_or_billing"),
  contract("kv", "writes", "Writes", "operations", "billable", "graphql_or_billing"),
  contract("kv", "deletes", "Deletes", "operations", "billable", "graphql_or_billing"),
  contract("kv", "lists", "Lists", "operations", "billable", "graphql_or_billing"),
  contract("kv", "storage_bytes", "Storage", "bytes", "billable", "graphql_or_billing", { billingUnit: "GB-month" }),

  contract("pages", "requests", "Function requests", "requests", "shared_billing", "graphql", { sharedBillingMetricId: "workers:requests" }),
  contract("images", "transformations", "Unique transformations", "transformations", "billable", "graphql_or_billing"),
  contract("images", "stored_images", "Stored images", "images", "billable", "billing", { billingUnit: "images stored per month" }),
  contract("images", "delivery", "Images delivered", "images", "billable", "billing", { billingUnit: "images delivered" }),
  contract("stream", "minutes_stored", "Video stored", "minutes", "billable", "billing", { billingUnit: "stored video minutes" }),
  contract("stream", "minutes_delivered", "Video delivered", "minutes", "billable", "graphql_or_billing"),
  contract("vectorize", "queried_dimensions", "Queried vector dimensions", "dimensions", "billable", "graphql_or_billing"),
  contract("vectorize", "stored_dimensions", "Stored vector dimensions", "dimensions", "billable", "graphql_or_billing", { billingUnit: "stored dimensions per month" }),
  contract("hyperdrive", "database_queries", "Database queries", "queries", "quota", "graphql"),

  supporting("ai_gateway", "requests", "Gateway requests", "requests", "graphql"),
  supporting("ai_gateway", "tokens", "Provider tokens", "tokens", "graphql"),
  providerCost("ai_gateway", "cost_usd", "Provider-reported model cost", "USD", "graphql"),
  contract("ai_gateway", "logpush_requests", "Logpush requests", "requests", "billable", "billing", {
    billingKind: "conditional", condition: "Applies when AI Gateway Logpush is enabled.",
  }),
  contract("containers", "vcpu_seconds", "CPU time", "vCPU-s", "billable", "graphql_or_billing"),
  contract("containers", "memory_gb_seconds", "Allocated memory", "GiB-s", "billable", "graphql_or_billing"),
  contract("containers", "disk_gb_seconds", "Allocated disk", "GB-s", "billable", "graphql_or_billing"),
  contract("containers", "egress_bytes", "Egress", "bytes", "billable", "graphql_or_billing", {
    billingKind: "conditional", billingUnit: "GB transferred", condition: "Charges depend on region and included egress.",
  }),

  contract("browser_rendering", "browser_hours", "Browser time", "browser-hours", "billable", "graphql_or_billing"),
  contract("browser_rendering", "concurrent_browsers", "Concurrent browsers", "browsers", "quota", "billing", {
    billingKind: "conditional", billingUnit: "average concurrent browsers", condition: "Charges apply above the plan's included concurrency.",
  }),
  supporting("browser_rendering", "sessions", "Browser sessions", "sessions", "graphql"),
  contract("workflows", "requests", "Workflow invocations", "requests", "shared_billing", "graphql", { sharedBillingMetricId: "workers:requests" }),
  contract("workflows", "cpu_ms", "CPU time", "ms", "shared_billing", "billing", { sharedBillingMetricId: "workers:cpu_ms" }),
  contract("workflows", "steps", "Workflow steps", "steps", "billable", "graphql_or_billing"),
  contract("workflows", "storage_bytes", "Workflow state storage", "bytes", "billable", "billing", { billingUnit: "GB-month" }),
  contract("worker_builds", "build_minutes", "Build time", "minutes", "billable", "graphql_or_billing"),
  contract("analytics_engine", "data_points_written", "Data points written", "data points", "billable", "graphql_or_billing", {
    billingKind: "announced", condition: "Cloudflare publishes this rate but currently reports that charges are not active.",
  }),
  contract("analytics_engine", "read_queries", "SQL read queries", "queries", "billable", "billing", {
    billingKind: "announced", billingUnit: "SQL API requests", condition: "Cloudflare publishes this rate but currently reports that charges are not active.",
  }),
  contract("log_explorer", "ingested_bytes", "Logs ingested", "bytes", "billable", "graphql_or_billing"),
  contract("log_explorer", "storage_bytes", "Logs stored", "bytes", "billable", "billing", { billingUnit: "GB-month" }),
  contract("email", "sent", "Outbound emails", "emails", "billable", "graphql_or_billing"),
] as const;

const PRODUCT_METRIC_CONTRACTS_BY_ID = new Map(PRODUCT_METRIC_CONTRACTS.map(metric => [metric.id, metric]));

export const PRODUCT_LIMIT_METRICS: readonly ProductLimitMetricPresentation[] = PRODUCT_METRIC_CONTRACTS
  .filter((metric): metric is ProductMetricContract & { role: Exclude<ProductMetricRole, "supporting"> } => metric.productLimit)
  .map(({ id, family, label, unit, role, billingKind, condition, sharedBillingMetricId }) => ({
    id, family, label, unit, role, billingKind,
    ...(condition ? { condition } : {}),
    ...(sharedBillingMetricId ? { sharedBillingMetricId } : {}),
  }));

const PRODUCT_LIMIT_METRICS_BY_ID = new Map(PRODUCT_LIMIT_METRICS.map(metric => [metric.id, metric]));

export function productMetricContract(metricId: string): ProductMetricContract | null {
  return PRODUCT_METRIC_CONTRACTS_BY_ID.get(metricId) ?? null;
}

export function productMetricContractsForFamily(family: string): ProductMetricContract[] {
  return PRODUCT_METRIC_CONTRACTS.filter(metric => metric.family === family);
}

export function productLimitMetric(metricId: string): ProductLimitMetricPresentation | null {
  return PRODUCT_LIMIT_METRICS_BY_ID.get(metricId) ?? null;
}

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
  { family: "r2", metrics: ["class_a", "class_b", "storage_bytes", "retrieval_bytes", "egress_bytes"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "kv", metrics: ["reads", "writes", "deletes", "lists", "storage_bytes"], preferredScope: "namespace", fastSource: "graphql", billingSource: true },
  { family: "pages", metrics: ["requests"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "images", metrics: ["transformations", "stored_images", "delivery"], preferredScope: "account", fastSource: "graphql", billingSource: true },
  { family: "stream", metrics: ["minutes_stored", "minutes_delivered"], preferredScope: "account", fastSource: "graphql", billingSource: true },
  { family: "vectorize", metrics: ["queried_dimensions", "stored_dimensions"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "hyperdrive", metrics: ["database_queries"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "ai_gateway", metrics: ["requests", "tokens", "cost_usd", "logpush_requests"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "containers", metrics: ["vcpu_seconds", "memory_gb_seconds", "disk_gb_seconds", "egress_bytes"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "browser_rendering", metrics: ["browser_hours", "concurrent_browsers", "sessions"], preferredScope: "account", fastSource: "graphql", billingSource: true },
  { family: "workflows", metrics: ["requests", "cpu_ms", "steps", "storage_bytes"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "worker_builds", metrics: ["build_minutes"], preferredScope: "account", fastSource: "graphql", billingSource: true },
  { family: "analytics_engine", metrics: ["data_points_written", "read_queries"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "log_explorer", metrics: ["ingested_bytes", "storage_bytes"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "email", metrics: ["sent"], preferredScope: "zone", fastSource: "graphql", billingSource: true },
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
  product.metrics.map(metricKey => {
    const id = `${product.family}:${metricKey}`;
    const metricContract = productMetricContract(id);
    return {
      id,
      productFamily: product.family,
      metricKey,
      displayName: metricContract?.label ?? DISPLAY_NAMES[metricKey] ?? metricKey.replaceAll("_", " ").replace(/\b\w/g, value => value.toUpperCase()),
      unit: metricUnit(metricKey),
      aggregationKind: MAXIMUM_METRICS.has(metricKey) || metricKey === "concurrent_browsers" ? "maximum" as const : "sum" as const,
      billingMapping: metricContract && ["independent", "conditional", "announced"].includes(metricContract.billingKind) && product.billingSource
        ? metricKey
        : null,
      collectorKey: metricContract?.historySource === "billing"
        ? "billing:billable-usage"
        : product.fastSource ? `${product.fastSource}:${product.family}` : "billing:catchall",
      finestScope: product.preferredScope,
      active: true,
    };
  }),
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
  if (metric.includes("cpu_ms")) return "milliseconds";
  return "count";
}
