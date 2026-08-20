/** Local Cloudflare product glyphs (docs icon set) keyed by metric family. */
export const PRODUCT_ICON: Record<string, string> = {
  durable_objects: "durable-objects",
  workers: "workers",
  workers_ai: "workers-ai",
  queues: "queues",
  d1: "d1",
  r2: "r2",
  kv: "kv",
  pages: "pages",
  images: "images",
  stream: "stream",
  vectorize: "vectorize",
  hyperdrive: "hyperdrive",
  ai_gateway: "ai-gateway",
  containers: "containers",
  browser_rendering: "browser-rendering",
  workflows: "workflows",
  worker_builds: "worker-builds",
  analytics_engine: "analytics-engine",
  log_explorer: "log-explorer",
  zones: "dns",
  email: "email-routing",
  billing: "billing",
};

const CATEGORY_COLORS: Record<string, string> = {
  durable_objects: "#f6821f",
  workers: "#f9ab41",
  workers_ai: "#9b51e0",
  queues: "#8d6bde",
  d1: "#2f6fed",
  r2: "#5f7286",
  kv: "#0f9d61",
  ai_gateway: "#c74fd1",
};

export function categoryColor(family: string): string {
  return CATEGORY_COLORS[family] ?? "#8593a5";
}

export function tierLabel(tier: string): string {
  const labels: Record<string, string> = {
    control_plane: "Control plane",
    critical: "Critical",
    standard: "Standard",
    disposable: "Disposable",
    unclassified: "Unclassified",
  };
  return labels[tier] ?? tier;
}

export function tierDescription(tier: string): string {
  const descriptions: Record<string, string> = {
    control_plane: "Never stopped. Brolly, its database, and the notification path only alert.",
    critical: "Alert only. An operator must reclassify before any stop can even be prepared.",
    standard: "Alert, prepare a reversible stop, and allow automatic emergency quarantine when a tested breaker exists.",
    disposable: "Alert with optional reversible auto-stop at an emergency threshold.",
    unclassified: "Treated as critical (alert only) until an operator classifies it.",
  };
  return descriptions[tier] ?? "Review this asset's protection tier.";
}
