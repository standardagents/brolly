import { describe, expect, it } from "vitest";
import {
  RISK_PRESETS,
  changeToleranceValue,
  normalizeRiskTolerance,
  percentile95,
  tolerancePresetValues,
  typicalDay,
} from "../src/client/onboarding/risk-tolerance";
import { completeWithDefaults, toleranceDefaults } from "../src/client/components/limits-chart/defaults";
import { preparePolicy } from "../src/client/onboarding/model";

describe("risk tolerance presets", () => {
  for (const preset of ["conservative", "balanced", "growth"] as const) {
    for (const count of [1, 3, 8]) {
      it(`${preset} produces ${count} ordered level values inside its bounds`, () => {
        const order = Array.from({ length: count }, (_, index) => `level-${index}`);
        const values = tolerancePresetValues(preset, order);
        const list = order.map(id => values[id]!);
        expect(list).toHaveLength(count);
        expect(list.every((value, index) => index === 0 || value > list[index - 1]!)).toBe(true);
        expect(list.every(value => value >= RISK_PRESETS[preset].low && value <= RISK_PRESETS[preset].high)).toBe(true);
      });
    }
  }

  it("places three balanced levels near 150, 350, and 800 percent", () => {
    expect(tolerancePresetValues("balanced", ["warn", "critical", "emergency"]))
      .toEqual({ warn: 150, critical: 350, emergency: 800 });
  });

  it("treats a missing policy value as balanced", () => {
    const value = normalizeRiskTolerance(undefined, ["warn", "critical", "emergency"], 1234);
    expect(value).toEqual({
      preset: "balanced",
      percentOfTypical: { warn: 150, critical: 350, emergency: 800 },
      baseline: { computedAt: 1234, windowDays: 90 },
    });
  });

  it("records a current baseline time for the unsaved default policy", () => {
    const value = normalizeRiskTolerance({
      preset: "balanced",
      percentOfTypical: { warn: 150, critical: 350, emergency: 800 },
      baseline: { computedAt: 0, windowDays: 90 },
    }, ["warn", "critical", "emergency"], 1234);
    expect(value.baseline).toEqual({ computedAt: 1234, windowDays: 90 });
  });

  it("leaves first-run daily cost maps empty for tolerance seeding", () => {
    const prepared = preparePolicy({
      version: "new",
      accountDailySpend: { warning: 5, critical: 12.5, emergency: 25 },
      familyDailySpend: { workers: { warning: 1, critical: 5, emergency: 10 } },
      assetDailySpend: {},
      thresholds: [],
    }, ["workers"], [], undefined, false);
    expect(prepared.limits?.day.account?.cost).toEqual({});
    expect(prepared.limits?.day["family:workers"]?.cost).toEqual({});
  });

  it("extends an existing preset when the alert-level board changes", () => {
    const value = normalizeRiskTolerance({
      preset: "growth",
      percentOfTypical: { warn: 250, emergency: 3000 },
      baseline: { computedAt: 1, windowDays: 90 },
    }, ["warn", "critical", "emergency"]);
    expect(value.preset).toBe("growth");
    expect(value.percentOfTypical.warn).toBe(250);
    expect(value.percentOfTypical.critical).toBeGreaterThan(value.percentOfTypical.warn!);
    expect(value.percentOfTypical.emergency).toBe(3000);
  });

  it("pushes neighbors when one level changes", () => {
    const order = ["warn", "critical", "emergency"];
    const next = changeToleranceValue({ warn: 150, critical: 350, emergency: 800 }, order, "warn", 790);
    expect(next.warn).toBe(790);
    expect(next.critical).toBeGreaterThan(next.warn!);
    expect(next.emergency).toBeGreaterThan(next.critical!);
  });
});

describe("risk tolerance baseline", () => {
  const series = [
    { day: "2026-08-14", value: 10 },
    { day: "2026-08-15", value: 12 },
    { day: "2026-08-16", value: 0 },
    { day: "2026-08-17", value: 11 },
    { day: "2026-08-18", value: 1_000 },
  ];

  it("uses the median of nonzero days, so one spike does not move typical", () => {
    expect(typicalDay(series, "2026-08-18", 90)).toBe(11.5);
  });

  it("keeps p95 as a separate busiest-normal-day readout", () => {
    expect(percentile95(series, "2026-08-18", 90)).toBe(1_000);
  });

  it("excludes future points from the baseline readouts", () => {
    const values = [...series, { day: "2026-08-19", value: 100_000 }];
    expect(typicalDay(values, "2026-08-18", 90)).toBe(11.5);
    expect(percentile95(values, "2026-08-18", 90)).toBe(1_000);
  });

  it("seeds chart defaults from the median instead of a spike", () => {
    const values = toleranceDefaults(series, undefined, "2026-08-18", ["warn", "critical", "emergency"], { warn: 150, critical: 350, emergency: 800 }, "day");
    expect(values.warn).toBeLessThan(30);
    expect(values.critical).toBeGreaterThan(values.warn!);
    expect(values.emergency).toBeGreaterThan(values.critical!);
  });

  it("uses the median of complete billing cycles", () => {
    const cycles = [
      { startsAt: Date.UTC(2026, 0, 1), endsAt: Date.UTC(2026, 0, 4) },
      { startsAt: Date.UTC(2026, 0, 4), endsAt: Date.UTC(2026, 0, 7) },
      { startsAt: Date.UTC(2026, 0, 7), endsAt: Date.UTC(2026, 0, 12) },
    ];
    const values = toleranceDefaults([
      { day: "2026-01-01", value: 2 }, { day: "2026-01-02", value: 2 }, { day: "2026-01-03", value: 2 },
      { day: "2026-01-04", value: 4 }, { day: "2026-01-05", value: 4 }, { day: "2026-01-06", value: 4 },
      { day: "2026-01-07", value: 1000 },
    ], cycles, "2026-01-08", ["warn"], { warn: 100 }, "cycle");
    expect(values.warn).toBe(9);
  });

  it("excludes a completed cycle with an interior coverage gap", () => {
    const cycles = [
      { startsAt: Date.UTC(2026, 0, 1), endsAt: Date.UTC(2026, 0, 4) },
      { startsAt: Date.UTC(2026, 0, 4), endsAt: Date.UTC(2026, 0, 7) },
      { startsAt: Date.UTC(2026, 0, 7), endsAt: Date.UTC(2026, 0, 12) },
    ];
    const values = toleranceDefaults([
      { day: "2026-01-01", value: 2 }, { day: "2026-01-02", value: 2 }, { day: "2026-01-03", value: 2 },
      { day: "2026-01-04", value: 1_000 }, { day: "2026-01-06", value: 1_000 },
      { day: "2026-01-07", value: 2 },
    ], cycles, "2026-01-08", ["warn"], { warn: 100 }, "cycle");
    expect(values.warn).toBeLessThan(100);
  });

  it("falls back to daily typical multiplied by current cycle days", () => {
    const cycles = [
      { startsAt: Date.UTC(2026, 0, 1), endsAt: Date.UTC(2026, 0, 4) },
      { startsAt: Date.UTC(2026, 0, 4), endsAt: Date.UTC(2026, 0, 9) },
    ];
    const values = toleranceDefaults([
      { day: "2026-01-01", value: 10 }, { day: "2026-01-02", value: 10 }, { day: "2026-01-03", value: 10 },
      { day: "2026-01-04", value: 10 },
    ], cycles, "2026-01-05", ["warn"], { warn: 150 }, "cycle");
    expect(values.warn).toBe(76);
  });

  it("uses tolerance only for missing values and keeps the cycle seed as a default lower bound", () => {
    const saved = { warn: 40, critical: 80, emergency: 120 };
    expect(completeWithDefaults([10], 10, Object.keys(saved), saved, undefined, undefined, { warn: 15, critical: 35, emergency: 80 })).toBe(saved);
    const defaults = completeWithDefaults([10], 10, Object.keys(saved), {}, undefined, { warn: 100, critical: 200, emergency: 300 }, { warn: 15, critical: 35, emergency: 80 });
    expect(defaults.warn).toBeGreaterThanOrEqual(100);
    expect(defaults.critical).toBeGreaterThanOrEqual(200);
    expect(defaults.emergency).toBeGreaterThanOrEqual(300);
  });
});
