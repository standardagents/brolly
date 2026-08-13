/**
 * Dashboard UI preview harness. Serves the real dashboard client against an
 * in-process mock API so every page and state renders without a Cloudflare
 * account, OAuth client, or D1 database.
 *
 *   pnpm dev:demo        # from the repository root or this package
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
import { defineConfig, type Plugin } from "vite";

const now = Date.now();
const HOUR = 3_600_000;

const spendLimits = (warning: number, critical: number, emergency: number) => ({ warning, critical, emergency });

const session = {
  authenticated: true,
  oauthConfigured: true,
  credentialStorageReady: true,
  actor: { name: "Demo Session", kind: "session" },
  account: { id: "placeholder-demo-account", name: "Demo Account (local preview)" },
};

const billingAccess = {
  configured: false,
  source: "none" as const,
  updatedAt: null,
};

const policy = {
  version: "4",
  mode: "approval",
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

const onboarding = {
  complete: true,
  policy,
  families: [
    { family: "workers", label: "Workers", metrics: ["requests", "duration_gbs", "subrequests"], protection: "active" },
    { family: "durable_objects", label: "Durable Objects", metrics: ["duration_gbs", "requests", "storage_bytes"], protection: "active" },
    { family: "d1", label: "D1", metrics: ["rows_read", "rows_written"], protection: "active" },
    { family: "kv", label: "Workers KV", metrics: ["reads", "writes"], protection: "active" },
    { family: "queues", label: "Queues", metrics: ["backlog", "operations"], protection: "coverage_gap" },
  ],
  scopedAssets: [
    { key: "workers:api-gateway", family: "workers", id: "api-gateway", name: "api-gateway", scope: "resource", protection: "active", tags: { env: "production" } },
    { key: "workers:image-resizer", family: "workers", id: "image-resizer", name: "image-resizer", scope: "resource", protection: "active", tags: {} },
    { key: "durable_objects:agent-thread", family: "durable_objects", id: "agent-thread", name: "AgentThread", scope: "namespace", protection: "active", tags: { app: "agents" } },
    { key: "durable_objects:rate-limiter", family: "durable_objects", id: "rate-limiter", name: "RateLimiter", scope: "namespace", protection: "coverage_gap", tags: {} },
  ],
};

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
  policy: {
    mode: policy.mode,
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
        declared: check("pass", "Declared", "Runtime fuse declared in deployment metadata."),
        apiAccess: check("pass", "API access", "Script metadata is readable."),
        fuseSecret: check("pass", "Fuse secret", "BROLLY_FUSE secret present."),
        runtimeBundle: check("pass", "Runtime bundle", "@standardagents/brolly-runtime detected."),
        activeDeployment: check("pass", "Active deployment", "Fuse active in the current deployment."),
      },
    },
    {
      id: "image-resizer", name: "image-resizer", tier: "standard", tags: {}, seenAt: now - 6 * 60_000,
      declaredInstalled: false, namespaceCount: 0, checkedAt: now - 15 * 60_000,
      deploymentId: "deploy-88", versionId: "ver-88", status: "partial",
      checks: {
        inventory: check("pass", "Inventory", "Seen in the account inventory scan."),
        declared: check("fail", "Declared", "No runtime fuse declared for this Worker."),
        apiAccess: check("pass", "API access", "Script metadata is readable."),
        fuseSecret: check("fail", "Fuse secret", "BROLLY_FUSE secret not found."),
        runtimeBundle: check("unknown", "Runtime bundle", "Not checked because the fuse is not declared."),
        activeDeployment: check("unknown", "Active deployment", "Not checked because the fuse is not declared."),
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

const targets = [
  {
    id: "target-1",
    kind: "discord",
    enabled: true,
    minimumSeverity: "warning",
    createdAt: now - 6 * 24 * HOUR,
    updatedAt: now - 6 * 24 * HOUR,
    lastDeliveryAt: now - 2 * HOUR,
    lastDeliveryOk: true,
    lastDeliveryError: null,
  },
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

function demoApi(): Plugin {
  return {
    name: "brolly-demo-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/api/")) return next();
        const send = (body: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        const get = req.method === "GET";
        if (url.pathname === "/api/auth/session") return send(session);
        if (url.pathname === "/api/onboarding" && get) return send(onboarding);
        if (url.pathname === "/api/billing-access" && get) return send(billingAccess);
        if (url.pathname === "/api/dashboard") return send(dashboard);
        if (url.pathname === "/api/configuration" && get) return send(configuration);
        if (url.pathname === "/api/targets" && get) return send(targets);
        if (url.pathname === "/api/assets" && get) return send({ assets });
        // Every mutation (wizard saves, scans, acks, action approve/execute,
        // tier edits, notification tests) acknowledges without side effects.
        return send({ ok: true });
      });
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), react(), demoApi()],
  server: { port: 5199, strictPort: true },
});
