/**
 * Dashboard UI preview harness. Serves the real dashboard client against an
 * in-process mock API so every page and state renders without a Cloudflare
 * account, OAuth client, or D1 database.
 *
 *   pnpm dev:demo        # from the repository root or this package
 *
 * The harness owns [::1]:5199 and checks both loopback address families before
 * Vite starts so a stale demo process cannot coexist on the same logical port.
 *
 * Run it to review or change dashboard UI. `pnpm dev` boots the real Worker
 * instead and requires Cloudflare OAuth plus account binding before any page
 * past the login screen renders.
 *
 * The fixture account id is deliberately a placeholder string. `connectionHealth()`
 * in src/client/lib/health.ts detects that and renders the "Local preview"
 * banner, so the preview can never be mistaken for live protection. Keep it a
 * placeholder.
 *
 * The fixtures below are the whole contract. They must satisfy the response
 * types in src/client/types.ts; when a dashboard API response shape changes,
 * update the matching fixture here and `pnpm typecheck` will fail until it
 * lines up. Every mutating route answers `{ ok: true }` and changes nothing,
 * so reviewers can click approve, execute, acknowledge, scan, and save freely.
 *
 * This file is development-only. scripts/sync-deploy-template.mjs copies named
 * build outputs, so nothing here reaches the deploy template or a customer
 * installation.
 */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import type { AlertLevel, InitialIngestionResponse, NotificationProvider, NotificationTarget, PlanTier } from "./src/client/types.ts";
import { estimatedBillableCostSeries } from "./src/estimated-billable-cost.js";
import { WORKERS_PAID_INCLUDED } from "./src/included-quota.js";
import type { UsageSeriesResponse } from "./src/usage-series.ts";

const now = Date.now();
const HOUR = 3_600_000;
const DEMO_PORT = 5199;
const DEMO_HOST = "::1";
const DEMO_PORT_GUARD_STATE = "__brollyDemoPortGuardChecked" as const;

/**
 * Reserve-check both loopback families before Vite starts. macOS treats
 * 127.0.0.1 and ::1 as separate listeners, while `devurl` resolves localhost
 * through ::1. A stale listener on either family must stop a second demo from
 * starting on the same logical port.
 */
export async function assertDemoLoopbackPortAvailable(port = DEMO_PORT): Promise<void> {
  for (const host of ["127.0.0.1", "::1"]) {
    await new Promise<void>((resolve, reject) => {
      const probe = createNetServer();
      probe.once("error", cause => {
        const detail = cause instanceof Error ? cause.message : String(cause);
        reject(new Error(`Brolly demo port ${port} is occupied on ${host}. Stop the existing demo server before starting another. ${detail}`));
      });
      probe.listen({ host, port, exclusive: true }, () => {
        probe.close(error => error ? reject(error) : resolve());
      });
    });
  }
}

function demoLoopbackGuard(): Plugin {
  const runtime = globalThis as typeof globalThis & { [DEMO_PORT_GUARD_STATE]?: boolean };
  return {
    name: "brolly-demo-loopback-guard",
    configResolved(config) {
      if (config.server.host !== DEMO_HOST) {
        throw new Error(`Brolly's demo server is fixed to IPv6 loopback (${DEMO_HOST}) so devurl reaches the intended process. Remove the --host override.`);
      }
    },
    async configureServer() {
      if (runtime[DEMO_PORT_GUARD_STATE]) return;
      await assertDemoLoopbackPortAvailable();
      runtime[DEMO_PORT_GUARD_STATE] = true;
    },
  };
}

const spendLimits = (warning: number, critical: number, emergency: number) => ({ warning, critical, emergency });

const session = {
  authenticated: true,
  oauthConfigured: true,
  credentialStorageReady: true,
  actor: { name: "Demo Session", kind: "session" },
  account: { id: "placeholder-demo-account", name: "Demo Account (local preview)" },
};

/**
 * Billing Read access is the one piece of harness state that changes, because
 * step 1 of the wizard cannot be walked end to end without it: saveBillingAccess()
 * in BudgetWizard.tsx saves a token, re-runs the estimate, and throws unless
 * Cloudflare comes back `connected`. A frozen fixture makes that a dead end.
 * Submitting any token here flips both this record and the estimate access block;
 * nothing leaves the process and a restart resets it.
 */
const billingAccess = {
  configured: false,
  source: "none" as "worker_secret" | "encrypted_database" | "none",
  updatedAt: null as number | null,
};

const configuredDemoPlanTier = process.env.BROLLY_DEMO_PLAN_TIER;
const initialDemoPlanTier: PlanTier = configuredDemoPlanTier === "free" || configuredDemoPlanTier === "enterprise" || configuredDemoPlanTier === "unknown"
  ? configuredDemoPlanTier : "paid";
const demoPlan = {
  planTier: initialDemoPlanTier,
  planTierSource: "api" as "api" | "override",
  detectedPlanTier: initialDemoPlanTier,
  planTierOverride: null as PlanTier | null,
  planTierCheckedAt: now - HOUR,
  planTierError: null as string | null,
};

const policy = {
  version: "4",
  accountDailySpend: spendLimits(40, 80, 150),
  familyDailySpend: {
    workers: spendLimits(15, 30, 60),
    durable_objects: spendLimits(10, 25, 50),
  },
  assetDailySpend: {
    "durable_objects:agent-thread": spendLimits(5, 12, 25),
  },
  thresholds: [
    { metric: "duration_gbs", windowMs: HOUR, warning: 450, critical: 900, emergency: 1800, minimumBaselineSamples: 6, anomalyMultiplier: 4 },
    { metric: "requests", windowMs: HOUR, warning: 250_000, critical: 900_000, minimumBaselineSamples: 6, anomalyMultiplier: 5 },
  ],
};

/**
 * First-run mode. `BROLLY_DEMO_FIRST_RUN=1 pnpm dev:demo` reports onboarding as
 * incomplete, which is the only thing App.tsx uses to tell a brand-new install
 * from a returning operator opening Budget settings: it renders the same
 * BudgetWizard with `editing={false}` and no `onCancel`, so the header, headline,
 * and Close button match what someone sees right after installing Brolly.
 *
 * The policy it starts from is DEFAULT_POLICY from packages/core/src/policy.ts,
 * copied rather than imported because packages/core has no dist until something
 * runs a build and this harness must keep working without one. Coverage is a gap
 * on every family because a fresh D1 has no metric_coverage rows until the first
 * monitor pass.
 *
 * `BROLLY_DEMO_FIRST_RUN=empty` additionally discovers no Workers or namespaces,
 * which is what the wizard shows before that first pass has inventoried anything.
 */
const firstRun = process.env.BROLLY_DEMO_FIRST_RUN;
const freshInstall = firstRun === "1" || firstRun === "empty";

const defaultFamilyDailySpend = Object.fromEntries([
  "workers", "durable_objects", "workers_ai", "queues", "d1", "r2", "kv", "pages", "images", "stream",
  "vectorize", "hyperdrive", "ai_gateway", "containers", "browser_rendering", "workflows", "worker_builds",
  "analytics_engine", "log_explorer", "zones", "email", "unknown",
].map(family => [family, spendLimits(1, 5, 10)]));

const defaultPolicy = {
  version: "2026-08-09.1",
  accountDailySpend: spendLimits(5, 12.5, 25),
  familyDailySpend: defaultFamilyDailySpend,
  assetDailySpend: {},
  thresholds: [
    { metric: "rows_read", windowMs: 5 * 60_000, warning: 1_000_000, critical: 2_500_000, emergency: 5_000_000, minimumBaselineSamples: 12, anomalyMultiplier: 8 },
    { metric: "rows_written", windowMs: 5 * 60_000, warning: 5_000, critical: 12_500, emergency: 25_000, minimumBaselineSamples: 12, anomalyMultiplier: 8 },
    { metric: "rows_read", windowMs: 24 * 60 * 60_000, emergency: 100_000_000 },
    { metric: "rows_written", windowMs: 24 * 60 * 60_000, emergency: 500_000 },
    { metric: "projected_daily_cost_usd", windowMs: 24 * 60 * 60_000, warning: 0.5, critical: 2, emergency: 5, minimumBaselineSamples: 12, anomalyMultiplier: 6 },
  ],
};

// Step 3 of the wizard asks for a budget per cataloged family, so a fresh
// install lists all of METRIC_CATALOG rather than the five families the
// returning-operator fixture happens to have signal for. Labels match
// familyLabel() in src/dashboard-api.ts.
const catalogFamilies = [
  { family: "workers", label: "Workers", metrics: ["requests", "cpu_ms", "cache_requests"] },
  { family: "durable_objects", label: "Durable Objects", metrics: ["requests", "duration_gb_seconds", "incoming_websocket_messages", "rows_read", "rows_written", "kv_read_units", "kv_write_units", "kv_delete_requests", "sql_storage_bytes", "kv_storage_bytes"] },
  { family: "workers_ai", label: "Workers AI", metrics: ["neurons", "requests"] },
  { family: "queues", label: "Queues", metrics: ["operations", "messages", "bytes"] },
  { family: "d1", label: "D1", metrics: ["rows_read", "rows_written", "storage_bytes"] },
  { family: "r2", label: "R2", metrics: ["class_a", "class_b", "storage_bytes", "egress_bytes"] },
  { family: "kv", label: "Workers KV", metrics: ["reads", "writes", "deletes", "lists", "storage_bytes"] },
  { family: "pages", label: "Pages", metrics: ["requests", "builds"] },
  { family: "images", label: "Images", metrics: ["transformations", "stored_images", "delivery"] },
  { family: "stream", label: "Stream", metrics: ["minutes_stored", "minutes_delivered"] },
  { family: "vectorize", label: "Vectorize", metrics: ["queried_dimensions", "stored_dimensions"] },
  { family: "hyperdrive", label: "Hyperdrive", metrics: ["database_queries"] },
  { family: "ai_gateway", label: "AI Gateway", metrics: ["requests", "tokens", "cost_usd"] },
  { family: "containers", label: "Containers", metrics: ["vcpu_seconds", "memory_gb_seconds", "disk_gb_seconds", "egress_bytes"] },
  { family: "browser_rendering", label: "Browser Rendering", metrics: ["sessions", "session_minutes"] },
  { family: "workflows", label: "Workflows", metrics: ["requests", "cpu_ms", "steps", "storage_bytes"] },
  { family: "worker_builds", label: "Worker Builds", metrics: ["build_minutes"] },
  { family: "analytics_engine", label: "Analytics Engine", metrics: ["data_points_written", "data_points_read", "queries", "storage_bytes"] },
  { family: "log_explorer", label: "Log Explorer", metrics: ["ingested_bytes", "queries", "storage_bytes"] },
  { family: "zones", label: "Zones", metrics: ["requests", "bandwidth_bytes"] },
  { family: "email", label: "Email", metrics: ["sent", "routed"] },
];
// Keep the returning-operator fixture aligned with the current catalog so the
// editable budget board exercises every product glyph in the local preview.
const returningActiveFamilies = new Set(["workers", "durable_objects", "d1", "kv"]);
const returningFamilies = catalogFamilies.map(definition => ({
  ...definition,
  protection: returningActiveFamilies.has(definition.family) ? "active" as const : "coverage_gap" as const,
}));

const discoveredAssets = [
  { key: "workers:api-gateway", family: "workers", id: "api-gateway", name: "api-gateway", scope: "resource", protection: "active", tags: { env: "production" } },
  { key: "workers:image-resizer", family: "workers", id: "image-resizer", name: "image-resizer", scope: "resource", protection: "active", tags: {} },
  { key: "durable_objects:agent-thread", family: "durable_objects", id: "agent-thread", name: "AgentThread", scope: "namespace", protection: "active", tags: { app: "agents", cloudflareWorkerScript: "api-gateway" } },
  { key: "durable_objects:rate-limiter", family: "durable_objects", id: "rate-limiter", name: "RateLimiter", scope: "namespace", protection: "coverage_gap", tags: {} },
];

/**
 * `POST /api/onboarding/estimates` backs both the step 1 access check and the
 * step 2 "suggest from recent usage" action. Without it the catch-all `{ ok: true }`
 * reply reaches AccessActions, which reads `result.access.workers` while rendering
 * and takes the whole wizard down with a blank page.
 *
 * The default access states are chosen to render the most surface at once:
 * Workers `limited` with a non-permission detail is the `bestAvailable` branch, so
 * it reads "Setup needed" until Billing Read connects and then flips to "Ready";
 * Durable Objects `connected` shows the plain healthy row; billing `not_configured`
 * reveals the billing connection actions. accessPermissionProblem() matches on wording, so the
 * Workers detail must avoid "denied", "forbidden", "unauthorized", and "403" or the
 * reconnect callout appears instead.
 */
const suggested = (observedUsd: number, warning: number, critical: number, emergency: number, partial = false) => ({
  observedUsd, limits: spendLimits(warning, critical, emergency), source: "analytics" as const, partial,
});

const estimateAccess = {
  workers: {
    state: "limited" as "connected" | "limited" | "blocked" | "not_configured" | "unknown",
    detail: "Per-script requests and CPU time are available. Cache-side requests are reported only at account scope.",
  },
  durable_objects: {
    state: "connected" as "connected" | "limited" | "blocked" | "not_configured" | "unknown",
    detail: "Per-object requests, duration, and storage are readable.",
  },
  billing: {
    state: "not_configured" as "connected" | "limited" | "blocked" | "not_configured" | "unknown",
    detail: "No Billing Read token is configured, so exact account totals are unavailable.",
  },
};

const estimates = {
  generatedAt: now - 90_000,
  windowStartAt: now - 24 * HOUR,
  windowEndAt: now,
  cached: false,
  apiCalls: 3,
  headroom: { warning: 0.25, critical: 0.75, emergency: 1.5 },
  account: suggested(18.4, 23, 32.2, 46, true),
  families: {
    workers: suggested(6.2, 7.75, 10.85, 15.5),
    durable_objects: suggested(9.1, 11.38, 15.93, 22.75),
    d1: suggested(2.4, 3, 4.2, 6),
    kv: suggested(0.7, 0.88, 1.23, 1.75),
  },
  assets: {
    "durable_objects:agent-thread": suggested(5.6, 7, 9.8, 14),
    "workers:api-gateway": suggested(3.9, 4.88, 6.83, 9.75),
  },
  unchangedFamilies: ["queues", "r2", "workers_ai"],
  access: estimateAccess,
};

const onboarding = {
  accountId: "placeholder-demo-account",
  accountName: "Demo Account (local preview)",
  complete: !freshInstall,
  ...demoPlan,
  policy: freshInstall ? defaultPolicy : policy,
  families: freshInstall
    ? catalogFamilies.map(definition => ({ ...definition, protection: "coverage_gap" }))
    : returningFamilies,
  scopedAssets: freshInstall
    ? firstRun === "empty"
      ? []
      : discoveredAssets.map(asset => ({ ...asset, protection: "coverage_gap" }))
    : discoveredAssets,
};

const initialIngestion: InitialIngestionResponse = {
  job: { id: "initial-demo", status: "running", startedAt: now, updatedAt: now },
  collectors: [
    { collector: "graphql:workers", label: "Workers", total: 3, complete: 0, failed: 0, oldestCompleteAt: null },
    { collector: "graphql:durable_objects", label: "Durable Objects", total: 3, complete: 0, failed: 0, oldestCompleteAt: null },
    { collector: "billing", label: "Billing", total: 1, complete: 0, failed: 0, oldestCompleteAt: null },
  ],
};
let initialIngestionPolls = 0;

function advanceInitialIngestion(): InitialIngestionResponse {
  initialIngestionPolls += 1;
  const workers = Math.min(3, initialIngestionPolls);
  const durableObjects = Math.min(3, Math.max(0, initialIngestionPolls - 1));
  const billing = initialIngestionPolls >= 4 ? 1 : 0;
  initialIngestion.collectors = initialIngestion.collectors.map(item => {
    const complete = item.collector === "graphql:workers" ? workers : item.collector === "graphql:durable_objects" ? durableObjects : billing;
    return { ...item, complete, oldestCompleteAt: complete ? "2026-05-19" : null };
  });
  const done = initialIngestion.collectors.every(item => item.complete + item.failed >= item.total);
  initialIngestion.job = { ...initialIngestion.job!, status: done ? "complete" : "running", updatedAt: Date.now() };
  return initialIngestion;
}

const incidents = [
  {
    id: "inc-1",
    key: "durable_objects:agent-thread:duration_gbs",
    status: "open",
    severity: "critical",
    family: "durable_objects",
    familyLabel: "Durable Objects",
    assetId: "agent-thread",
    assetName: "AgentThread",
    parentId: null,
    scope: "namespace",
    tier: "standard",
    tags: { app: "agents" },
    metric: "duration_gbs",
    metricLabel: "Active duration",
    unit: "GB-s",
    windowMs: HOUR,
    observed: 4_180,
    threshold: 900,
    expected: 640,
    reason: "Hourly active duration is 6.5x the observed baseline and above the critical budget. One namespace instance has been continuously active for 3 hours.",
    proposedAction: "Quarantine the AgentThread namespace so runaway instances stop billing while storage and state are preserved.",
    firstSeen: now - 3 * HOUR,
    lastSeen: now - 4 * 60_000,
    occurrences: 14,
    cloudflareUrl: "https://dash.cloudflare.com/",
    action: { id: "act-1", state: "prepared", kind: "runtime_quarantine" },
  },
  {
    id: "inc-2",
    key: "workers:api-gateway:requests",
    status: "acknowledged",
    severity: "warning",
    family: "workers",
    familyLabel: "Workers",
    assetId: "api-gateway",
    assetName: "api-gateway",
    parentId: null,
    scope: "resource",
    tier: "critical",
    tags: { env: "production" },
    metric: "requests",
    metricLabel: "Requests",
    unit: "requests",
    windowMs: HOUR,
    observed: 312_400,
    threshold: 250_000,
    expected: 180_000,
    reason: "Request volume is 1.7x baseline. The growth is steady rather than a spike, which usually indicates real traffic.",
    proposedAction: "No automatic action. Review the traffic source and raise the budget if the growth is expected.",
    firstSeen: now - 9 * HOUR,
    lastSeen: now - 20 * 60_000,
    occurrences: 6,
    cloudflareUrl: "https://dash.cloudflare.com/",
    action: null,
  },
  {
    id: "inc-3",
    key: "d1:brolly-demo-db:rows_read",
    status: "open",
    severity: "info",
    family: "d1",
    familyLabel: "D1",
    assetId: "brolly-demo-db",
    assetName: "brolly-demo-db",
    parentId: null,
    scope: "resource",
    tier: "standard",
    tags: {},
    metric: "rows_read",
    metricLabel: "Rows read",
    unit: "rows",
    windowMs: 24 * HOUR,
    observed: 48_000_000,
    threshold: null,
    expected: 21_000_000,
    reason: "Daily rows read doubled against the trailing baseline. Still inside the configured budget.",
    proposedAction: "Observe only.",
    firstSeen: now - 26 * HOUR,
    lastSeen: now - HOUR,
    occurrences: 2,
    cloudflareUrl: "https://dash.cloudflare.com/",
    action: null,
  },
];

const coverageGap = {
  family: "queues",
  metric: "backlog",
  scope: "account",
  state: "unavailable",
  detail: "No active fast-telemetry collector for queue backlog on this account.",
  checkedAt: now - 12 * 60_000,
};

const coverageHealthy = ["workers:requests", "workers:duration_gbs", "durable_objects:duration_gbs", "durable_objects:requests", "d1:rows_read", "kv:reads"].map((pair) => {
  const [family, metric] = pair.split(":");
  return { family, metric, scope: "account", state: "healthy", detail: null, checkedAt: now - 12 * 60_000 };
});

const spendHistory = Array.from({ length: 24 }, (_, i) => {
  const at = now - (23 - i) * HOUR;
  const doSpike = i > 19 ? (i - 19) * 0.35 : 0;
  const categories = {
    workers: 0.34 + 0.05 * Math.sin(i / 3),
    durable_objects: 0.22 + doSpike,
    d1: 0.09,
    kv: 0.03,
  };
  const totalUsd = Object.values(categories).reduce((sum, value) => sum + value, 0);
  return { at, totalUsd: Number(totalUsd.toFixed(3)), categories };
});

const dashboard = {
  generatedAt: now,
  account: { id: "placeholder-demo-account", timezone: "America/New_York" },
  ...demoPlan,
  policy: {
    version: policy.version,
    accountDailySpend: policy.accountDailySpend,
    familyDailySpend: policy.familyDailySpend,
    assetDailySpend: policy.assetDailySpend,
  },
  summary: {
    openIncidents: 2,
    acknowledgedIncidents: 1,
    emergencyIncidents: 0,
    criticalIncidents: 1,
    coverageGaps: 1,
    assets: 14,
    lastCheckAt: now - 6 * 60_000,
  },
  spend: {
    label: "Estimated daily spend",
    estimatedTotalUsd: 18.42,
    categories: [
      { family: "workers", label: "Workers", estimatedUsd: 8.1, updatedAt: now - 6 * 60_000, coverage: "healthy" },
      { family: "durable_objects", label: "Durable Objects", estimatedUsd: 7.6, updatedAt: now - 6 * 60_000, coverage: "healthy" },
      { family: "d1", label: "D1", estimatedUsd: 2.1, updatedAt: now - 6 * 60_000, coverage: "healthy" },
      { family: "kv", label: "Workers KV", estimatedUsd: 0.62, updatedAt: now - 6 * 60_000, coverage: "healthy" },
    ],
    history: spendHistory,
    updatedAt: now - 6 * 60_000,
    authoritative: false,
    stale: false,
    note: "Sample data from the local preview harness. No Cloudflare account is connected.",
  },
  incidents,
  coverage: { gaps: [coverageGap], all: [...coverageHealthy, coverageGap] },
  assets: {
    families: [
      { family: "workers", label: "Workers", assets: 6, lastSeen: now - 6 * 60_000, cloudflareUrl: "https://dash.cloudflare.com/", expectedMetrics: 3, healthyMetrics: 3, gaps: 0 },
      { family: "durable_objects", label: "Durable Objects", assets: 4, lastSeen: now - 6 * 60_000, cloudflareUrl: "https://dash.cloudflare.com/", expectedMetrics: 3, healthyMetrics: 3, gaps: 0 },
      { family: "d1", label: "D1", assets: 2, lastSeen: now - 6 * 60_000, cloudflareUrl: "https://dash.cloudflare.com/", expectedMetrics: 2, healthyMetrics: 2, gaps: 0 },
      { family: "kv", label: "Workers KV", assets: 1, lastSeen: now - 6 * 60_000, cloudflareUrl: "https://dash.cloudflare.com/", expectedMetrics: 2, healthyMetrics: 2, gaps: 0 },
      { family: "queues", label: "Queues", assets: 1, lastSeen: now - 6 * 60_000, cloudflareUrl: "https://dash.cloudflare.com/", expectedMetrics: 2, healthyMetrics: 1, gaps: 1 },
    ],
    tiers: { control_plane: 1, critical: 2, standard: 9, disposable: 1, unclassified: 1 },
  },
  actions: [
    {
      id: "act-0",
      incidentId: "inc-0",
      family: "workers",
      assetId: "image-resizer",
      kind: "runtime_quarantine",
      state: "succeeded",
      reason: "Emergency spend budget exceeded during the 2026-08-02 image loop incident.",
      error: null,
      createdAt: now - 10 * 24 * HOUR,
      updatedAt: now - 10 * 24 * HOUR + 90_000,
    },
  ],
};

const check = (state: string, label: string, detail: string) => ({ state, label, detail });

const configuration = {
  generatedAt: now,
  connected: true,
  summary: { workers: 2, configuredWorkers: 1, namespaces: 2, configuredNamespaces: 1, partial: 2, needsAttention: 1, lastVerifiedAt: now - 15 * 60_000 },
  workers: [
    {
      id: "api-gateway", name: "api-gateway", tier: "critical", tags: { env: "production" }, seenAt: now - 6 * 60_000,
      declaredInstalled: true, namespaceCount: 1, checkedAt: now - 15 * 60_000,
      deploymentId: "deploy-101", versionId: "ver-101", status: "configured",
      checks: {
        inventory: check("pass", "Inventory", "Seen in the account inventory scan."),
        declared: check("pass", "Declared", "Breaker declared in deployment metadata."),
        apiAccess: check("pass", "API access", "Script metadata is readable."),
        fuseSecret: check("pass", "Breaker secret", "BROLLY_FUSE secret present."),
        runtimeBundle: check("pass", "Runtime bundle", "@standardagents/brolly-runtime detected."),
        activeDeployment: check("pass", "Active deployment", "Breaker active in the current deployment."),
      },
    },
    {
      id: "image-resizer", name: "image-resizer", tier: "standard", tags: {}, seenAt: now - 6 * 60_000,
      declaredInstalled: false, namespaceCount: 0, checkedAt: now - 15 * 60_000,
      deploymentId: "deploy-88", versionId: "ver-88", status: "partial",
      checks: {
        inventory: check("pass", "Inventory", "Seen in the account inventory scan."),
        declared: check("fail", "Declared", "No breaker declared for this Worker."),
        apiAccess: check("pass", "API access", "Script metadata is readable."),
        fuseSecret: check("fail", "Breaker secret", "BROLLY_FUSE secret not found."),
        runtimeBundle: check("unknown", "Runtime bundle", "Not checked because the breaker is not declared."),
        activeDeployment: check("unknown", "Active deployment", "Not checked because the breaker is not declared."),
      },
    },
  ],
  namespaces: [
    {
      id: "agent-thread", name: "AgentThread", tier: "standard", tags: { app: "agents" }, seenAt: now - 6 * 60_000,
      className: "AgentThread", storage: "sqlite", ownerWorker: "api-gateway",
      declaredOwner: "api-gateway", discoveredOwner: "api-gateway", status: "configured",
      checks: {
        inventory: check("pass", "Inventory", "Namespace present in inventory."),
        owner: check("pass", "Owner", "Declared and discovered owners match."),
        constructor: check("pass", "Constructor", "Class exported by the owner Worker."),
        worker: check("pass", "Worker", "Owner Worker carries an active fuse."),
      },
    },
    {
      id: "rate-limiter", name: "RateLimiter", tier: "unclassified", tags: {}, seenAt: now - 6 * 60_000,
      className: "RateLimiter", storage: "sqlite", ownerWorker: "image-resizer",
      declaredOwner: null, discoveredOwner: "image-resizer", status: "partial",
      checks: {
        inventory: check("pass", "Inventory", "Namespace present in inventory."),
        owner: check("fail", "Owner", "No declared owner recorded for this namespace."),
        constructor: check("pass", "Constructor", "Class exported by the discovered owner."),
        worker: check("fail", "Worker", "The owner Worker has no active fuse."),
      },
    },
  ],
};

const targets: NotificationTarget[] = [
  {
    id: "target-1",
    kind: "discord",
    label: "Ops server",
    enabled: true,
    providerId: null,
    createdAt: now - 6 * 24 * HOUR,
    updatedAt: now - 6 * 24 * HOUR,
    lastDeliveryAt: now - 2 * HOUR,
    lastDeliveryOk: true,
    lastDeliveryError: null,
  },
];

const providers: NotificationProvider[] = [];
const alertLevels: AlertLevel[] = [
  { id: "warning", position: 0, label: "Warning", entries: [{ id: "entry-discord", levelId: "warning", kind: "channel", targetId: "target-1", repeatIntervalMs: null, position: 0 }] },
  { id: "critical", position: 1, label: "Critical", entries: [] },
  { id: "emergency", position: 2, label: "Emergency", entries: [] },
];

const assets = [
  { accountId: "placeholder-demo-account", family: "workers", id: "api-gateway", parentId: null, name: "api-gateway", scope: "resource", tier: "critical", tags: { env: "production" }, discoveredAt: now - 20 * 24 * HOUR, seenAt: now - 6 * 60_000, incidentCount: 1, lastSignalAt: now - 6 * 60_000 },
  { accountId: "placeholder-demo-account", family: "workers", id: "image-resizer", parentId: null, name: "image-resizer", scope: "resource", tier: "standard", tags: {}, discoveredAt: now - 20 * 24 * HOUR, seenAt: now - 6 * 60_000, incidentCount: 0, lastSignalAt: now - 40 * 60_000 },
  { accountId: "placeholder-demo-account", family: "workers", id: "brolly-guard", parentId: null, name: "brolly-guard", scope: "resource", tier: "control_plane", tags: {}, discoveredAt: now - 20 * 24 * HOUR, seenAt: now - 6 * 60_000, incidentCount: 0, lastSignalAt: now - 6 * 60_000 },
  { accountId: "placeholder-demo-account", family: "durable_objects", id: "agent-thread", parentId: "api-gateway", name: "AgentThread", scope: "namespace", tier: "standard", tags: { app: "agents" }, discoveredAt: now - 20 * 24 * HOUR, seenAt: now - 6 * 60_000, incidentCount: 1, lastSignalAt: now - 4 * 60_000 },
  { accountId: "placeholder-demo-account", family: "durable_objects", id: "rate-limiter", parentId: "image-resizer", name: "RateLimiter", scope: "namespace", tier: "unclassified", tags: {}, discoveredAt: now - 20 * 24 * HOUR, seenAt: now - 6 * 60_000, incidentCount: 0, lastSignalAt: null },
  { accountId: "placeholder-demo-account", family: "d1", id: "brolly-demo-db", parentId: null, name: "brolly-demo-db", scope: "resource", tier: "standard", tags: {}, discoveredAt: now - 20 * 24 * HOUR, seenAt: now - 6 * 60_000, incidentCount: 1, lastSignalAt: now - HOUR },
  { accountId: "placeholder-demo-account", family: "queues", id: "ingest-queue", parentId: null, name: "ingest-queue", scope: "resource", tier: "disposable", tags: {}, discoveredAt: now - 20 * 24 * HOUR, seenAt: now - 6 * 60_000, incidentCount: 0, lastSignalAt: null },
];

const ledgerResources = [
  {
    id: "placeholder-demo-account:account:account:placeholder-demo-account",
    accountId: "placeholder-demo-account", parentResourceId: null, productFamily: "account",
    resourceType: "account", cloudflareId: "placeholder-demo-account", displayName: "Demo Cloudflare account",
    firstSeenAt: now - 20 * 24 * HOUR, lastSeenAt: now - 6 * 60_000, lastActiveAt: now - 6 * 60_000,
    coverageStatus: "complete", controlCapability: "none", runtimeFuseStatus: "unknown",
    autoQuarantinePolicy: "deny", tier: "unclassified", excluded: false, metadata: {},
    childCount: 4, usageUpdatedAt: now - 6 * 60_000, oldestDay: "2026-07-24", openAlerts: 1,
  },
  ...assets.map(asset => ({
    id: `placeholder-demo-account:${asset.family}:${asset.family}%3A${asset.scope}:${asset.id}`,
    accountId: asset.accountId,
    parentResourceId: `placeholder-demo-account:${asset.family}:product:${asset.family}`,
    productFamily: asset.family,
    resourceType: `${asset.family}:${asset.scope}`,
    cloudflareId: asset.id,
    displayName: asset.name ?? asset.id,
    firstSeenAt: asset.discoveredAt,
    lastSeenAt: asset.seenAt,
    lastActiveAt: asset.lastSignalAt,
    coverageStatus: asset.lastSignalAt ? "complete" : "missing",
    controlCapability: asset.family === "queues" ? "queue_pause" : asset.family === "workers" || asset.family === "durable_objects" ? "runtime_fuse" : "none",
    runtimeFuseStatus: asset.id === "api-gateway" || asset.id === "agent-thread" ? "verified" : "unknown",
    autoQuarantinePolicy: "inherit",
    tier: asset.tier,
    excluded: asset.tier === "control_plane",
    metadata: asset.tags,
    childCount: 0,
    usageUpdatedAt: asset.lastSignalAt,
    oldestDay: "2026-07-24",
    openAlerts: asset.incidentCount,
  })),
];

const metricDefinitions = [
  { id: "account:estimated_cost_usd", productFamily: "account", metricKey: "estimated_cost_usd", displayName: "Estimated cost", unit: "usd", aggregationKind: "sum", billingMapping: null, collectorKey: "ledger:cost", finestScope: "account", active: true },
  { id: "workers:requests", productFamily: "workers", metricKey: "requests", displayName: "Requests", unit: "requests", aggregationKind: "sum", billingMapping: "requests", collectorKey: "graphql:workers", finestScope: "resource", active: true },
  { id: "workers:estimated_cost_usd", productFamily: "workers", metricKey: "estimated_cost_usd", displayName: "Estimated cost", unit: "usd", aggregationKind: "sum", billingMapping: null, collectorKey: "ledger:cost", finestScope: "resource", active: true },
  { id: "durable_objects:rows_read", productFamily: "durable_objects", metricKey: "rows_read", displayName: "Rows read", unit: "rows", aggregationKind: "sum", billingMapping: "rows_read", collectorKey: "graphql:durable-objects", finestScope: "object", active: true },
];

/**
 * 90 days of per-scope daily cost and usage for the limits chart, with one
 * billing anomaly so the symlog axis is reviewable. Deterministic per scope.
 */
/**
 * Real usage pulled by `node scripts/fetch-demo-usage.mjs` (git-ignored).
 * When present it replaces the synthetic series for every family it holds
 * and for the account total; families it lacks fall back to the generator.
 */
type RealUsageFixture = { today: string; families: Record<string, { label: string; metrics: UsageSeriesResponse["metrics"]; series: UsageSeriesResponse["series"] }> };
const realUsage: RealUsageFixture | null = (() => {
  const file = join(dirname(fileURLToPath(import.meta.url)), "demo", "usage-series.json");
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as RealUsageFixture; } catch { return null; }
})();

function demoUsageSeries(scope: string): UsageSeriesResponse {
  const real = realUsageSeries(scope);
  const response = real ?? syntheticUsageSeries(scope);
  return {
    ...response,
    estimatedBillableCostSeries: scope === "account"
      ? estimatedBillableCostSeries(response.series, response.cycles, WORKERS_PAID_INCLUDED, demoPlan.planTier)
      : [],
  };
}

function realUsageSeries(scope: string): UsageSeriesResponse | null {
  if (!realUsage) return null;
  const cycles = [-2, -1, 0, 1].map(offset => {
    const date = new Date(now);
    return { startsAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1), endsAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset + 1, 1), approximate: false };
  });
  const base = { resourceId: `real:${scope}`, found: true, today: realUsage.today, cycles, includedQuotaCatalogVersion: "2026-08", planTier: demoPlan.planTier, planTierSource: demoPlan.planTierSource };
  if (scope === "account") {
    const families = Object.values(realUsage.families);
    const days = new Map<string, UsageSeriesResponse["series"][number]>();
    for (const family of families) for (const point of family.series) {
      const entry = days.get(point.day) ?? { day: point.day, costUsd: 0, metrics: {}, sealed: point.sealed };
      entry.costUsd += point.costUsd;
      for (const [id, value] of Object.entries(point.metrics)) entry.metrics[id] = (entry.metrics[id] ?? 0) + value;
      days.set(point.day, entry);
    }
    return { ...base, scope, metrics: withDemoQuota(Object.assign({}, ...families.map(family => family.metrics)), scope), series: [...days.values()].sort((left, right) => left.day.localeCompare(right.day)) };
  }
  const family = realUsage.families[scope.replace(/^family:/, "")];
  // With real data loaded, a product the fetch did not cover has no usage;
  // it must not fall back to invented numbers.
  if (!family) return { ...base, scope, metrics: {}, series: [] };
  return { ...base, scope, metrics: withDemoQuota(family.metrics, scope), series: family.series };
}

function syntheticUsageSeries(scope: string): UsageSeriesResponse {
  const seed = [...scope].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7);
  const random = (index: number) => ((Math.sin(seed + index * 12.9898) * 43758.5453) % 1 + 1) % 1;
  const base = scope === "account" ? 42 : scope.startsWith("family:") ? 9 : 1.4;
  const today = new Date(now).toISOString().slice(0, 10);
  const series = Array.from({ length: 90 }, (_, index) => {
    const at = now - (89 - index) * 24 * HOUR;
    const weekday = new Date(at).getUTCDay();
    const weekend = weekday === 0 || weekday === 6 ? 0.55 : 1;
    const spike = index === 61 ? 26 : index === 62 ? 9 : 1;
    const costUsd = Number((base * weekend * (0.7 + random(index) * 0.6) * spike).toFixed(4));
    const metrics: Record<string, number> = scope === "family:durable_objects"
      ? {
        "durable_objects:requests": Math.round(costUsd * 900_000 * (0.8 + random(index + 7) * 0.4)),
        "durable_objects:duration_gb_seconds": Math.round(costUsd * 2_400 * (0.8 + random(index + 11) * 0.4)),
        "durable_objects:rows_read": Math.round(costUsd * 4_800_000 * (index > 60 ? 4 : 1) * (0.8 + random(index + 3) * 0.4)),
        "durable_objects:rows_written": Math.round(costUsd * 260_000 * (0.8 + random(index + 5) * 0.4)),
        "durable_objects:incoming_websocket_messages": Math.round(costUsd * 120_000 * (0.8 + random(index + 13) * 0.4)),
        "durable_objects:sql_storage_bytes": Math.round(2_000_000_000 + index * 18_000_000),
      }
      : scope === "account"
        ? {
          "workers:requests": Math.round((new Date(at).getUTCMonth() === new Date(now).getUTCMonth() ? 400_000 : 250_000) * (0.8 + random(index + 7) * 0.4)),
          "workers:cpu_ms": Math.round((new Date(at).getUTCMonth() === new Date(now).getUTCMonth() ? 1_200_000 : 700_000) * (0.8 + random(index + 11) * 0.4)),
        }
      : Object.fromEntries(demoFamilyMetrics(scope).map(([id, , , perDollar], position) => [id, Math.round(costUsd * perDollar * (0.8 + random(index + position * 3) * 0.4))]));
    return { day: new Date(at).toISOString().slice(0, 10), costUsd, sealed: index < 89, metrics };
  });
  const cycles = [-2, -1, 0, 1].map(offset => {
    const date = new Date(now);
    return { startsAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1), endsAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset + 1, 1), approximate: false };
  });
  return {
    scope, resourceId: `demo:${scope}`, found: true, today,
    includedQuotaCatalogVersion: "2026-08", planTier: demoPlan.planTier, planTierSource: demoPlan.planTierSource,
    metrics: withDemoQuota(scope === "family:durable_objects"
      ? {
        "durable_objects:requests": { key: "requests", label: "Requests", unit: "requests", billable: true },
        "durable_objects:duration_gb_seconds": { key: "duration_gb_seconds", label: "Duration", unit: "GB-s", billable: true },
        "durable_objects:rows_read": { key: "rows_read", label: "Rows read", unit: "rows", billable: true },
        "durable_objects:rows_written": { key: "rows_written", label: "Rows written", unit: "rows", billable: true },
        "durable_objects:incoming_websocket_messages": { key: "incoming_websocket_messages", label: "WebSocket messages", unit: "messages", billable: true },
        "durable_objects:sql_storage_bytes": { key: "sql_storage_bytes", label: "SQL storage", unit: "bytes", billable: true },
      }
      : scope === "account"
        ? {
          "workers:requests": { key: "requests", label: "Requests", unit: "requests", billable: true },
          "workers:cpu_ms": { key: "cpu_ms", label: "CPU time", unit: "milliseconds", billable: true },
        }
        : Object.fromEntries(demoFamilyMetrics(scope).map(([id, label, unit]) => [id, { key: id.split(":")[1]!, label, unit, billable: true }])), scope),
    series, cycles,
  };
}

const demoIncludedPerCycle: Record<string, number> = {
  "workers:requests": 10_000_000,
  "workers:cpu_ms": 30_000_000,
  "kv:reads": 10_000_000,
  "kv:writes": 1_000_000,
  "kv:deletes": 1_000_000,
  "kv:lists": 1_000_000,
  "kv:storage_bytes": 1_000_000_000,
  "d1:rows_read": 25_000_000_000,
  "d1:rows_written": 50_000_000,
  "d1:storage_bytes": 5_000_000_000,
  "durable_objects:requests": 1_000_000,
  "durable_objects:duration_gb_seconds": 400_000,
  "r2:class_a": 1_000_000,
  "r2:class_b": 10_000_000,
  "r2:storage_bytes": 10_000_000_000,
  "queues:operations": 1_000_000,
};

function withDemoQuota(metrics: UsageSeriesResponse["metrics"], scope: string): UsageSeriesResponse["metrics"] {
  if (scope !== "account") return metrics;
  return Object.fromEntries(Object.entries(metrics).map(([id, metric]) => {
    const includedPerCycle = demoIncludedPerCycle[id];
    return [id, demoPlan.planTier === "free" || includedPerCycle === undefined ? metric : { ...metric, includedPerCycle }];
  }));
}

/** Billable dimensions per demo product: id, label, unit, units per dollar. */
function demoFamilyMetrics(scope: string): Array<[string, string, string, number]> {
  const family = scope.replace(/^family:/, "");
  const table: Record<string, Array<[string, string, string, number]>> = {
    workers: [["workers:requests", "Requests", "requests", 3_300_000], ["workers:cpu_ms", "CPU time", "ms", 41_000]],
    kv: [["kv:reads", "Reads", "requests", 2_000_000], ["kv:writes", "Writes", "requests", 200_000], ["kv:storage_bytes", "Storage", "bytes", 900_000_000]],
    d1: [["d1:rows_read", "Rows read", "rows", 1_000_000_000], ["d1:rows_written", "Rows written", "rows", 1_000_000], ["d1:storage_bytes", "Storage", "bytes", 1_300_000_000]],
    r2: [["r2:class_a", "Class A operations", "operations", 220_000], ["r2:class_b", "Class B operations", "operations", 2_700_000], ["r2:storage_bytes", "Storage", "bytes", 66_000_000_000]],
    queues: [["queues:operations", "Operations", "operations", 2_500_000]],
    workers_ai: [["workers_ai:neurons", "Neurons", "neurons", 90_000]],
    email: [["email:sent", "Messages sent", "messages", 100_000], ["email:routed", "Messages routed", "messages", 400_000]],
    pages: [["pages:builds", "Builds", "builds", 400]],
    images: [["images:transformations", "Transformations", "transformations", 2_000]],
  };
  return table[family] ?? [[`${family}.requests`, "Requests", "requests", 3_300_000]];
}

const demoUsagePoints = Array.from({ length: 20 }, (_, index) => {
  const at = now - (19 - index) * 24 * HOUR;
  return {
    localDay: new Date(at).toISOString().slice(0, 10),
    periodStartAt: at,
    periodEndAt: at + 24 * HOUR,
    metrics: { "account:estimated_cost_usd": 8 + index * .4, "workers:requests": 120_000 + index * 8_000 },
    estimatedCostUsd: 8 + index * .4,
    authoritativeCostUsd: index < 18 ? 7.8 + index * .38 : null,
    quality: index === 13 ? "partial" : "complete",
    sampling: {},
    sealed: index < 19,
    revision: 1,
    revisedAt: at + 24 * HOUR,
  };
});

const demoRules = [{
  id: "demo-account-cost", accountId: "placeholder-demo-account",
  targetResourceId: ledgerResources[0]!.id, targetSelector: null,
  metricDefinitionId: "account:estimated_cost_usd", measurement: "estimated_cost", period: "day",
  notificationTargetIds: ["target-1"], autoQuarantine: false, autoQuarantineContributors: false,
  confirmationWindowMs: 300_000, enabled: true, createdAt: now - 10 * 24 * HOUR, updatedAt: now - HOUR,
  lines: [
    { id: "demo-warning", alertRuleId: "demo-account-cost", levelId: "warning", label: "Warning", color: "#f59e0b", priority: 0, thresholdValue: 15, action: "notify", repeatIntervalMs: null, enabled: true },
    { id: "demo-emergency", alertRuleId: "demo-account-cost", levelId: "emergency", label: "Emergency", color: "#ef4444", priority: 20, thresholdValue: 25, action: "notify", repeatIntervalMs: null, enabled: true },
  ],
}];

const demoAlertInstances = [{
  id: "demo-instance", alertRuleId: "demo-account-cost", alertLineId: "demo-warning",
  targetResourceId: ledgerResources[0]!.id, periodStartAt: now - HOUR * 16, periodEndAt: now + HOUR * 8,
  observedValue: 18.42, thresholdValue: 15, evidence: { measurement: "estimated_cost" },
  dataQuality: "complete", status: "open", firstBreachedAt: now - 2 * HOUR, lastBreachedAt: now - 6 * 60_000,
  nextNotificationAt: null, notificationCount: 1, acknowledgedAt: null, acknowledgedBy: null,
  linkedActionId: null, historical: 0, metricDefinitionId: "account:estimated_cost_usd",
  label: "Warning", color: "#f59e0b", priority: 50, displayName: "Demo Cloudflare account",
  productFamily: "account", cloudflareId: "placeholder-demo-account",
}];

function demoApi(): Plugin {
  return {
    name: "brolly-demo-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/api/")) return next();
        const send = (body: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        const get = req.method === "GET";
        // The Worker answers billing access under both paths; so does this.
        const billingRoute = url.pathname === "/api/billing-access" || url.pathname === "/api/onboarding/billing-access";
        const planRoute = url.pathname === "/api/plan" || url.pathname === "/api/plan-tier";
        if (url.pathname === "/api/auth/session") return send(session);
        if (url.pathname === "/api/onboarding" && get) return send(onboarding);
        if (url.pathname === "/api/onboarding/ingest" && get) return send(advanceInitialIngestion());
        if (url.pathname === "/api/onboarding/ingest" && req.method === "POST") return send({ ok: true });
        if (billingRoute && get) return send(billingAccess);
        if (planRoute && get) return send(demoPlan);
        if (planRoute && req.method === "PUT") {
          const body = await readJson(req);
          const override = body.planTierOverride === null || body.planTierOverride === undefined ? null : body.planTierOverride;
          if (override !== null && !["free", "paid", "enterprise", "unknown"].includes(String(override))) return send({ error: "Invalid plan tier" }, 400);
          demoPlan.planTierOverride = override as PlanTier | null;
          demoPlan.planTier = demoPlan.planTierOverride ?? demoPlan.detectedPlanTier;
          demoPlan.planTierSource = demoPlan.planTierOverride === null ? "api" : "override";
          Object.assign(onboarding, demoPlan);
          Object.assign(dashboard, demoPlan);
          return send({ ok: true, ...demoPlan });
        }
        if (url.pathname === "/api/dashboard") return send(dashboard);
        if (url.pathname === "/api/configuration" && get) return send(configuration);
        if (url.pathname === "/api/configuration/verify" && req.method === "POST") return send(configuration);
        if (url.pathname === "/api/targets" && get) return send({ targets, credentialStorageReady: true });
        if (url.pathname === "/api/providers" && get) return send({ providers });
        if (url.pathname === "/api/alert-levels" && get) return send({ levels: alertLevels });
        if (url.pathname === "/api/cloudflare-zones" && get) return send({ accountId: session.account.id, zones: [{ id: "zone-1", name: "example.com" }, { id: "zone-2", name: "example.net" }] });
        if (url.pathname === "/api/assets" && get) return send({ assets });
        if (url.pathname === "/api/ledger/resources" && get) {
          const query = url.searchParams.get("q")?.toLowerCase();
          const family = url.searchParams.get("family");
          const resources = ledgerResources.filter(item =>
            (!family || item.productFamily === family)
            && (!query || item.displayName.toLowerCase().includes(query) || item.cloudflareId.toLowerCase().includes(query)));
          return send({ resources, families: [...new Set(ledgerResources.map(item => item.productFamily).filter(item => item !== "account"))].sort(), nextCursor: null, generatedAt: Date.now() });
        }
        if (url.pathname === "/api/metric-definitions" && get) return send({ metricDefinitions });
        if (url.pathname === "/api/usage-series" && get) return send(demoUsageSeries(url.searchParams.get("scope") ?? "account"));
        if (url.pathname === "/api/usage" && get) {
          const resource = ledgerResources.find(item => item.id === url.searchParams.get("resourceId")) ?? ledgerResources[0];
          return send({ resource, metricDefinitions, metricId: url.searchParams.get("metricId"), period: "day", points: demoUsagePoints, oldestRetainedAt: "2026-07-24", freshnessAt: now - 6 * 60_000 });
        }
        if (url.pathname === "/api/alert-rules" && get) return send({ rules: demoRules });
        if (url.pathname === "/api/alert-instances" && get) return send({ instances: demoAlertInstances });
        if (url.pathname === "/api/coverage" && get) return send({
          capabilities: [
            { accountId: "placeholder-demo-account", collectorKey: "graphql:workers", dataset: "workersInvocationsAdaptive", available: true, retentionDays: 90, samplingBehavior: "Adaptive", finestScope: "resource", lastVerifiedAt: now - HOUR, errorCode: null, humanExplanation: "Available with 10,000-row keyset pages.", state: "healthy", watermarkAt: now - 6 * 60_000 },
            { accountId: "placeholder-demo-account", collectorKey: "graphql:queues", dataset: "queues", available: false, retentionDays: null, samplingBehavior: null, finestScope: "resource", lastVerifiedAt: now - HOUR, errorCode: "detailed_collector_unavailable", humanExplanation: "Authoritative billing remains visible while detailed attribution is unavailable.", state: "unavailable", watermarkAt: null },
          ],
          collectors: [{ accountId: "placeholder-demo-account", collectorKey: "active-usage", partitionKey: "", cursor: null, highWatermarkAt: now - 6 * 60_000, retryCount: 0, nextEligibleAt: now + 60_000, lastStartedAt: now - 6 * 60_000, lastCompletedAt: now - 6 * 60_000, lastError: null, status: "complete" }],
        });
        if (url.pathname === "/api/monitoring-cost" && get) return send({
          daily: [{ accountId: "placeholder-demo-account", localDay: new Date(now).toISOString().slice(0, 10), graphqlQueries: 24, graphqlQueryBudget: 1200, restRequests: 12, restRequestBudget: 200, d1RowsRead: 18_200, d1RowsWritten: 4_100, workerRequests: 96, workerCpuMs: 83, estimatedCostUsd: .0021, storageBytes: 28_000_000, storageCapacityBytes: 500_000_000, deferredCollectors: [], oldestResourceDay: "2026-07-24", updatedAt: now - 6 * 60_000 }],
          runs: [{ id: "run-1", kind: "active_usage", startedAt: now - 6 * 60_000, completedAt: now - 5.8 * 60_000, durationMs: 8_500, graphqlQueries: 10, restRequests: 0, d1RowsRead: 4_200, d1RowsWritten: 900, rowsReturned: 2_200, samplesNormalized: 6_600, coverageStatus: "complete", status: "complete", errors: [], deferredCollectors: [] }],
          limits: { graphqlQueries: 300, restRequests: 50, d1RowsRead: 100_000, d1RowsWritten: 50_000, pagesPerDataset: 30, resourcesPerTransaction: 500, retries: 3, backfillSlices: 4, wallMs: 45_000 },
          hardMaximums: { graphqlQueries: 500, restRequests: 100, d1RowsRead: 250_000, d1RowsWritten: 100_000, pagesPerDataset: 50, resourcesPerTransaction: 1_000, retries: 5, backfillSlices: 12, wallMs: 55_000 },
        });
        if (url.pathname === "/api/retention" && get) return send({ generatedAt: now, oldestResourceDay: "2026-07-24", oldestAggregateDay: "2026-07-24", dailyRows: 140, projectedBytes: 28_000_000, capacityBytes: 500_000_000, pressure: .056, backfillPending: 4, targetRetentionDays: 730 });
        if (url.pathname === "/api/backfill" && get) return send({
          jobs: [{ id: "backfill-1", requestedStartAt: now - 30 * 24 * HOUR, requestedEndAt: now, status: "running", pausedReason: null, createdAt: now - HOUR, updatedAt: now - 6 * 60_000 }],
          slices: [{ id: "slice-1", backfillJobId: "backfill-1", collectorKey: "graphql:workers", startsAt: now - 24 * HOUR, endsAt: now, status: "complete", retryCount: 0, coverageStatus: "complete", error: null, updatedAt: now - 6 * 60_000 }],
        });
        if (url.pathname === "/api/onboarding/estimates") return send({ ...estimates, generatedAt: Date.now() });
        if (url.pathname === "/api/run" && req.method === "POST") return send({
          ok: true,
          budget: { graphqlQueries: 300, restRequests: 50 },
          datasets: [{ dataset: "workersInvocationsAdaptive", watermarkAt: now - 6 * 60_000, state: "healthy" }],
          run: { status: "complete", coverage: "complete", graphqlQueries: 10, restRequests: 0 },
        });
        if (billingRoute && req.method === "PUT") {
          billingAccess.configured = true;
          billingAccess.source = "encrypted_database";
          billingAccess.updatedAt = Date.now();
          estimateAccess.billing = { state: "connected", detail: "Billing Read is connected for this account." };
          return send({ ok: true, records: 14 });
        }
        if (billingRoute && req.method === "DELETE") {
          billingAccess.configured = false;
          billingAccess.source = "none";
          billingAccess.updatedAt = null;
          estimateAccess.billing = { state: "not_configured", detail: "No Billing Read token is configured, so exact account totals are unavailable." };
          return send({ ok: true });
        }
        if (url.pathname === "/api/targets" && req.method === "POST") {
          const body = await readJson(req);
          const id = crypto.randomUUID();
          const providerKind = ["cloudflare_email", "postmark", "resend", "twilio"].includes(String(body.kind));
          if (providerKind && body.provider) {
            const config = record(body.provider).config;
            const from = String(record(config).from ?? "");
            const existing = providers.findIndex(item => item.kind === body.kind);
            const provider = { kind: body.kind, from, updatedAt: Date.now() } as NotificationProvider;
            if (existing === -1) providers.push(provider); else providers[existing] = provider;
          }
          targets.push({ id, kind: body.kind as NotificationTarget["kind"], label: String(body.label), providerId: providerKind ? `provider:${body.kind}` : null, enabled: true, createdAt: Date.now(), updatedAt: Date.now(), lastDeliveryAt: null, lastDeliveryOk: null, lastDeliveryError: null });
          return send({ ok: true, id });
        }
        const targetRoute = url.pathname.match(/^\/api\/targets\/([^/]+)$/);
        if (targetRoute && req.method === "PATCH") {
          const body = await readJson(req);
          const target = targets.find(item => item.id === targetRoute[1]);
          if (target && typeof body.label === "string") target.label = body.label;
          return send({ ok: true, id: targetRoute[1] });
        }
        if (targetRoute && req.method === "DELETE") {
          const index = targets.findIndex(item => item.id === targetRoute[1]);
          if (index >= 0) targets.splice(index, 1);
          for (const level of alertLevels) level.entries = level.entries.filter(entry => entry.targetId !== targetRoute[1]);
          return send({ ok: true, id: targetRoute[1] });
        }
        const providerRoute = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
        if (providerRoute && req.method === "PATCH") {
          const body = await readJson(req);
          const kind = providerRoute[1] as NotificationProvider["kind"];
          const from = String(record(record(body).config).from ?? "");
          const index = providers.findIndex(item => item.kind === kind);
          const provider = { kind, from, updatedAt: Date.now() };
          if (index === -1) providers.push(provider); else providers[index] = provider;
          return send({ ok: true, kind });
        }
        if (providerRoute && req.method === "DELETE") {
          const index = providers.findIndex(item => item.kind === providerRoute[1]);
          if (index >= 0) providers.splice(index, 1);
          return send({ ok: true, kind: providerRoute[1] });
        }
        if (url.pathname === "/api/alert-levels" && req.method === "POST") {
          const body = await readJson(req);
          const id = crypto.randomUUID();
          const after = body.afterLevelId == null ? -1 : alertLevels.findIndex(level => level.id === body.afterLevelId);
          alertLevels.splice(after + 1, 0, { id, position: after + 1, label: String(body.label), entries: [] });
          normalizeLevelPositions();
          return send({ ok: true, level: alertLevels.find(level => level.id === id) }, 201);
        }
        const levelRoute = url.pathname.match(/^\/api\/alert-levels\/([^/]+)$/);
        if (levelRoute && req.method === "PATCH") {
          const body = await readJson(req);
          const level = alertLevels.find(item => item.id === levelRoute[1]);
          if (level && typeof body.label === "string") level.label = body.label;
          if (level && typeof body.position === "number") {
            alertLevels.splice(alertLevels.indexOf(level), 1);
            alertLevels.splice(body.position, 0, level);
            normalizeLevelPositions();
          }
          return send({ ok: true, level });
        }
        if (levelRoute && req.method === "DELETE") {
          const index = alertLevels.findIndex(item => item.id === levelRoute[1]);
          if (index >= 0 && alertLevels.length > 1) alertLevels.splice(index, 1);
          normalizeLevelPositions();
          return send({ ok: true, id: levelRoute[1] });
        }
        const entryRoute = url.pathname.match(/^\/api\/alert-levels\/([^/]+)\/entries(?:\/([^/]+))?$/);
        if (entryRoute && !entryRoute[2] && req.method === "POST") {
          const body = await readJson(req);
          const level = alertLevels.find(item => item.id === entryRoute[1]);
          const entry = { id: crypto.randomUUID(), levelId: entryRoute[1]!, kind: body.kind, targetId: body.targetId ?? null, repeatIntervalMs: body.repeatIntervalMs ?? null, position: level?.entries.length ?? 0 } as AlertLevel["entries"][number];
          level?.entries.push(entry);
          return send({ ok: true, entry }, 201);
        }
        if (entryRoute?.[2] && req.method === "PATCH") {
          const body = await readJson(req);
          const level = alertLevels.find(item => item.id === entryRoute[1]);
          const entry = level?.entries.find(item => item.id === entryRoute[2]);
          if (entry && "repeatIntervalMs" in body) entry.repeatIntervalMs = body.repeatIntervalMs as number | null;
          if (level && entry && typeof body.position === "number") {
            level.entries = level.entries.filter(item => item.id !== entry.id);
            level.entries.splice(Math.max(0, Math.min(body.position, level.entries.length)), 0, entry);
            level.entries.forEach((item, index) => { item.position = index; });
          }
          return send({ ok: true, entry });
        }
        if (entryRoute?.[2] && req.method === "DELETE") {
          const level = alertLevels.find(item => item.id === entryRoute[1]);
          if (level) level.entries = level.entries.filter(item => item.id !== entryRoute[2]);
          return send({ ok: true, id: entryRoute[2] });
        }
        // Every other mutation (wizard saves, scans, acks, action approve/execute,
        // tier edits, notification tests) acknowledges without side effects.
        return send({ ok: true });
      });
    },
  };
}

async function readJson(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function normalizeLevelPositions(): void {
  alertLevels.forEach((level, position) => { level.position = position; });
}

export default defineConfig({
  plugins: [demoLoopbackGuard(), tailwindcss(), react(), demoApi()],
  server: { host: DEMO_HOST, port: DEMO_PORT, strictPort: true },
});
