import { DEFAULT_POLICY, type Policy } from "@standardagents/brolly-core";
import { describe, expect, it } from "vitest";
import { validPolicy } from "../src/index";

const LEVELS = ["warning", "critical", "emergency"];

function policy(): Policy {
  return {
    ...structuredClone(DEFAULT_POLICY),
    riskTolerance: {
      preset: "balanced",
      percentOfTypical: { warning: 125, critical: 320, emergency: 800 },
      baseline: { computedAt: 1, windowDays: 90 },
    },
  };
}

describe("risk tolerance policy validation", () => {
  it("accepts the balanced default and older policies without risk tolerance", () => {
    expect(validPolicy(policy(), false, LEVELS)).toBe(true);
    const existing = policy();
    delete existing.riskTolerance;
    expect(validPolicy(existing, false, LEVELS)).toBe(true);
  });

  it("rejects percentages outside 100 through 100,000", () => {
    const below = policy();
    below.riskTolerance!.percentOfTypical.warning = 99;
    expect(validPolicy(below, false, LEVELS)).toBe(false);

    const above = policy();
    above.riskTolerance!.percentOfTypical.emergency = 100_001;
    expect(validPolicy(above, false, LEVELS)).toBe(false);
  });

  it("rejects percentages that do not ascend in board order", () => {
    const value = policy();
    value.riskTolerance!.percentOfTypical = { warning: 150, critical: 900, emergency: 800 };
    expect(validPolicy(value, false, LEVELS)).toBe(false);

    value.riskTolerance!.percentOfTypical = { warning: 150, critical: 150, emergency: 800 };
    expect(validPolicy(value, false, LEVELS)).toBe(false);
  });

  it("rejects unknown preset names", () => {
    const value = policy();
    value.riskTolerance!.preset = "reckless" as "balanced";
    expect(validPolicy(value, false, LEVELS)).toBe(false);
  });

  it("validates saved cost and usage maps in both limit windows", () => {
    const value = policy();
    value.limits = {
      day: { account: { cost: { warning: 5, critical: 10, emergency: 20 }, usage: { requests: { warning: 100, critical: 200, emergency: 500 } } } },
      cycle: { account: { cost: {}, usage: {} } },
    };
    expect(validPolicy(value, false, LEVELS)).toBe(true);
    value.limits.day.account!.usage.requests = { warning: 100, critical: 90, emergency: 500 };
    expect(validPolicy(value, false, LEVELS)).toBe(false);
  });
});
