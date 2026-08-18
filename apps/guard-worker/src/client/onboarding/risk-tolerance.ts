import type { Axis } from "../components/limits-chart/scale";
import { snapToNice } from "../components/limits-chart/scale";
import { pushLevels, type LevelValues } from "../components/limits-chart/levels";
import type { RiskTolerance, RiskTolerancePreset } from "../types";

export const RISK_TOLERANCE_WINDOW_DAYS = 90;
export const MIN_TOLERANCE_PERCENT = 100;
export const MAX_TOLERANCE_PERCENT = 100_000;
export const TOLERANCE_AXIS_MAX = 10_000;

export const RISK_PRESETS: Record<Exclude<RiskTolerancePreset, "custom">, { low: number; high: number }> = {
  conservative: { low: 110, high: 300 },
  balanced: { low: 125, high: 800 },
  growth: { low: 150, high: 3_000 },
};

/** Fixed geometric preset curve, snapped and pushed with the chart's gap rule. */
export function tolerancePresetValues(preset: Exclude<RiskTolerancePreset, "custom">, order: readonly string[]): LevelValues {
  const curve = RISK_PRESETS[preset];
  const last = Math.max(0, order.length - 1);
  let values: LevelValues = Object.fromEntries(order.map((id, index) => {
    const t = last === 0 ? 1 : index / last;
    return [id, snapToNice(curve.low * (curve.high / curve.low) ** t, 1)];
  }));
  const axis = toleranceAxis(Math.max(TOLERANCE_AXIS_MAX, ...Object.values(values)));
  const floor = Object.fromEntries(order.map(id => [id, MIN_TOLERANCE_PERCENT]));
  for (const id of order) values = pushLevels(axis, order, values, id, values[id]!, floor);
  return values;
}

/** Existing policies without risk tolerance use the balanced curve. */
export function normalizeRiskTolerance(value: RiskTolerance | undefined, order: readonly string[], now = Date.now()): RiskTolerance {
  const selectedPreset = value?.preset && value.preset !== "custom" ? value.preset : "balanced";
  const fallback = tolerancePresetValues(selectedPreset, order);
  const present = value?.percentOfTypical ?? {};
  let percentOfTypical: LevelValues = Object.fromEntries(order.map(id => [id,
    Number.isFinite(present[id]) && present[id]! >= MIN_TOLERANCE_PERCENT ? present[id]! : fallback[id]!,
  ]));
  for (const id of order) percentOfTypical = changeToleranceValue(percentOfTypical, order, id, percentOfTypical[id]!);
  return {
    preset: value?.preset ?? "balanced",
    percentOfTypical,
    baseline: value?.baseline && value.baseline.computedAt > 0 && value.baseline.windowDays > 0
      ? value.baseline
      : { computedAt: now, windowDays: RISK_TOLERANCE_WINDOW_DAYS },
  };
}

/** Apply one field, pointer, or keyboard change and push adjacent levels. */
export function changeToleranceValue(values: LevelValues, order: readonly string[], changedId: string, next: number): LevelValues {
  const clamped = Math.min(MAX_TOLERANCE_PERCENT, Math.max(MIN_TOLERANCE_PERCENT, next));
  const floor = Object.fromEntries(order.map(id => [id, MIN_TOLERANCE_PERCENT]));
  const axis = toleranceAxis(Math.max(TOLERANCE_AXIS_MAX, clamped, ...Object.values(values)));
  let result = pushLevels(axis, order, values, changedId, clamped, floor);
  const highest = order.at(-1);
  if (highest && result[highest]! > MAX_TOLERANCE_PERCENT) {
    result = pushLevels(axis, order, result, highest, MAX_TOLERANCE_PERCENT, floor);
  }
  return result;
}

/** Logarithmic percent axis. Position zero corresponds to 100 percent. */
export function toleranceAxis(top = TOLERANCE_AXIS_MAX): Axis {
  const max = Math.max(TOLERANCE_AXIS_MAX, top);
  const span = Math.log10(max / MIN_TOLERANCE_PERCENT);
  const position = (value: number) => Math.min(1, Math.max(0, Math.log10(Math.max(MIN_TOLERANCE_PERCENT, value) / MIN_TOLERANCE_PERCENT) / span));
  const invert = (fraction: number) => MIN_TOLERANCE_PERCENT * 10 ** (Math.min(1, Math.max(0, fraction)) * span);
  const ticks = [100, 200, 500, 1_000, 2_000, 5_000, 10_000].filter(value => value <= max);
  if (ticks.at(-1) !== max) ticks.push(max);
  return { kind: "symlog", max, knee: MIN_TOLERANCE_PERCENT, ticks, position, invert };
}

/** Median of nonzero days inside the requested historical window. */
export function typicalDay(values: Array<{ day: string; value: number }>, today: string, windowDays: number): number {
  const todayAt = Date.parse(`${today}T00:00:00Z`);
  const cutoff = todayAt - Math.max(0, windowDays - 1) * 86_400_000;
  return median(values
    .filter(point => {
      const at = Date.parse(`${point.day}T00:00:00Z`);
      return at >= cutoff && at <= todayAt && point.value > 0 && Number.isFinite(point.value);
    })
    .map(point => point.value));
}

export function percentile95(values: Array<{ day: string; value: number }>, today: string, windowDays: number): number {
  const todayAt = Date.parse(`${today}T00:00:00Z`);
  const cutoff = todayAt - Math.max(0, windowDays - 1) * 86_400_000;
  const sorted = values
    .filter(point => {
      const at = Date.parse(`${point.day}T00:00:00Z`);
      return at >= cutoff && at <= todayAt && point.value > 0 && Number.isFinite(point.value);
    })
    .map(point => point.value)
    .sort((left, right) => left - right);
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
