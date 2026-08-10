import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY, MonitoringBudgetExceededError, RunBudget, evaluateProjectedDailySpend, evaluateSample, upsertIncident } from "../src/index.js";

const asset = { accountId: "account", family: "durable_objects", id: "object", scope: "object" as const, tier: "standard" as const };

describe("RunBudget", () => {
  it("fails closed at a hard API-call cap", () => {
    const budget = new RunBudget({ apiCalls: 1, databaseRows: 2, samples: 2, wallMs: 1000 });
    budget.charge("apiCalls");
    expect(() => budget.charge("apiCalls")).toThrow(MonitoringBudgetExceededError);
    expect(budget.signal.aborted).toBe(true);
  });

  it("actively aborts in-flight collectors at the wall-clock limit", async () => {
    const budget = new RunBudget({ apiCalls: 1, databaseRows: 1, samples: 1, wallMs: 5 });
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(budget.signal.aborted).toBe(true);
  });
});

describe("policy", () => {
  it("prepares a reversible stop at the default emergency threshold", () => {
    const result = evaluateSample(
      { asset, metric: "rows_read", unit: "rows", value: 5_000_000, start: 0, end: 300_000, source: "graphql" },
      DEFAULT_POLICY.thresholds[0]!, [], DEFAULT_POLICY,
    );
    expect(result).toMatchObject({ severity: "emergency", action: "prepare_stop" });
  });

  it("never auto-stops a control-plane asset", () => {
    const result = evaluateSample(
      { asset: { ...asset, tier: "control_plane" }, metric: "rows_read", unit: "rows", value: 9_000_000, start: 0, end: 300_000, source: "graphql" },
      DEFAULT_POLICY.thresholds[0]!, [], { ...DEFAULT_POLICY, mode: "automatic" },
    );
    expect(result?.action).toBe("notify");
  });

  it("alerts on projected cost for an individual Durable Object", () => {
    const threshold = DEFAULT_POLICY.thresholds.find(item => item.metric === "projected_daily_cost_usd")!;
    const result = evaluateSample(
      { asset, metric: "projected_daily_cost_usd", unit: "usd", value: 5, start: 0, end: 86_400_000, source: "graphql" },
      threshold, [], DEFAULT_POLICY,
    );
    expect(result).toMatchObject({ severity: "emergency", action: "prepare_stop", observed: 5 });
  });

  it("uses the product-family daily budget for account-level spend", () => {
    const result = evaluateProjectedDailySpend(
      { ...asset, id: "account", scope: "account", tier: "control_plane" }, 7,
      { ...DEFAULT_POLICY, accountDailySpend: { warning: 50, critical: 75, emergency: 100 }, familyDailySpend: { durable_objects: { warning: 2, critical: 5, emergency: 10 } } },
    );
    expect(result).toMatchObject({ severity: "critical", observed: 7 });
  });

  it("uses Worker and Durable Object namespace budgets before family defaults", () => {
    const policy = {
      ...DEFAULT_POLICY,
      familyDailySpend: { ...DEFAULT_POLICY.familyDailySpend, workers: { warning: 50, critical: 75, emergency: 100 }, durable_objects: { warning: 50, critical: 75, emergency: 100 } },
      assetDailySpend: {
        "workers:resource:checkout": { warning: 1, critical: 2, emergency: 3 },
        "durable_objects:namespace:rooms": { warning: 2, critical: 4, emergency: 6 },
      },
    };
    const worker = evaluateProjectedDailySpend({ accountId: "account", family: "workers", id: "checkout", scope: "resource", tier: "standard" }, 2.5, policy);
    const object = evaluateProjectedDailySpend({ ...asset, id: "object-1", parentId: "rooms" }, 5, policy);
    expect(worker).toMatchObject({ severity: "critical", observed: 2.5 });
    expect(object).toMatchObject({ severity: "critical", observed: 5 });
    expect(worker?.key).not.toBe(object?.key);
  });

  it("rolls repeated evaluations into one incident", () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000");
    const evaluation = evaluateSample(
      { asset, metric: "rows_read", unit: "rows", value: 5_000_000, start: 0, end: 1, source: "graphql" },
      DEFAULT_POLICY.thresholds[0]!, [], DEFAULT_POLICY,
    )!;
    const first = upsertIncident(undefined, evaluation, 100);
    const second = upsertIncident(first, evaluation, 200);
    expect(second).toMatchObject({ id: first.id, occurrences: 2, firstSeen: 100, lastSeen: 200 });
    vi.restoreAllMocks();
  });
});
