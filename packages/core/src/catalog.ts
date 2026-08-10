export interface MetricDefinition {
  family: string;
  metrics: string[];
  preferredScope: "account" | "zone" | "resource" | "namespace" | "object";
  fastSource: "graphql" | "rest" | "runtime" | null;
  billingSource: boolean;
}

export const METRIC_CATALOG_VERSION = "2026-08-09";

export const METRIC_CATALOG: MetricDefinition[] = [
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
  { family: "pages", metrics: ["requests", "builds"], preferredScope: "resource", fastSource: "rest", billingSource: true },
  { family: "images", metrics: ["transformations", "stored_images", "delivery"], preferredScope: "account", fastSource: "graphql", billingSource: true },
  { family: "stream", metrics: ["minutes_stored", "minutes_delivered"], preferredScope: "account", fastSource: "graphql", billingSource: true },
  { family: "vectorize", metrics: ["queried_dimensions", "stored_dimensions"], preferredScope: "resource", fastSource: "rest", billingSource: true },
  { family: "hyperdrive", metrics: ["database_queries"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "ai_gateway", metrics: ["requests", "tokens", "cost_usd"], preferredScope: "resource", fastSource: "graphql", billingSource: true },
  { family: "zones", metrics: ["requests", "bandwidth_bytes"], preferredScope: "zone", fastSource: "graphql", billingSource: true },
];
