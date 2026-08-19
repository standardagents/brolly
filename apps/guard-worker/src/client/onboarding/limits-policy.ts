import type { Policy, PolicyLimits, ScopeLimits } from "../types";

export type LimitsWindow = keyof PolicyLimits;

export interface LimitsScope {
  key: string;
  kind: "account" | "family" | "asset";
  legacyKey?: string;
  family?: string;
}

/** Update one chart scope while retaining the daily maps consumed by legacy readers. */
export function updateScope(policy: Policy, window: LimitsWindow, scope: LimitsScope, change: (current: ScopeLimits) => ScopeLimits): Policy {
  const limits: PolicyLimits = policy.limits
    ? { day: { ...(policy.limits.day ?? {}) }, cycle: { ...(policy.limits.cycle ?? {}) } }
    : { day: {}, cycle: {} };
  const next = change(limits[window][scope.key] ?? emptyScope());
  limits[window][scope.key] = next;
  const result: Policy = { ...policy, limits };
  if (window !== "day") return result;

  if (scope.kind === "account") result.accountDailySpend = next.cost;
  const familyKey = scope.legacyKey ?? scope.family;
  if (scope.kind === "family" && familyKey) result.familyDailySpend = { ...result.familyDailySpend, [familyKey]: next.cost };
  if (scope.kind === "asset" && scope.legacyKey) result.assetDailySpend = { ...result.assetDailySpend, [scope.legacyKey]: next.cost };
  return result;
}

export function emptyScope(): ScopeLimits {
  return { cost: {}, usage: {} };
}
