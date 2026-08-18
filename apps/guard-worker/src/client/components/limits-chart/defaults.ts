import { DAY_MS, type CycleBounds, type DayPoint, cycleCumulative, cycleIndexFor, dayStart, daysBetween, denseSeries, monthlyCycles, projectCycle, visibleWindow } from "./cycles";
import { type LevelValues, completeLevels, pushLevels } from "./levels";
import { chooseAxis, median, niceLadder, snapToNice } from "./scale";

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
export function completeWithDefaults(heightValues: number[], observedMax: number, order: readonly string[], value: LevelValues, floor?: LevelValues, seed?: LevelValues, tolerance?: LevelValues): LevelValues {
  const ladder = niceLadder(observedMax, order.length);
  const preferred = Object.fromEntries(order.map(id => [id, Math.max(tolerance?.[id] ?? 0, seed?.[id] ?? 0)]));
  const axis = chooseAxis(heightValues, [...order.map(id => value[id] ?? 0), ...ladder, ...Object.values(floor ?? {}), ...Object.values(preferred)]);
  const filled = completeLevels(axis, order, value, observedMax, floor, preferred);
  // Values that arrive out of order (an outside edit) are pushed back into
  // order, lowest level first, so switched-off levels also stay consistent.
  let ordered = filled;
  for (const id of order) ordered = pushLevels(axis, order, ordered, id, ordered[id]!, floor);
  return order.every(id => ordered[id] === filled[id]) ? filled : ordered;
}

/** Defaults for a series that has no chart mounted yet (collapsed rows). */
export function defaultLevelValues(series: DayPoint[], cycles: CycleBounds[] | undefined, today: string | undefined, order: readonly string[], value: LevelValues, floor?: LevelValues, seed?: LevelValues, tolerance?: LevelValues): LevelValues {
  const derived = deriveSeries(series, cycles, today);
  return completeWithDefaults(derived.heightValues, derived.observedMax, order, value, floor, seed, tolerance);
}

/** Set one level on a series with no chart mounted, pushing neighbors like a drag would. */
export function pushLevelValue(series: DayPoint[], cycles: CycleBounds[] | undefined, today: string | undefined, order: readonly string[], values: LevelValues, levelId: string, next: number, floor?: LevelValues): LevelValues {
  const derived = deriveSeries(series, cycles, today);
  const axis = chooseAxis(derived.heightValues, [...order.map(id => values[id] ?? 0), next, ...Object.values(floor ?? {})]);
  return pushLevels(axis, order, values, levelId, next, floor);
}

/**
 * Default level values derived from a scope's typical historical usage.
 * Daily limits use the median nonzero day. Cycle limits use the median of at
 * least two fully covered, completed cycles and otherwise use the daily
 * median multiplied by the current cycle length.
 */
export function toleranceDefaults(
  series: DayPoint[],
  cyclesProp: CycleBounds[] | undefined,
  today: string,
  order: readonly string[],
  percent: LevelValues,
  window: "day" | "cycle",
  windowDays = 90,
): LevelValues {
  const cutoff = dayStart(today) - Math.max(0, windowDays - 1) * DAY_MS;
  const inWindow = series.filter(point => dayStart(point.day) >= cutoff && dayStart(point.day) <= dayStart(today));
  const dailyTypical = median(inWindow.map(point => point.value).filter(value => value > 0));
  const cycles = cyclesProp?.length ? cyclesProp : monthlyCycles(inWindow[0]?.day ?? today, today);
  let baseline = dailyTypical;

  if (window === "cycle") {
    const coveredDays = new Map(inWindow.map(point => [dayStart(point.day), point.sealed !== false]));
    const complete = cycles.filter(cycle => {
      if (cycle.endsAt > dayStart(today)) return false;
      for (let at = cycle.startsAt; at < cycle.endsAt; at += DAY_MS) {
        if (coveredDays.get(at) !== true) return false;
      }
      return true;
    });
    if (complete.length >= 2) {
      baseline = median(complete.map(cycle => inWindow
        .filter(point => {
          const at = dayStart(point.day);
          return at >= cycle.startsAt && at < cycle.endsAt;
        })
        .reduce((sum, point) => sum + Math.max(0, point.value), 0)));
    } else {
      const currentIndex = cycleIndexFor(cycles, today);
      const current = cycles[currentIndex] ?? cycles.at(-1);
      baseline = dailyTypical * (current ? daysBetween(current.startsAt, current.endsAt) : 30);
    }
  }

  if (!(baseline > 0)) return Object.fromEntries(order.map((id, index) => [id, niceLadder(0, order.length)[index]!])) as LevelValues;
  let values: LevelValues = Object.fromEntries(order.map(id => [id, snapToNice(baseline * Math.max(100, percent[id] ?? 100) / 100)]));
  const axis = chooseAxis(inWindow.map(point => point.value), Object.values(values));
  for (const id of order) values = pushLevels(axis, order, values, id, values[id]!);
  return values;
}
