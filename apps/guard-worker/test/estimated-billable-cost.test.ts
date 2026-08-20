import { describe, expect, it } from "vitest";
import { estimatedBillableCostSeries, type EstimatedBillableUsagePoint } from "../src/estimated-billable-cost";

const CYCLE = { startsAt: Date.UTC(2026, 7, 1), endsAt: Date.UTC(2026, 8, 1) };
const REQUESTS = { metricId: "workers:requests", includedPerCycle: 10_000_000, unit: "requests" };
const CPU = { metricId: "workers:cpu_ms", includedPerCycle: 30_000_000, unit: "milliseconds" };

function point(day: string, metrics: Record<string, number>): EstimatedBillableUsagePoint {
  return { day, metrics };
}

describe("estimated billable cost series", () => {
  it("charges only the usage that crosses each metric's included threshold", () => {
    const series = estimatedBillableCostSeries([
      point("2026-08-01", { "workers:requests": 9_000_000, "workers:cpu_ms": 29_000_000 }),
      point("2026-08-02", { "workers:requests": 2_000_000, "workers:cpu_ms": 2_000_000 }),
      point("2026-08-03", { "workers:requests": 1_000_000, "workers:cpu_ms": 29_000_000 }),
    ], [CYCLE], [REQUESTS, CPU], "paid");

    expect(series.map(item => item.day)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(series.map(item => item.costUsd)).toEqual([0, 0.32, expect.closeTo(0.88, 10)]);
  });

  it("resets the included quantity for every billing cycle", () => {
    const nextCycle = { startsAt: Date.UTC(2026, 8, 1), endsAt: Date.UTC(2026, 9, 1) };
    const series = estimatedBillableCostSeries([
      point("2026-08-30", { "workers:requests": 12_000_000 }),
      point("2026-09-01", { "workers:requests": 3_000_000 }),
      point("2026-09-02", { "workers:requests": 8_000_000 }),
    ], [CYCLE, nextCycle], [REQUESTS], "unknown");

    expect(series.map(item => item.costUsd)).toEqual([0.6, 0, 0.3]);
  });

  it("prices the sum metrics emitted by the Durable Objects collector", () => {
    const metrics = {
      "durable_objects:requests": 2,
      "durable_objects:duration_gb_seconds": 3,
      "durable_objects:incoming_websocket_messages": 4,
      "durable_objects:rows_read": 5,
      "durable_objects:rows_written": 6,
      "durable_objects:kv_read_units": 7,
      "durable_objects:kv_write_units": 8,
      "durable_objects:kv_delete_requests": 9,
    };
    const allotments = Object.keys(metrics).map(metricId => ({ metricId, includedPerCycle: 0, unit: "count" }));
    const series = estimatedBillableCostSeries([point("2026-08-01", metrics)], [CYCLE], allotments, "paid");

    const expected = 2 * (0.15 / 1_000_000)
      + 3 * (12.50 / 1_000_000)
      + 4 * ((0.15 / 1_000_000) / 20)
      + 5 * (0.001 / 1_000_000)
      + 6 * (1 / 1_000_000)
      + 7 * (0.20 / 1_000_000)
      + 8 * (1 / 1_000_000)
      + 9 * (1 / 1_000_000);
    expect(series[0]?.costUsd).toBeCloseTo(expected, 15);
  });

  it("sorts the returned daily points without mutating the input", () => {
    const input = [
      point("2026-08-02", { "workers:requests": 12_000_000 }),
      point("2026-08-01", { "workers:requests": 1_000_000 }),
    ];

    const series = estimatedBillableCostSeries(input, [CYCLE], [REQUESTS], "paid");

    expect(input.map(item => item.day)).toEqual(["2026-08-02", "2026-08-01"]);
    expect(series[0]).toEqual({ day: "2026-08-01", costUsd: 0 });
    expect(series[1]?.day).toBe("2026-08-02");
    expect(series[1]?.costUsd).toBeCloseTo(0.9, 10);
  });

  it.each(["free", "enterprise"] as const)("returns no series for the %s tier", planTier => {
    expect(estimatedBillableCostSeries([
      point("2026-08-01", { "workers:requests": 20_000_000 }),
    ], [CYCLE], [REQUESTS], planTier)).toEqual([]);
  });

  it("ignores metrics without both a catalog allotment and a known gross rate", () => {
    const series = estimatedBillableCostSeries([
      point("2026-08-01", {
        "workers:requests": 20_000_000,
        "queues:operations": 2_000_000,
        "workers:cache_requests": 2_000_000,
      }),
    ], [CYCLE], [REQUESTS, { metricId: "queues:operations", includedPerCycle: 1_000_000, unit: "count" }], "paid");

    expect(series).toEqual([{ day: "2026-08-01", costUsd: 3 }]);
  });
});
