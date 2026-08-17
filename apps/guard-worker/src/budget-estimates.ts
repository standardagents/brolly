import {
  METRIC_CATALOG,
  RunBudget,
  assetBudgetKey,
  type CoverageResult,
  type MetricSample,
  type SpendLimits,
} from "@standardagents/brolly-core";
import { CloudflareClient, type BillingUsageRecord } from "./cloudflare.js";
import { sealJson } from "./credentials.js";
import type { Env } from "./env.js";

const DAY_MS = 86_400_000;
const CACHE_MS = 15 * 60_000;
const CACHE_KEY = "onboarding_budget_estimates";
const LEASE_NAME = "onboarding-budget-estimates";

export const ESTIMATE_HEADROOM = { warning: 1.25, critical: 1.75, emergency: 2.5 } as const;

export interface SuggestedBudget {
  observedUsd: number;
  limits: SpendLimits;
  source: "analytics" | "billing";
  partial: boolean;
}

export interface OnboardingBudgetEstimates {
  generatedAt: number;
  windowStartAt: number;
  windowEndAt: number;
  cached: boolean;
  apiCalls: number;
  headroom: typeof ESTIMATE_HEADROOM;
  account: SuggestedBudget | null;
  families: Record<string, SuggestedBudget>;
  assets: Record<string, SuggestedBudget>;
  unchangedFamilies: string[];
  access: Record<"workers" | "durable_objects" | "billing", UsageAccess>;
}

export interface UsageAccess {
  state: "connected" | "limited" | "blocked" | "not_configured" | "unknown";
  detail: string;
}

export interface BillingAccessConfiguration {
  configured: boolean;
  source: "worker_secret" | "encrypted_database" | "none";
  updatedAt: number | null;
}

export class BudgetEstimateInProgressError extends Error {
  constructor() {
    super("A recent-usage estimate is already running. Try again in a few seconds.");
    this.name = "BudgetEstimateInProgressError";
  }
}

export async function configureOnboardingBillingAccess(env: Env, token: string): Promise<{ records: number }> {
  const normalized = token.trim();
  const validationError = billingTokenValidationError(normalized);
  if (validationError) throw new Error(validationError);
  if (env.CLOUDFLARE_BILLING_TOKEN) throw new Error("Billing access is managed by the CLOUDFLARE_BILLING_TOKEN Worker secret. Replace that secret in Cloudflare instead of saving a second token in Brolly.");
  if (!env.BROLLY_CREDENTIAL_KEY) throw new Error("Brolly's credential-encryption key is unavailable");
  const budget = new RunBudget({ apiCalls: 1, databaseRows: 10, samples: 10_000, wallMs: 10_000 });
  const client = new CloudflareClient({ ...env, CLOUDFLARE_BILLING_TOKEN: normalized }, budget);
  const records = await client.billingUsage(Date.now() - 2 * DAY_MS, Date.now()).catch(error => {
    const detail = error instanceof Error ? error.message : String(error);
    if (/insufficient_permissions|permission|forbidden|unauthorized/i.test(detail)) {
      throw new Error("Cloudflare rejected this token for billable usage. Create a user API token scoped to this account with Billing Read, then try again.");
    }
    throw error;
  });
  if (!records) throw new Error("Cloudflare Billing Read access could not be verified");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO settings(key,value,updated_at) VALUES('billing_credentials',?1,?2)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    ).bind(await sealJson({ token: normalized }, env.BROLLY_CREDENTIAL_KEY), now),
    env.DB.prepare(`DELETE FROM settings WHERE key=?1`).bind(CACHE_KEY),
  ]);
  return { records: records.length };
}

export async function removeOnboardingBillingAccess(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM settings WHERE key='billing_credentials'`),
    env.DB.prepare(`DELETE FROM settings WHERE key=?1`).bind(CACHE_KEY),
  ]);
}

export async function billingAccessConfiguration(env: Env): Promise<BillingAccessConfiguration> {
  if (env.CLOUDFLARE_BILLING_TOKEN) return { configured: true, source: "worker_secret", updatedAt: null };
  const row = await env.DB.prepare(`SELECT updated_at FROM settings WHERE key='billing_credentials' LIMIT 1`).first<{ updated_at: number }>();
  return row
    ? { configured: true, source: "encrypted_database", updatedAt: row.updated_at }
    : { configured: false, source: "none", updatedAt: null };
}

export function validBillingToken(value: string): boolean {
  return value.length >= 20 && value.length <= 256 && !/\s/.test(value);
}

export function billingTokenValidationError(value: string): string | null {
  if (value.startsWith("cfat_")) {
    return "Cloudflare created an account-owned token, but its billable-usage API requires a user API token. Delete that token, click Create billing token again, and paste the new token that starts with cfut_.";
  }
  return validBillingToken(value) ? null : "Enter a valid Cloudflare API token without spaces";
}

export async function onboardingBudgetEstimates(env: Env): Promise<OnboardingBudgetEstimates> {
  const now = Date.now();
  const cached = await env.DB.prepare(`SELECT value,updated_at FROM settings WHERE key=?1 LIMIT 1`).bind(CACHE_KEY)
    .first<{ value: string; updated_at: number }>();
  if (cached && cached.updated_at >= now - CACHE_MS) {
    return { ...(JSON.parse(cached.value) as OnboardingBudgetEstimates), cached: true };
  }

  const holder = crypto.randomUUID();
  const lease = await env.DB.prepare(
    `INSERT INTO cron_lease(name,holder,expires_at) VALUES(?1,?2,?3)
     ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at
     WHERE cron_lease.expires_at<?4`,
  ).bind(LEASE_NAME, holder, now + 30_000, now).run();
  if (Number(lease.meta.changes ?? 0) !== 1) throw new BudgetEstimateInProgressError();

  try {
    const windowEndAt = Date.now();
    const windowStartAt = windowEndAt - DAY_MS;
    const budget = new RunBudget({ apiCalls: 4, databaseRows: 100, samples: 20_000, wallMs: 20_000 });
    const client = new CloudflareClient(env, budget);
    const [durableObjects, workers, billingResult] = await Promise.all([
      client.durableObjectUsage(windowStartAt, windowEndAt),
      client.workerUsage(windowStartAt, windowEndAt),
      client.billingUsage(windowStartAt - DAY_MS, windowEndAt)
        .then(records => ({ records, error: null as string | null }))
        .catch(error => ({ records: null, error: error instanceof Error ? error.message : String(error) })),
    ]);
    const result = buildOnboardingBudgetEstimates({
      generatedAt: Date.now(),
      windowStartAt,
      windowEndAt,
      samples: [...durableObjects.samples, ...workers.samples],
      billing: billingResult.records ?? [],
      coverage: [...durableObjects.coverage, ...workers.coverage],
      billingAccess: billingResult.error
        ? { state: "blocked", detail: `Cloudflare rejected the Billing Read check. Add or replace the read-only billing token below. Technical detail: ${billingResult.error}` }
        : billingResult.records
          ? { state: "connected", detail: "Brolly can compare its fast usage estimates with Cloudflare's daily billed charges for this account." }
          : { state: "not_configured", detail: "Brolly can monitor live activity, but it cannot yet compare those estimates with the charges on your Cloudflare bill. Add the read-only Billing token below." },
      apiCalls: budget.usage.apiCalls,
    });
    await env.DB.prepare(
      `INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    ).bind(CACHE_KEY, JSON.stringify(result), result.generatedAt).run();
    return result;
  } finally {
    await env.DB.prepare(`DELETE FROM cron_lease WHERE name=?1 AND holder=?2`).bind(LEASE_NAME, holder).run();
  }
}

export function buildOnboardingBudgetEstimates(input: {
  generatedAt: number;
  windowStartAt: number;
  windowEndAt: number;
  samples: MetricSample[];
  billing?: BillingUsageRecord[];
  coverage?: CoverageResult[];
  billingAccess?: UsageAccess;
  apiCalls?: number;
}): OnboardingBudgetEstimates {
  const analyticsFamilies = costBy(input.samples, sample => sample.asset.family);
  const analyticsAssets = costBy(input.samples, sample => {
    if (sample.asset.family === "workers" && sample.asset.scope === "resource") {
      return assetBudgetKey(sample.asset);
    }
    if (sample.asset.family === "durable_objects") {
      const namespaceId = sample.asset.scope === "namespace" ? sample.asset.id : sample.asset.parentId;
      if (namespaceId) return assetBudgetKey({ family: "durable_objects", scope: "namespace", id: namespaceId });
    }
    return null;
  });
  const billingFamilies = new Map<string, number>();
  let billingAccountUsd = 0;
  const billingRows = input.billing ?? [];
  const latestBillingDay = Math.max(...billingRows.map(row => Date.parse(row.ChargePeriodStart)).filter(Number.isFinite));
  for (const row of billingRows) {
    if (Date.parse(row.ChargePeriodStart) !== latestBillingDay) continue;
    const family = billingFamily(row);
    const cost = row.BilledCost ?? row.EffectiveCost ?? row.ListCost;
    if (!Number.isFinite(cost) || cost! <= 0) continue;
    billingAccountUsd += cost!;
    if (!family) continue;
    billingFamilies.set(family, (billingFamilies.get(family) ?? 0) + cost!);
  }

  const families: Record<string, SuggestedBudget> = {};
  for (const definition of METRIC_CATALOG) {
    const analytics = analyticsFamilies.get(definition.family) ?? 0;
    const billed = billingFamilies.get(definition.family) ?? 0;
    if (analytics > 0) families[definition.family] = suggestion(analytics, "analytics", input.samples.some(sample => sample.asset.family === definition.family && sample.sampled));
    else if (billed > 0) families[definition.family] = suggestion(billed, "billing", false);
  }

  const assets = Object.fromEntries([...analyticsAssets.entries()]
    .filter(([, observed]) => observed > 0)
    .map(([key, observed]) => [key, suggestion(observed, "analytics", false)]));
  const observedAnalyticsAccountUsd = Object.values(families).reduce((sum, item) => sum + item.observedUsd, 0);
  const hasCompleteBilling = input.billingAccess?.state === "connected" && billingAccountUsd > 0;
  const observedAccountUsd = hasCompleteBilling ? billingAccountUsd : observedAnalyticsAccountUsd;
  const account = observedAccountUsd > 0
    ? suggestion(observedAccountUsd, hasCompleteBilling ? "billing" : "analytics", !hasCompleteBilling)
    : null;

  return {
    generatedAt: input.generatedAt,
    windowStartAt: input.windowStartAt,
    windowEndAt: input.windowEndAt,
    cached: false,
    apiCalls: input.apiCalls ?? 0,
    headroom: ESTIMATE_HEADROOM,
    account,
    families,
    assets,
    unchangedFamilies: METRIC_CATALOG.map(item => item.family).filter(family => !families[family]),
    access: {
      workers: accessFor("workers", input.coverage ?? []),
      durable_objects: accessFor("durable_objects", input.coverage ?? []),
      billing: input.billingAccess ?? { state: "unknown", detail: "Billing access was not checked." },
    },
  };
}

function accessFor(family: string, coverage: CoverageResult[]): UsageAccess {
  const relevant = coverage.filter(item => item.family === family);
  if (!relevant.length) return { state: "unknown", detail: "No usage response was returned." };
  const healthy = relevant.filter(item => item.state === "healthy").length;
  const delayed = relevant.filter(item => item.state === "delayed").length;
  const failures = relevant.filter(item => item.state === "unavailable" || item.state === "permission_denied");
  const detail = [...new Set(failures.map(item => item.detail).filter((value): value is string => Boolean(value)))].slice(0, 2).join(" ");
  if (healthy === relevant.length) return {
    state: "connected",
    detail: family === "durable_objects"
      ? "Brolly can monitor requests, compute time, WebSocket messages, SQL rows, and storage for individual Durable Objects and namespaces. Nothing else is needed."
      : "Brolly can monitor this service at the most detailed level Cloudflare provides. Nothing else is needed.",
  };
  if (healthy > 0 || delayed > 0) return { state: "limited", detail: detail || "Some usage signals are available, but one or more are delayed or unavailable." };
  return { state: "blocked", detail: detail || "Cloudflare did not return the requested usage signals. Reconnect Brolly and verify account permissions." };
}

function costBy(samples: MetricSample[], keyFor: (sample: MetricSample) => string | null): Map<string, number> {
  const costs = new Map<string, number>();
  for (const sample of samples) {
    const key = keyFor(sample);
    const cost = sample.estimatedCostUsd;
    if (!key || !Number.isFinite(cost) || cost! <= 0) continue;
    costs.set(key, (costs.get(key) ?? 0) + cost!);
  }
  return costs;
}

function suggestion(observedUsd: number, source: SuggestedBudget["source"], partial: boolean): SuggestedBudget {
  const warning = roundBudget(observedUsd * ESTIMATE_HEADROOM.warning);
  const critical = roundBudget(Math.max(observedUsd * ESTIMATE_HEADROOM.critical, warning + budgetStep(warning)));
  const emergency = roundBudget(Math.max(observedUsd * ESTIMATE_HEADROOM.emergency, critical + budgetStep(critical)));
  return { observedUsd, limits: { warning, critical, emergency }, source, partial };
}

function roundBudget(value: number): number {
  const step = budgetStep(value);
  return Number((Math.ceil(value / step) * step).toFixed(2));
}

function budgetStep(value: number): number {
  if (value < 1) return 0.01;
  if (value < 10) return 0.1;
  if (value < 100) return 1;
  if (value < 1_000) return 5;
  return 25;
}

function billingFamily(row: BillingUsageRecord): string | null {
  const value = `${row.x_ProductFamilyId ?? ""} ${row.x_ProductFamilyName ?? ""} ${row.x_BillableMetricId ?? ""} ${row.x_BillableMetricName ?? ""}`
    .toLowerCase().replaceAll(/[^a-z0-9]+/g, " ");
  const patterns: Array<[string, RegExp]> = [
    ["durable_objects", /durable object/],
    ["workers_ai", /workers ai|ai inference/],
    ["ai_gateway", /ai gateway/],
    ["kv", /workers kv|key value/],
    ["d1", /\bd1\b/],
    ["r2", /\br2\b/],
    ["queues", /\bqueue/],
    ["vectorize", /vectorize/],
    ["hyperdrive", /hyperdrive/],
    ["pages", /cloudflare pages|pages build/],
    ["images", /cloudflare images|image transformation/],
    ["stream", /cloudflare stream|stream video/],
    ["containers", /\bcontainers?\b/],
    ["browser_rendering", /browser rendering/],
    ["workflows", /\bworkflows?\b/],
    ["worker_builds", /worker builds?|build minutes?/],
    ["analytics_engine", /analytics engine/],
    ["log_explorer", /log explorer/],
    ["zones", /zone analytics|bandwidth/],
    ["email", /email routing|email service|email sent/],
    ["workers", /\bworkers?\b/],
  ];
  return patterns.find(([, pattern]) => pattern.test(value))?.[0] ?? null;
}
