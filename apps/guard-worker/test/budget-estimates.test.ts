import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetricSample } from "@standardagents/brolly-core";
import { billingAccessConfiguration, billingTokenValidationError, buildOnboardingBudgetEstimates, configureOnboardingBillingAccess, onboardingBudgetEstimates, validBillingToken } from "../src/budget-estimates.js";
import { CloudflareClient } from "../src/cloudflare.js";
import { openJson } from "../src/credentials.js";
import type { Env } from "../src/env.js";
import { readPlanState } from "../src/plan-tier.js";
import { createTestD1 } from "./d1.js";

const start = Date.UTC(2026, 7, 11);
const end = start + 86_400_000;
const credentialKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

describe("billing access configuration", () => {
  it("verifies and stores a token when production billing reads fall back, align, and retry", async () => {
    const testD1 = createTestD1();
    const token = `cfut_${"a".repeat(40)}`;
    const cycleStart = new Date(Date.now() - 86_400_000).toISOString();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1 || calls === 3 || calls === 5) {
        return new Response(JSON.stringify({ errors: [{ message: "rate limited" }] }), {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      if (calls === 2) {
        return Response.json({ success: false, errors: [{ message: "restricted" }] }, { status: 403 });
      }
      return Response.json({ success: true, result: [{
        BilledCost: 0.25,
        ChargePeriodStart: cycleStart,
        ChargePeriodEnd: new Date().toISOString(),
        BillingPeriodStart: cycleStart,
        ConsumedQuantity: 1,
        ConsumedUnit: "Count",
        ServiceName: "Workers Standard Requests",
        ServiceFamilyName: "Workers",
      }] });
    }));

    try {
      const env = { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", BROLLY_CREDENTIAL_KEY: credentialKey } as Env;
      await expect(configureOnboardingBillingAccess(env, token)).resolves.toEqual({ records: 1 });
      expect(calls).toBe(6);
      const stored = await testD1.db.prepare(`SELECT value FROM settings WHERE key='billing_credentials'`).first<{ value: string }>();
      expect(stored?.value).not.toContain(token);
      await expect(openJson<{ token: string }>(stored!.value, credentialKey)).resolves.toEqual({ token });
    } finally {
      testD1.close();
    }
  });

  it("reports credential metadata only and never the stored token", async () => {
    const stored = { key: "billing_credentials", value: "cfut_encrypted_secret_material", updated_at: 1_700_000_000_000 };
    const db = { prepare: () => ({ first: async () => stored }) };
    const fromDatabase = await billingAccessConfiguration({ DB: db } as never);
    expect(fromDatabase).toEqual({ configured: true, source: "encrypted_database", updatedAt: stored.updated_at });
    expect(JSON.stringify(fromDatabase)).not.toContain(stored.value);

    const fromSecret = await billingAccessConfiguration({ DB: db, CLOUDFLARE_BILLING_TOKEN: "cfut_worker_secret_value" } as never);
    expect(fromSecret).toEqual({ configured: true, source: "worker_secret", updatedAt: null });
    expect(JSON.stringify(fromSecret)).not.toContain("cfut_worker_secret_value");
  });
});

describe("onboarding budget estimates", () => {
  it("detects and persists the account plan during the initial access check", async () => {
    const testD1 = createTestD1();
    vi.spyOn(CloudflareClient.prototype, "durableObjectUsage").mockResolvedValue({
      samples: [], coverage: [], continuation: null, complete: true, pages: 1, watermarkAt: end,
    });
    vi.spyOn(CloudflareClient.prototype, "workerUsage").mockResolvedValue({
      samples: [], coverage: [], continuation: null, complete: true, pages: 1, watermarkAt: end,
    });
    vi.spyOn(CloudflareClient.prototype, "billingUsage").mockResolvedValue(null);
    vi.spyOn(CloudflareClient.prototype, "subscriptions").mockResolvedValue([
      { state: "Paid", rate_plan: { id: "workers_paid" } },
    ]);

    try {
      const result = await onboardingBudgetEstimates({
        DB: testD1.db,
        BROLLY_ACCOUNT_ID: "account-1",
        CLOUDFLARE_OAUTH_TOKEN: "oauth-token",
      } as Env);

      expect(result).toMatchObject({ planTier: "paid", planTierSource: "api" });
      await expect(readPlanState(testD1.db)).resolves.toMatchObject({
        detectedTier: "paid",
        planTier: "paid",
        planTierSource: "api",
      });
    } finally {
      testD1.close();
    }
  });

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
