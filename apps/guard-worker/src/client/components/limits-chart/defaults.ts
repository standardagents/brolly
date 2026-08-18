import { type CycleBounds, type DayPoint, cycleCumulative, denseSeries, monthlyCycles, projectCycle, visibleWindow } from "./cycles";
import { type LevelValues, completeLevels, pushLevels } from "./levels";
import { chooseAxis, niceLadder } from "./scale";

/**
 * Everything the chart derives from a raw series: the visible window, the
 * dense day list, running totals, and the projection. Shared by the chart
 * and by the row list so unexpanded rows can show the same defaults.
 */
export function deriveSeries(series: DayPoint[], cyclesProp: CycleBounds[] | undefined, todayProp?: string) {
  const today = todayProp ?? series.at(-1)?.day ?? new Date().toISOString().slice(0, 10);
  const cycles = cyclesProp?.length ? cyclesProp : monthlyCycles(series[0]?.day ?? today, today);
  const window = visibleWindow(series, cycles, today);
  const dense = denseSeries(series, window.fromDay, window.toDay);
  const cumulative = cycleCumulative(dense, cycles);
  const projection = projectCycle(dense, cycles, today);
  const observedMax = Math.max(0, ...dense.map(point => point.value));
  const heightValues = [...dense.map(point => point.value), ...cumulative.map(point => point.cumulative), projection?.projected ?? 0];
  return { today, cycles, window, dense, cumulative, projection, observedMax, heightValues };
}

/**
 * Fill missing level values with computed defaults. The defaults are pushed
 * on an axis that already contains the default ladder, so a ladder above
 * today's data is not clamped to the top of the chart.
 */
export function completeWithDefaults(heightValues: number[], observedMax: number, order: readonly string[], value: LevelValues, floor?: LevelValues, seed?: LevelValues): LevelValues {
  const ladder = niceLadder(observedMax, order.length);
  const axis = chooseAxis(heightValues, [...order.map(id => value[id] ?? 0), ...ladder, ...Object.values(floor ?? {}), ...Object.values(seed ?? {})]);
  const filled = completeLevels(axis, order, value, observedMax, floor, seed);
  // Values that arrive out of order (an outside edit) are pushed back into
  // order, lowest level first, so switched-off levels also stay consistent.
  let ordered = filled;
  for (const id of order) ordered = pushLevels(axis, order, ordered, id, ordered[id]!, floor);
  return order.every(id => ordered[id] === filled[id]) ? filled : ordered;
}

/** Defaults for a series that has no chart mounted yet (collapsed rows). */
export function defaultLevelValues(series: DayPoint[], cycles: CycleBounds[] | undefined, today: string | undefined, order: readonly string[], value: LevelValues, floor?: LevelValues, seed?: LevelValues): LevelValues {
  const derived = deriveSeries(series, cycles, today);
  return completeWithDefaults(derived.heightValues, derived.observedMax, order, value, floor, seed);
}

/** Set one level on a series with no chart mounted, pushing neighbors like a drag would. */
export function pushLevelValue(series: DayPoint[], cycles: CycleBounds[] | undefined, today: string | undefined, order: readonly string[], values: LevelValues, levelId: string, next: number, floor?: LevelValues): LevelValues {
  const derived = deriveSeries(series, cycles, today);
  const axis = chooseAxis(derived.heightValues, [...order.map(id => values[id] ?? 0), next, ...Object.values(floor ?? {})]);
  return pushLevels(axis, order, values, levelId, next, floor);
}
