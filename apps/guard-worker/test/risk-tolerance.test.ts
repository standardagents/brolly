import { describe, expect, it } from "vitest";
import {
  RISK_PRESETS,
  changeToleranceValue,
  normalizeRiskTolerance,
  percentile95,
  tolerancePresetValues,
  typicalDay,
} from "../src/client/onboarding/risk-tolerance";
import { completeWithDefaults, cycleBaseline, cycleDaysFor, dailyToleranceDefaults, typicalCycleUsage, toleranceDefaults, windowDefaults } from "../src/client/components/limits-chart/defaults";
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
        const anchors = RISK_PRESETS[preset];
        // The minimum-gap push can nudge the top of a dense ladder slightly past the last anchor.
        expect(list.every(value => value >= anchors[0]! && value <= anchors[anchors.length - 1]! * 1.2)).toBe(true);
      });
    }
  }

  it("places three balanced levels at 90, 200, and 300 percent", () => {
    expect(tolerancePresetValues("balanced", ["warn", "critical", "emergency"]))
      .toEqual({ warn: 90, critical: 200, emergency: 300 });
  });

  it("treats a missing policy value as balanced", () => {
    const value = normalizeRiskTolerance(undefined, ["warn", "critical", "emergency"], 1234);
    expect(value).toEqual({
      preset: "balanced",
      percentOfTypical: { warn: 90, critical: 200, emergency: 300 },
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

  it("moves legacy account usage into family scopes while family values win", () => {
    const prepared = preparePolicy({
      version: "legacy-usage",
      accountDailySpend: { warning: 5, critical: 12.5, emergency: 25 },
      familyDailySpend: {},
      assetDailySpend: {},
      limits: {
        day: {
          account: {
            cost: { warning: 7 },
            usage: {
              "workers:requests": { warning: 100 },
              "durable_objects:requests": { warning: 200 },
            },
            usageEnabled: { "workers:requests": false, "durable_objects:requests": true },
            usageLevelEnabled: { "workers:requests": { warning: false } },
          },
          "family:workers": {
            cost: {},
            usage: { "workers:requests": { warning: 900 } },
            usageEnabled: { "workers:requests": true },
          },
        },
        cycle: {
          account: {
            cost: {},
            usage: { "durable_objects:requests": { warning: 2_000 } },
          },
        },
      },
      thresholds: [],
    }, ["workers", "durable_objects"], [], undefined, false);

    expect(prepared.limits?.day.account?.usage).toEqual({});
    expect(prepared.limits?.day.account?.usageEnabled).toEqual({});
    expect(prepared.limits?.day["family:workers"]?.usage["workers:requests"]).toEqual({ warning: 900 });
    expect(prepared.limits?.day["family:workers"]?.usageEnabled?.["workers:requests"]).toBe(true);
    expect(prepared.limits?.day["family:workers"]?.usageLevelEnabled?.["workers:requests"]).toEqual({ warning: false });
    expect(prepared.limits?.day["family:durable_objects"]?.usage["durable_objects:requests"]).toEqual({ warning: 200 });
    expect(prepared.limits?.day["family:durable_objects"]?.usageEnabled?.["durable_objects:requests"]).toBe(true);
    expect(prepared.limits?.cycle.account?.usage).toEqual({});
    expect(prepared.limits?.cycle["family:durable_objects"]?.usage["durable_objects:requests"]).toEqual({ warning: 2_000 });
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
    const values = toleranceDefaults(series, "2026-08-18", ["warn", "critical", "emergency"], { warn: 150, critical: 350, emergency: 800 });
    expect(values.warn).toBeLessThan(30);
    expect(values.critical).toBeGreaterThan(values.warn!);
    expect(values.emergency).toBeGreaterThan(values.critical!);
  });

  it("derives cycle defaults from the tolerance daily default times the current cycle length", () => {
    const cycles = [
      { startsAt: Date.UTC(2026, 0, 1), endsAt: Date.UTC(2026, 0, 4) },
      { startsAt: Date.UTC(2026, 0, 4), endsAt: Date.UTC(2026, 0, 7) },
      { startsAt: Date.UTC(2026, 0, 7), endsAt: Date.UTC(2026, 0, 12) },
    ];
    const history = [
      { day: "2026-01-01", value: 2 }, { day: "2026-01-02", value: 2 }, { day: "2026-01-03", value: 2 },
      { day: "2026-01-04", value: 4 }, { day: "2026-01-05", value: 4 }, { day: "2026-01-06", value: 4 },
      { day: "2026-01-07", value: 1000 },
    ];
    expect(cycleDaysFor(cycles, "2026-01-08")).toBe(5);
    // Daily median is 4; the current cycle spans 5 days. A hand-edited daily
    // map never moves the cycle default while a tolerance is known.
    expect(windowDefaults(history, cycles, "2026-01-08", ["warn"], "cycle", { warn: 100 }, { warn: 9 })).toEqual({ warn: 20 });
    // Without a tolerance the daily map is the fallback basis.
    expect(windowDefaults(history, cycles, "2026-01-08", ["warn"], "cycle", undefined, { warn: 4 })).toEqual({ warn: 20 });
    // No basis at all, no cycle default.
    expect(windowDefaults(history, cycles, "2026-01-08", ["warn", "critical"], "cycle", undefined, { warn: 4 })).toBeUndefined();
    // Day defaults need tolerance.
    expect(windowDefaults(history, cycles, "2026-01-08", ["warn"], "day", undefined, undefined)).toBeUndefined();
    expect(windowDefaults(history, cycles, "2026-01-08", ["warn"], "day", { warn: 100 }, undefined)).toEqual({ warn: 4 });
  });

  it("uses tolerance only for missing values and keeps the cycle seed as a default lower bound", () => {
    const saved = { warn: 40, critical: 80, emergency: 120 };
    expect(completeWithDefaults([10], 10, Object.keys(saved), saved, undefined, undefined, { warn: 15, critical: 35, emergency: 80 })).toBe(saved);
    const defaults = completeWithDefaults([10], 10, Object.keys(saved), {}, undefined, { warn: 100, critical: 200, emergency: 300 }, { warn: 15, critical: 35, emergency: 80 });
    expect(defaults.warn).toBeGreaterThanOrEqual(100);
    expect(defaults.critical).toBeGreaterThanOrEqual(200);
    expect(defaults.emergency).toBeGreaterThanOrEqual(300);
  });

  it("anchors both windows to the allotment while typical usage stays inside the free tier", () => {
    const cycles = [{ startsAt: Date.UTC(2026, 0, 1), endsAt: Date.UTC(2026, 1, 1) }];
    const series = [{ day: "2026-01-17", value: 10 }, { day: "2026-01-18", value: 10 }];
    const order = ["warn", "critical", "emergency"];
    const tolerance = { warn: 90, critical: 200, emergency: 300 };
    // Typical cycle usage is 10 × 31 = 310, below the 3,100 allotment.
    expect(cycleBaseline(series, cycles, "2026-01-18", 3_100)).toBe(3_100);
    expect(windowDefaults(series, cycles, "2026-01-18", order, "cycle", tolerance, undefined, 3_100)).toEqual({ warn: 2_800, critical: 6_200, emergency: 9_400 });
    // Daily: the 3,100 baseline over 31 days is 100 a day.
    expect(dailyToleranceDefaults(series, cycles, "2026-01-18", order, tolerance, 3_100)).toEqual({ warn: 90, critical: 200, emergency: 300 });
  });

  it("keeps typical usage as the baseline when the meter is consistently billable", () => {
    const cycles = [{ startsAt: Date.UTC(2026, 0, 1), endsAt: Date.UTC(2026, 1, 1) }];
    const series = [{ day: "2026-01-17", value: 200 }, { day: "2026-01-18", value: 200 }];
    // Typical cycle usage is 200 × 31 = 6,200, above the 1,000 allotment.
    expect(cycleBaseline(series, cycles, "2026-01-18", 1_000)).toBe(6_200);
    const values = windowDefaults(series, cycles, "2026-01-18", ["warn", "critical"], "cycle", { warn: 90, critical: 200 }, undefined, 1_000)!;
    expect(values.warn).toBeLessThan(6_200);
    expect(values.critical).toBeGreaterThanOrEqual(12_000);
  });

  it("ignores a runaway fortnight when judging typical usage", () => {
    const cycles = [
      { startsAt: Date.UTC(2026, 0, 1), endsAt: Date.UTC(2026, 1, 1) },
      { startsAt: Date.UTC(2026, 1, 1), endsAt: Date.UTC(2026, 2, 1) },
    ];
    const series = [
      ...Array.from({ length: 14 }, (_, index) => ({ day: `2026-01-${String(index + 1).padStart(2, "0")}`, value: 1_000_000 })),
      ...Array.from({ length: 17 }, (_, index) => ({ day: `2026-01-${String(index + 15).padStart(2, "0")}`, value: 10 })),
      ...Array.from({ length: 10 }, (_, index) => ({ day: `2026-02-${String(index + 1).padStart(2, "0")}`, value: 10 })),
    ];
    // 27 normal days outvote 14 incident days: the median day is 10.
    expect(typicalCycleUsage(series, cycles, "2026-02-10")).toBe(280);
    expect(cycleBaseline(series, cycles, "2026-02-10", 25_000)).toBe(25_000);
  });

  it("uses maximum storage within a cycle for allotment defaults", () => {
    const cycles = [{ startsAt: Date.UTC(2026, 0, 1), endsAt: Date.UTC(2026, 1, 1) }];
    const storage = [{ day: "2026-01-17", value: 60 }, { day: "2026-01-18", value: 60 }];
    expect(typicalCycleUsage(storage, cycles, "2026-01-18", "maximum")).toBe(60);
    expect(windowDefaults(storage, cycles, "2026-01-18", ["warn", "critical"], "cycle", { warn: 90, critical: 200 }, undefined, 100, "maximum")).toEqual({ warn: 90, critical: 200 });
    expect(windowDefaults(storage, cycles, "2026-01-18", ["warn"], undefined, undefined, { warn: 4 }, undefined, "maximum")).toEqual({ warn: 4 });
  });
});
