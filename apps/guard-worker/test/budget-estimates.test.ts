import { describe, expect, it } from "vitest";
import type { MetricSample } from "@standardagents/brolly-core";
import { billingTokenValidationError, buildOnboardingBudgetEstimates, validBillingToken } from "../src/budget-estimates.js";

const start = Date.UTC(2026, 7, 11);
const end = start + 86_400_000;

function sample(family: string, id: string, cost: number, options: { parentId?: string; scope?: MetricSample["asset"]["scope"]; sampled?: boolean } = {}): MetricSample {
  return {
    asset: {
      accountId: "account",
      family,
      id,
      parentId: options.parentId,
      scope: options.scope ?? "resource",
      tier: "unclassified",
    },
    metric: "requests",
    unit: "requests",
    value: 1,
    estimatedCostUsd: cost,
    source: "graphql",
    sampled: options.sampled,
    start,
    end,
  };
}

describe("onboarding budget estimates", () => {
  it("accepts bounded API-token values without accepting whitespace or empty secrets", () => {
    expect(validBillingToken(`cfat_${"a".repeat(40)}`)).toBe(true);
    expect(validBillingToken("short")).toBe(false);
    expect(validBillingToken(`cfat_${"a".repeat(20)} pasted`)).toBe(false);
    expect(validBillingToken("a".repeat(257))).toBe(false);
  });

  it("rejects account-owned tokens with instructions for the required user token", () => {
    expect(billingTokenValidationError(`cfat_${"a".repeat(40)}`)).toContain("account-owned token");
    expect(billingTokenValidationError(`cfat_${"a".repeat(40)}`)).toContain("cfut_");
    expect(billingTokenValidationError(`cfut_${"a".repeat(40)}`)).toBeNull();
  });

  it("adds graduated headroom and groups Workers and Durable Objects by enforceable resource", () => {
    const result = buildOnboardingBudgetEstimates({
      generatedAt: end,
      windowStartAt: start,
      windowEndAt: end,
      apiCalls: 2,
      samples: [
        sample("workers", "api", 4),
        sample("durable_objects", "object-a", 2, { parentId: "sessions", scope: "object" }),
        sample("durable_objects", "object-b", 3, { parentId: "sessions", scope: "object", sampled: true }),
      ],
      coverage: [
        { family: "workers", metric: "requests", finestScope: "resource", state: "healthy", checkedAt: end },
        { family: "durable_objects", metric: "rows_read", finestScope: "object", state: "healthy", checkedAt: end },
        { family: "durable_objects", metric: "rows_written", finestScope: "object", state: "permission_denied", checkedAt: end, detail: "Missing Analytics Read" },
      ],
    });

    expect(result.families.workers).toMatchObject({ observedUsd: 4, limits: { warning: 5, critical: 7, emergency: 10 } });
    expect(result.families.durable_objects).toMatchObject({ observedUsd: 5, partial: true });
    expect(result.assets["workers:resource:api"]?.observedUsd).toBe(4);
    expect(result.assets["durable_objects:namespace:sessions"]?.observedUsd).toBe(5);
    expect(result.account).toMatchObject({ observedUsd: 9, partial: true });
    expect(result.access.workers.state).toBe("connected");
    expect(result.access.durable_objects).toEqual({ state: "limited", detail: "Missing Analytics Read" });
    expect(result.apiCalls).toBe(2);
  });

  it("uses available billing costs for other known product families and ignores zero-cost rows", () => {
    const result = buildOnboardingBudgetEstimates({
      generatedAt: end,
      windowStartAt: start,
      windowEndAt: end,
      samples: [],
      billingAccess: { state: "connected", detail: "Available" },
      billing: [
        {
          ChargePeriodStart: new Date(start - 86_400_000).toISOString(),
          ChargePeriodEnd: new Date(start).toISOString(),
          ConsumedQuantity: 1_000,
          ConsumedUnit: "GB-month",
          x_BillableMetricId: "r2_storage",
          x_BillableMetricName: "R2 storage",
          x_ProductFamilyName: "R2",
          BilledCost: 100,
        },
        {
          ChargePeriodStart: new Date(start).toISOString(),
          ChargePeriodEnd: new Date(end).toISOString(),
          ConsumedQuantity: 100,
          ConsumedUnit: "GB-month",
          x_BillableMetricId: "r2_storage",
          x_BillableMetricName: "R2 storage",
          x_ProductFamilyName: "R2",
          BilledCost: 6,
        },
        {
          ChargePeriodStart: new Date(start).toISOString(),
          ChargePeriodEnd: new Date(end).toISOString(),
          ConsumedQuantity: 10,
          ConsumedUnit: "Requests",
          x_BillableMetricId: "workers_requests",
          x_BillableMetricName: "Workers requests",
          x_ProductFamilyName: "Workers",
          BilledCost: 0,
        },
      ],
    });

    expect(result.families.r2).toMatchObject({ observedUsd: 6, source: "billing", limits: { warning: 7.5, critical: 11, emergency: 15 } });
    expect(result.families.workers).toBeUndefined();
    expect(result.account).toMatchObject({ observedUsd: 6, source: "billing", partial: false });
    expect(result.unchangedFamilies).toContain("workers");
  });
});
