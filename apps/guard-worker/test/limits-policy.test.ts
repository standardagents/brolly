import { describe, expect, it } from "vitest";
import { emptyScope, updateScope } from "../src/client/onboarding/limits-policy";
import type { Policy } from "../src/client/types";

const limits = (value: number) => ({ warning: value, critical: value * 2, emergency: value * 4 });

function policy(): Policy {
  return {
    version: "test",
    accountDailySpend: limits(1),
    familyDailySpend: { existing: limits(2) },
    assetDailySpend: { "workers:resource:existing": limits(3) },
    limits: {
      day: { untouched: { cost: limits(4), usage: {}, enabled: false } },
      cycle: { untouched: { cost: limits(5), usage: {} } },
    },
    thresholds: [],
  };
}

describe("limits policy updates", () => {
  it("creates independent empty scopes", () => {
    const first = emptyScope();
    const second = emptyScope();
    expect(first).toEqual({ cost: {}, usage: {} });
    expect(first.cost).not.toBe(second.cost);
    expect(first.usage).not.toBe(second.usage);
  });

  it("initializes missing chart limits and mirrors account daily cost", () => {
    const current = policy();
    delete current.limits;
    const cost = limits(10);
    const next = updateScope(current, "day", { key: "account", kind: "account" }, scope => ({ ...scope, cost, costEnabled: false }));
    expect(next.limits?.day.account).toEqual({ cost, usage: {}, costEnabled: false });
    expect(next.limits?.cycle).toEqual({});
    expect(next.accountDailySpend).toBe(cost);
  });

  it("mirrors family and asset daily cost without replacing other legacy entries", () => {
    const current = policy();
    const familyCost = limits(10);
    const family = updateScope(current, "day", { key: "family:workers", kind: "family", family: "workers" }, scope => ({ ...scope, cost: familyCost }));
    expect(family.familyDailySpend).toEqual({ existing: limits(2), workers: familyCost });

    const assetCost = limits(20);
    const asset = updateScope(family, "day", { key: "asset:workers:resource:worker-a", kind: "asset", legacyKey: "workers:resource:worker-a" }, scope => ({ ...scope, cost: assetCost }));
    expect(asset.assetDailySpend).toEqual({ "workers:resource:existing": limits(3), "workers:resource:worker-a": assetCost });
  });

  it("updates cycle scopes without changing legacy maps or unrelated scopes", () => {
    const current = policy();
    const original = structuredClone(current);
    const next = updateScope(current, "cycle", { key: "family:workers", kind: "family", family: "workers" }, scope => ({ ...scope, cost: limits(30), enabled: false }));
    expect(next.limits?.cycle["family:workers"]).toEqual({ cost: limits(30), usage: {}, enabled: false });
    expect(next.limits?.day.untouched).toEqual(original.limits?.day.untouched);
    expect(next.limits?.cycle.untouched).toEqual(original.limits?.cycle.untouched);
    expect(next.accountDailySpend).toEqual(original.accountDailySpend);
    expect(next.familyDailySpend).toEqual(original.familyDailySpend);
    expect(next.assetDailySpend).toEqual(original.assetDailySpend);
    expect(current).toEqual(original);
  });
});
