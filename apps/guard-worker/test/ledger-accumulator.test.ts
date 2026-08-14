import { describe, expect, it } from "vitest";
import type { UsageObservation } from "@standardagents/brolly-core";
import { applyAccumulatorObservations, type AccumulatorPayload } from "../src/ledger-accumulator.js";
import { aggregateDailyResource } from "../src/ledger-store.js";

function observation(value: number, end = 300_000): UsageObservation {
  return {
    collectorKey: "graphql:durable_objects",
    dataset: "durableObjectsPeriodicGroups",
    sample: {
      asset: { accountId: "account", family: "durable_objects", id: "object", scope: "object", tier: "standard" },
      metric: "rows_read", unit: "rows", value, start: end - 300_000, end, source: "graphql", estimatedCostUsd: value / 1_000_000,
    },
    quality: "complete", sampleInterval: 1, watermarkAt: end, historical: false,
  };
}

describe("usage accumulator", () => {
  it("does not double count an overlapping window and applies corrections", () => {
    const first = observation(100);
    const firstIds = new Map([[first, "resource"]]);
    const initial = applyAccumulatorObservations(null, [first], firstIds, new Map([["durable_objects:rows_read", "sum"]]), new Map());
    expect(initial.changes[0]).toMatchObject({ dayValue: 100, cycleValue: 100 });

    const duplicate = observation(100);
    const repeated = applyAccumulatorObservations(initial.payload, [duplicate], new Map([[duplicate, "resource"]]), new Map([["durable_objects:rows_read", "sum"]]), new Map());
    expect(repeated.changes[0]).toMatchObject({ dayValue: 100, cycleValue: 100 });

    const correction = observation(125);
    const corrected = applyAccumulatorObservations(repeated.payload, [correction], new Map([[correction, "resource"]]), new Map([["durable_objects:rows_read", "sum"]]), new Map());
    expect(corrected.changes[0]).toMatchObject({ dayValue: 125, cycleValue: 125 });
  });

  it("retains a bounded rolling baseline", () => {
    let payload = null;
    for (let index = 1; index <= 20; index += 1) {
      const item = observation(index, index * 300_000);
      payload = applyAccumulatorObservations(payload, [item], new Map([[item, "resource"]]), new Map([["durable_objects:rows_read", "sum"]]), new Map()).payload;
    }
    expect(payload!.resources.resource!.metrics["durable_objects:rows_read"]!.baseline).toHaveLength(12);
    expect(Object.keys(payload!.resources.resource!.windows)).toHaveLength(16);
  });

  it("combines local-day totals that cross a billing-cycle boundary", () => {
    const payload = (day: number, estimatedDayUsd: number, quality: "complete" | "partial", sampleInterval: number): AccumulatorPayload => ({
      resources: {
        resource: {
          updatedAt: 1,
          windows: {},
          metrics: {
            "durable_objects:rows_read": {
              day,
              cycle: day,
              estimatedDayUsd,
              estimatedCycleUsd: estimatedDayUsd,
              cycleSeedValue: 0,
              baseline: [],
              quality,
              sampleInterval,
              cycleQuality: quality,
              cycleSampleInterval: sampleInterval,
              cycleSeedQuality: "complete",
              cycleSeedSampleInterval: 1,
              watermarkAt: 1,
            },
          },
        },
      },
    });

    expect(aggregateDailyResource([
      payload(40, 0.4, "complete", 1),
      payload(60, 0.6, "partial", 2),
    ], "resource")).toEqual({
      metrics: { "durable_objects:rows_read": 100 },
      estimatedByMetric: { "durable_objects:rows_read": 1 },
      estimatedCostUsd: 1,
      quality: "partial",
      qualityByMetric: { "durable_objects:rows_read": "partial" },
      sampling: { "durable_objects:rows_read": 2 },
    });
  });

  it("retains incomplete quality after old scan windows are compacted", () => {
    let payload: AccumulatorPayload | null = null;
    for (let index = 1; index <= 20; index += 1) {
      const item = { ...observation(index, index * 300_000), quality: index === 1 ? "partial" as const : "complete" as const };
      payload = applyAccumulatorObservations(payload, [item], new Map([[item, "resource"]]), new Map([["durable_objects:rows_read", "sum"]]), new Map()).payload;
    }
    expect(payload!.resources.resource!.metrics["durable_objects:rows_read"]!.quality).toBe("partial");
  });

  it("keeps cycle quality distinct from the current local day", () => {
    const item = observation(10);
    const result = applyAccumulatorObservations(null, [item], new Map([[item, "resource"]]), new Map([["durable_objects:rows_read", "sum"]]), new Map([
      ["resource", { "durable_objects:rows_read": { value: 5, estimatedCostUsd: 0, quality: "partial", sampleInterval: 2 } }],
    ]));
    expect(result.changes[0]).toMatchObject({ quality: "complete", sampleInterval: 1, cycleQuality: "partial", cycleSampleInterval: 2 });
  });

  it("retains maximum gauges while summing their interval cost", () => {
    const first = observation(100);
    const second = observation(80, 600_000);
    const result = applyAccumulatorObservations(
      null,
      [first, second],
      new Map([[first, "resource"], [second, "resource"]]),
      new Map([["durable_objects:rows_read", "maximum"]]),
      new Map(),
    );
    expect(result.changes[0]).toMatchObject({ dayValue: 100, cycleValue: 100, estimatedDayUsd: 0.00018 });
  });
});
