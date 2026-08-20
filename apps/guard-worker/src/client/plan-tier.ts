import type { DashboardData, OnboardingData, PlanTier } from "./types";

/**
 * Older installations do not return a tier until the first reconciliation
 * refresh. Brolly's included-quota behavior treats that state as paid, while
 * the settings surface keeps the detection failure visible.
 */
export function effectivePlanTier(value: Pick<DashboardData, "planTier"> | Pick<OnboardingData, "planTier"> | { planTier?: PlanTier } | undefined): PlanTier {
  return value?.planTier ?? "unknown";
}

export function isEnterprise(value: { planTier?: PlanTier } | undefined): boolean {
  return effectivePlanTier(value) === "enterprise";
}

export function isFree(value: { planTier?: PlanTier } | undefined): boolean {
  return effectivePlanTier(value) === "free";
}

export const ENTERPRISE_COST_NOTICE = "Cost tracking is not supported on Enterprise plans currently.";

export const FREE_PLAN_NOTICE = "Cloudflare enforces hard caps on free plans, the account cannot accrue spend, and Brolly probably will not help this account. Its spend alerts, budgets, and cost protection have nothing to protect until the account moves to a paid plan.";

export const ENTERPRISE_QUOTA_NOTICE = "Enterprise contracts have negotiated limits. Brolly cannot read those contract terms, so this boundary reflects the regular paid plan rather than this contract.";

export const UNKNOWN_PLAN_NOTICE = "Plan detection failed. Brolly is using the paid-plan baseline until the account tier is confirmed.";
