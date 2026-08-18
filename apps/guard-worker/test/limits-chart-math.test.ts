import { describe, expect, it } from "vitest";
import { chooseAxis, niceCeil, niceFloor, niceLadder, snapToNice, snapUpToNice } from "../src/client/components/limits-chart/scale";
import { GAP_FRACTION, completeLevels, crossedLevel, defaultLevels, minGapAbove, pushLevels } from "../src/client/components/limits-chart/levels";
import { cycleCumulative, denseSeries, monthlyCycles, projectCycle, visibleWindow } from "../src/client/components/limits-chart/cycles";

const ORDER = ["warn", "critical", "emergency"];

describe("axis selection", () => {
  it("stays linear for a flat series", () => {
    const axis = chooseAxis([4, 5, 6, 5, 4, 5, 6]);
    expect(axis.kind).toBe("linear");
    expect(axis.max).toBeGreaterThanOrEqual(6);
    expect(axis.position(0)).toBe(0);
    expect(axis.position(axis.max)).toBe(1);
    expect(axis.invert(axis.position(3))).toBeCloseTo(3, 6);
  });

  it("switches to symlog when one day exceeds ten times the median and keeps the median region readable", () => {
    const series = [5, 4, 6, 5, 5, 6, 4, 5, 900];
    const axis = chooseAxis(series);
    expect(axis.kind).toBe("symlog");
    expect(axis.position(0)).toBe(0);
    expect(axis.position(5)).toBeGreaterThan(0.2);
    expect(axis.position(900)).toBeLessThanOrEqual(1);
    expect(axis.invert(axis.position(42))).toBeCloseTo(42, 6);
    expect(axis.ticks[0]).toBe(0);
    expect(axis.ticks.at(-1)).toBe(axis.max);
    expect(axis.ticks.every((tick, index) => index === 0 || tick > axis.ticks[index - 1]!)).toBe(true);
  });

  it("extends the domain to include threshold values", () => {
    const axis = chooseAxis([1, 2, 3], [40]);
    expect(axis.max).toBeGreaterThanOrEqual(40);
  });

  it("produces a finite axis for an all-zero series", () => {
    const axis = chooseAxis([0, 0, 0]);
    expect(axis.max).toBeGreaterThan(0);
    expect(Number.isFinite(axis.position(0))).toBe(true);
    expect(axis.ticks.every(Number.isFinite)).toBe(true);
  });
});

describe("nice numbers", () => {
  it("rounds to the 1/2/5 ladder", () => {
    expect(niceFloor(47)).toBe(20);
    expect(niceCeil(47)).toBe(50);
    expect(niceCeil(0.03)).toBe(0.05);
    expect(niceFloor(0)).toBe(0);
  });

  it("snaps at a step proportional to the value", () => {
    expect(snapToNice(47.3)).toBe(48);
    expect(snapToNice(473)).toBe(480);
    expect(snapUpToNice(47.3)).toBe(48);
    expect(snapUpToNice(46.01)).toBe(48);
  });

  it("builds a default ladder above the observed max", () => {
    expect(niceLadder(3, 3)).toEqual([10, 20, 50]);
    expect(niceLadder(0, 3)).toEqual([1, 5, 10]);
  });
});

describe("level pushing", () => {
  const axis = chooseAxis([1, 2, 3, 2, 1], [100]);

  it("pushes higher levels up when a lower level is dragged past them", () => {
    const next = pushLevels(axis, ORDER, { warn: 10, critical: 20, emergency: 50 }, "warn", 30);
    expect(next.warn).toBe(30);
    expect(next.critical).toBeGreaterThanOrEqual(minGapAbove(axis, 30));
    expect(next.emergency).toBeGreaterThanOrEqual(minGapAbove(axis, next.critical));
    expect(next.emergency).toBe(50);
  });

  it("pushes lower levels down when a higher level is dragged under them", () => {
    const next = pushLevels(axis, ORDER, { warn: 10, critical: 20, emergency: 50 }, "emergency", 25);
    expect(next.emergency).toBe(25);
    expect(next.critical).toBeLessThan(25);
    expect(next.warn).toBeLessThan(next.critical);
    expect(next.warn).toBeGreaterThanOrEqual(0);
  });

  it("pushes the changed line back up when the lines below cannot fit under it", () => {
    const next = pushLevels(axis, ORDER, { warn: 10, critical: 20, emergency: 50 }, "emergency", 3);
    expect(next.warn).toBe(0);
    expect(next.critical).toBeGreaterThan(next.warn);
    expect(next.emergency).toBeGreaterThan(next.critical);
  });

  it("keeps a minimum gap of a fraction of the axis between neighbors", () => {
    const next = pushLevels(axis, ORDER, { warn: 10, critical: 20, emergency: 50 }, "critical", 10);
    expect(axis.position(next.critical) - axis.position(next.warn)).toBeGreaterThanOrEqual(GAP_FRACTION - 1e-9);
    expect(axis.position(next.emergency) - axis.position(next.critical)).toBeGreaterThanOrEqual(GAP_FRACTION - 1e-9);
  });

  it("respects floors by pushing the changed line back up instead of breaking them", () => {
    const next = pushLevels(axis, ORDER, { warn: 10, critical: 20, emergency: 50 }, "emergency", 5, { warn: 8 });
    expect(next.warn).toBe(8);
    expect(next.critical).toBeGreaterThan(next.warn);
    expect(next.emergency).toBeGreaterThan(next.critical);
  });

  it("builds ordered defaults and completes partial maps without moving set values", () => {
    const defaults = defaultLevels(axis, ORDER, 3);
    expect(defaults.warn).toBeLessThan(defaults.critical);
    expect(defaults.critical).toBeLessThan(defaults.emergency);
    const completed = completeLevels(axis, ORDER, { critical: 25 }, 3);
    expect(completed.critical).toBe(25);
    expect(completed.warn).toBeLessThan(25);
    expect(completed.emergency).toBeGreaterThan(25);
  });

  it("names the highest crossed level for a bar", () => {
    const values = { warn: 10, critical: 20, emergency: 50 };
    expect(crossedLevel(ORDER, values, 5)).toBeNull();
    expect(crossedLevel(ORDER, values, 10)).toBe("warn");
    expect(crossedLevel(ORDER, values, 21)).toBe("critical");
    expect(crossedLevel(ORDER, values, 500)).toBe("emergency");
  });
});

describe("billing cycles", () => {
  const cycles = monthlyCycles("2026-06-01", "2026-08-17");
  const series = denseSeries([
    { day: "2026-06-30", value: 4 }, { day: "2026-07-01", value: 2 }, { day: "2026-07-02", value: 3 },
    { day: "2026-08-01", value: 10 }, { day: "2026-08-02", value: 10 },
  ], "2026-06-30", "2026-08-02");

  it("resets the running total at each cycle start", () => {
    const points = cycleCumulative(series, cycles);
    const byDay = Object.fromEntries(points.map(point => [point.day, point.cumulative]));
    expect(byDay["2026-06-30"]).toBe(4);
    expect(byDay["2026-07-01"]).toBe(2);
    expect(byDay["2026-07-02"]).toBe(5);
    expect(byDay["2026-08-01"]).toBe(10);
    expect(byDay["2026-08-02"]).toBe(20);
  });

  it("projects the current cycle from its daily rate", () => {
    const projection = projectCycle(series, cycles, "2026-08-02");
    expect(projection?.toDate).toBe(20);
    expect(projection?.elapsedDays).toBe(2);
    expect(projection?.totalDays).toBe(31);
    expect(projection?.projected).toBe(310);
  });

  it("windows to the current cycle plus two prior cycles, clamped to available data", () => {
    expect(visibleWindow(series, cycles, "2026-08-02")).toEqual({ fromDay: "2026-06-30", toDay: "2026-08-02" });
    const long = denseSeries([{ day: "2026-03-01", value: 1 }], "2026-03-01", "2026-08-02");
    expect(visibleWindow(long, monthlyCycles("2026-03-01", "2026-08-02"), "2026-08-02").fromDay).toBe("2026-06-01");
  });
});
