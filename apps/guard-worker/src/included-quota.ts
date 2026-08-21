import { METRIC_DEFINITIONS } from "@standardagents/brolly-core";

/**
 * An allotment that Cloudflare includes in each Workers Paid billing cycle.
 * Quantities use the unit of the matching Brolly metric definition.
 */
export interface IncludedAllotment {
  /** Brolly billable metric id, matching the usage-series metric catalog. */
  metricId: string;
  /** Included quantity per billing cycle on the Workers Paid plan. */
  includedPerCycle: number;
  unit: string;
}

export type PlanTier = "free" | "paid" | "enterprise" | "unknown";
export type PlanTierSource = "api" | "override";

export const INCLUDED_QUOTA_CATALOG_VERSION = "2026-08";

/*
 * Maintenance: Cloudflare changes included quantities from time to time.
 * Bump INCLUDED_QUOTA_CATALOG_VERSION and re-verify every value against the
 * official pricing pages before releasing a catalog change.
 *
 * Verification date: 2026-08-20.
 * Workers: https://developers.cloudflare.com/workers/platform/pricing/
 * Workers Paid request and CPU quantities match the Workers Paid table.
 */

/** Workers Paid allotments verified against the Workers pricing table above. */
const WORKERS_PAID_WORKERS: IncludedAllotment[] = [
  { metricId: "workers:requests", includedPerCycle: 10_000_000, unit: "requests" },
  { metricId: "workers:cpu_ms", includedPerCycle: 30_000_000, unit: "milliseconds" },
];

/*
 * Verification date: 2026-08-20.
 * Workers KV: https://developers.cloudflare.com/kv/platform/pricing/
 * The Paid plan table lists the operation and storage quantities below.
 */
const WORKERS_PAID_KV: IncludedAllotment[] = [
  { metricId: "kv:reads", includedPerCycle: 10_000_000, unit: "count" },
  { metricId: "kv:writes", includedPerCycle: 1_000_000, unit: "count" },
  { metricId: "kv:deletes", includedPerCycle: 1_000_000, unit: "count" },
  { metricId: "kv:lists", includedPerCycle: 1_000_000, unit: "count" },
  { metricId: "kv:storage_bytes", includedPerCycle: 1_000_000_000, unit: "bytes" },
];

/*
 * Verification date: 2026-08-20.
 * D1: https://developers.cloudflare.com/d1/platform/pricing/
 * The pricing table lists 25 billion rows read, 50 million rows written, and
 * 5 GB of storage per month. Brolly stores byte quantities in decimal bytes.
 */
const WORKERS_PAID_D1: IncludedAllotment[] = [
  { metricId: "d1:rows_read", includedPerCycle: 25_000_000_000, unit: "rows" },
  { metricId: "d1:rows_written", includedPerCycle: 50_000_000, unit: "rows" },
  { metricId: "d1:storage_bytes", includedPerCycle: 5_000_000_000, unit: "bytes" },
];

/*
 * Verification date: 2026-08-20.
 * Durable Objects: https://developers.cloudflare.com/durable-objects/platform/pricing/
 * The current Paid plan table lists 1 million requests, 400,000 GB-seconds,
 * 25 billion rows read, 50 million rows written, 5 GB SQL storage, 1 million
 * KV read/write/delete units, and 1 GB KV storage per month. Its lines 145-183
 * also describe the 20:1 WebSocket conversion; the raw message metric is
 * excluded because it is not the billed request unit. Incoming WebSocket
 * messages instead consume the shared request allotment at 20:1 — BILLED_VIA
 * below records that fold for the estimator and the dashboard note.
 */
const WORKERS_PAID_DURABLE_OBJECTS: IncludedAllotment[] = [
  { metricId: "durable_objects:requests", includedPerCycle: 1_000_000, unit: "requests" },
  { metricId: "durable_objects:duration_gb_seconds", includedPerCycle: 400_000, unit: "gb_seconds" },
  { metricId: "durable_objects:rows_read", includedPerCycle: 25_000_000_000, unit: "rows" },
  { metricId: "durable_objects:rows_written", includedPerCycle: 50_000_000, unit: "rows" },
  { metricId: "durable_objects:sql_storage_bytes", includedPerCycle: 5_000_000_000, unit: "bytes" },
  { metricId: "durable_objects:kv_read_units", includedPerCycle: 1_000_000, unit: "count" },
  { metricId: "durable_objects:kv_write_units", includedPerCycle: 1_000_000, unit: "count" },
  { metricId: "durable_objects:kv_delete_requests", includedPerCycle: 1_000_000, unit: "count" },
  { metricId: "durable_objects:kv_storage_bytes", includedPerCycle: 1_000_000_000, unit: "bytes" },
];

/*
 * Verification date: 2026-08-20.
 * R2: https://developers.cloudflare.com/r2/pricing/
 * The Standard storage table lists 1 million Class A requests, 10 million
 * Class B requests, and 10 GB-month of storage. Brolly stores byte quantities
 * in decimal bytes. Egress has no charge and therefore has no boundary.
 */
const WORKERS_PAID_R2: IncludedAllotment[] = [
  { metricId: "r2:class_a", includedPerCycle: 1_000_000, unit: "count" },
  { metricId: "r2:class_b", includedPerCycle: 10_000_000, unit: "count" },
  { metricId: "r2:storage_bytes", includedPerCycle: 10_000_000_000, unit: "bytes" },
];

/*
 * Verification date: 2026-08-20.
 * Queues: https://developers.cloudflare.com/queues/platform/pricing/
 * The Workers Paid table lists 1 million standard operations per month.
 */
const WORKERS_PAID_QUEUES: IncludedAllotment[] = [
  { metricId: "queues:operations", includedPerCycle: 1_000_000, unit: "count" },
];

/**
 * Metrics that have no meter of their own but bill into another metric's
 * shared allotment. `ratio` source units count as one billed unit of the
 * target meter. The dashboard shows this as a note on the source row, and
 * the billable-cost estimator folds the converted quantity into the target
 * meter's cycle consumption.
 */
export const BILLED_VIA: Readonly<Record<string, { metricId: string; ratio: number; label: string }>> = {
  "durable_objects:incoming_websocket_messages": { metricId: "durable_objects:requests", ratio: 20, label: "Durable Objects request" },
};

export const WORKERS_PAID_INCLUDED: IncludedAllotment[] = [
  ...WORKERS_PAID_WORKERS,
  ...WORKERS_PAID_KV,
  ...WORKERS_PAID_D1,
  ...WORKERS_PAID_DURABLE_OBJECTS,
  ...WORKERS_PAID_R2,
  ...WORKERS_PAID_QUEUES,
];

const ACTIVE_SUBSCRIPTION_STATES = new Set(["active", "awaitingpayment", "complete", "current", "enabled", "paid", "provisioned", "trial"]);
const INACTIVE_SUBSCRIPTION_STATES = new Set(["canceled", "cancelled", "expired", "failed", "terminated"]);
// Confirmed against a real account-scoped response on 2026-08-20: the
// Workers Paid account subscription uses the exact `workers_paid` id. The
// API docs list sample IDs and warn that the list is non-exhaustive.
const WORKERS_PAID_RATE_PLAN_IDS = new Set(["workers_paid"]);
// Account add-ons such as `teams_free` can carry `is_contract` while the
// account remains outside an Enterprise Workers plan.
// The account plan documented by the execution plan uses the exact `enterprise`
// id; keep this set explicit so product/component names cannot broaden it.
const ENTERPRISE_RATE_PLAN_IDS = new Set(["enterprise"]);

interface SubscriptionLike {
  state?: unknown;
  status?: unknown;
  scope?: unknown;
  rate_plan?: unknown;
  ratePlan?: unknown;
  product?: unknown;
  product_id?: unknown;
  productId?: unknown;
}

/**
 * Classify a successful account-subscriptions payload without making API
 * assumptions outside the response. Invalid or error-shaped payloads are
 * unknown so a failed probe never masquerades as a free account.
 */
export function classifyPlanTier(payload: unknown): PlanTier {
  const subscriptions = subscriptionRows(payload);
  if (!subscriptions) return "unknown";

  const active = subscriptions.filter(isActiveSubscription);
  if (active.some(isEnterpriseSubscription)) return "enterprise";
  if (active.some(isWorkersPaidSubscription)) return "paid";
  return "free";
}

/** Return the catalog for tiers whose charts use the regular paid baseline. */
export function includedAllotmentsForTier(tier: PlanTier): IncludedAllotment[] {
  return tier === "free" ? [] : WORKERS_PAID_INCLUDED;
}

/** Resolve an operator override over the most recent API detection. */
export function effectivePlanTier(detectedTier: PlanTier, overrideTier: PlanTier | null): PlanTier {
  return overrideTier ?? detectedTier;
}

/** Return the API-visible source for a resolved plan tier. */
export function planTierSource(overrideTier: PlanTier | null): PlanTierSource {
  return overrideTier === null ? "api" : "override";
}

function subscriptionRows(payload: unknown): SubscriptionLike[] | null {
  if (Array.isArray(payload)) return payload.filter(isObject) as SubscriptionLike[];
  if (!isObject(payload)) return null;
  if (payload.success === false) return null;
  if (Array.isArray(payload.result)) return payload.result.filter(isObject) as SubscriptionLike[];
  if (Array.isArray(payload.subscriptions)) return payload.subscriptions.filter(isObject) as SubscriptionLike[];
  if (isObject(payload.result) && Array.isArray(payload.result.subscriptions)) {
    return payload.result.subscriptions.filter(isObject) as SubscriptionLike[];
  }
  return null;
}

function isActiveSubscription(subscription: SubscriptionLike): boolean {
  const raw = subscription.state ?? subscription.status;
  if (raw == null) return true;
  const state = normalize(raw);
  if (INACTIVE_SUBSCRIPTION_STATES.has(state)) return false;
  return ACTIVE_SUBSCRIPTION_STATES.has(state);
}

function isEnterpriseSubscription(subscription: SubscriptionLike): boolean {
  const ratePlan = isObject(subscription.rate_plan) ? subscription.rate_plan : isObject(subscription.ratePlan) ? subscription.ratePlan : {};
  if (!isAccountScopedRatePlan(subscription, ratePlan)) return false;
  return ratePlanIdentifiers(subscription, ratePlan).some(value => ENTERPRISE_RATE_PLAN_IDS.has(normalizeIdentifier(value)));
}

function isWorkersPaidSubscription(subscription: SubscriptionLike): boolean {
  const ratePlan = isObject(subscription.rate_plan) ? subscription.rate_plan : isObject(subscription.ratePlan) ? subscription.ratePlan : {};
  if (!isAccountScopedRatePlan(subscription, ratePlan)) return false;
  return ratePlanIdentifiers(subscription, ratePlan).some(value => WORKERS_PAID_RATE_PLAN_IDS.has(normalizeIdentifier(value)));
}

function isAccountScopedRatePlan(subscription: SubscriptionLike, ratePlan: Record<string, unknown>): boolean {
  // Zone subscriptions also appear in the account-scoped response. The plan
  // tier is an account property, so a plan with an explicit non-account scope
  // cannot establish the account's Workers tier.
  const scope = ratePlan.scope ?? subscription.scope;
  return scope === undefined || normalize(scope) === "account";
}

function ratePlanIdentifiers(subscription: SubscriptionLike, ratePlan: Record<string, unknown>): string[] {
  return [
    stringValue(ratePlan.id), stringValue(ratePlan.product), stringValue(ratePlan.product_id),
    stringValue(ratePlan.productId), stringValue(subscription.product), stringValue(subscription.product_id),
    stringValue(subscription.productId),
  ].filter((value): value is string => Boolean(value));
}

function normalize(value: unknown): string {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const metricDefinitionIds = new Set(METRIC_DEFINITIONS.map(definition => definition.id));

/** Test and maintenance helper for the catalog's metric-id invariant. */
export function isKnownMetricId(metricId: string): boolean {
  return metricDefinitionIds.has(metricId);
}
