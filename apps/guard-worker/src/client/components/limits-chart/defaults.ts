import { DAY_MS, type CycleBounds, type DayPoint, cycleCumulative, cycleIndexFor, dayStart, daysBetween, denseSeries, monthlyCycles, projectCycle, visibleWindow } from "./cycles";
import { type LevelValues, completeLevels, pushLevels } from "./levels";
import { chooseAxis, median, niceLadder, snapToNice } from "./scale";

/**
 * Everything the chart derives from a raw series: the visible window, the
 * dense day list, running totals, and the projection. Shared by the chart
 * and by the row list so unexpanded rows can show the same defaults.
 */

type DerivedSeries = ReturnType<typeof deriveSeriesImpl>;
// Cached per series-array identity: the same series is derived by charts,
// defaults, and deviation checks many times per render pass.
const deriveCache = new WeakMap<DayPoint[], Map<string, DerivedSeries>>();

export function deriveSeries(series: DayPoint[], cyclesProp: CycleBounds[] | undefined, todayProp?: string): DerivedSeries {
  let byKey = deriveCache.get(series);
  if (!byKey) { byKey = new Map(); deriveCache.set(series, byKey); }
  const key = `${todayProp ?? ""}|${cyclesProp ? cyclesProp.map(cycle => cycle.startsAt).join(",") : ""}`;
  let derived = byKey.get(key);
  if (!derived) { derived = deriveSeriesImpl(series, cyclesProp, todayProp); byKey.set(key, derived); }
  return derived;
}
function deriveSeriesImpl(series: DayPoint[], cyclesProp: CycleBounds[] | undefined, todayProp?: string) {
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
 * Default daily level values derived from a scope's typical historical usage:
 * the median nonzero day times each level's tolerance percent. Billing-cycle
 * values never come from tolerance directly; see `windowDefaults`.
 */
export function toleranceDefaults(
  series: DayPoint[],
  today: string,
  order: readonly string[],
  percent: LevelValues,
  windowDays = 90,
): LevelValues {
  const cutoff = dayStart(today) - Math.max(0, windowDays - 1) * DAY_MS;
  const inWindow = series.filter(point => dayStart(point.day) >= cutoff && dayStart(point.day) <= dayStart(today));
  const baseline = median(inWindow.map(point => point.value).filter(value => value > 0));
  if (!(baseline > 0)) return Object.fromEntries(order.map((id, index) => [id, niceLadder(0, order.length)[index]!])) as LevelValues;
  let values: LevelValues = Object.fromEntries(order.map(id => [id, snapToNice(baseline * Math.max(1, percent[id] ?? 100) / 100)]));
  const axis = chooseAxis(inWindow.map(point => point.value), Object.values(values));
  for (const id of order) values = pushLevels(axis, order, values, id, values[id]!);
  return values;
}

/** Days in the billing cycle that contains `today`; 30 when no cycle covers it. */
export function cycleDaysFor(cycles: CycleBounds[] | undefined, today: string): number {
  const todayAt = dayStart(today);
  const current = cycles?.find(cycle => todayAt >= cycle.startsAt && todayAt < cycle.endsAt);
  return current ? Math.max(1, daysBetween(current.startsAt, current.endsAt)) : 30;
}

/** A complete daily map scaled to the billing cycle, or undefined while a level is still missing. */
export function dailyMultiple(daily: LevelValues | undefined, order: readonly string[], cycleDays: number): LevelValues | undefined {
  if (!daily || !order.every(id => Number.isFinite(daily[id]))) return undefined;
  return Object.fromEntries(order.map(id => [id, daily[id]! * cycleDays]));
}

/**
 * Median observed cycle usage, excluding the current partial cycle when a
 * completed cycle is available. The current cycle remains a fallback so a
 * first-run account that has already crossed its allotment does not receive a
 * fresh warning below its present usage.
 */
export function typicalCycleUsage(series: DayPoint[], cycles: CycleBounds[] | undefined, today: string): number {
  const bounds = cycles?.length ? cycles : monthlyCycles(series[0]?.day ?? today, today);
  const todayAt = dayStart(today);
  const current = cycleIndexFor(bounds, today);
  const totals = new Map<number, number>();
  for (const point of series) {
    if (dayStart(point.day) > todayAt) continue;
    const cycle = cycleIndexFor(bounds, point.day);
    if (cycle < 0) continue;
    totals.set(cycle, (totals.get(cycle) ?? 0) + Math.max(0, point.value));
  }
  const all = [...totals.values()].filter(value => value > 0);
  const completed = [...totals.entries()]
    .filter(([cycle]) => cycle !== current)
    .map(([, value]) => value)
    .filter(value => value > 0);
  return median(completed.length ? completed : all);
}

/**
 * Account-cycle defaults anchored to a Workers Paid included allotment. The
 * first two alert levels represent the 80% warning and 100% billable boundary;
 * the third level keeps its tolerance-derived value with the boundary as its
 * lower bound. A typical cycle already above the allotment returns undefined,
 * allowing the caller to use its existing tolerance defaults.
 */
export function includedCycleDefaults(
  series: DayPoint[],
  cycles: CycleBounds[] | undefined,
  today: string,
  order: readonly string[],
  tolerance: LevelValues | undefined,
  daily: LevelValues | undefined,
  includedPerCycle: number | undefined,
): LevelValues | undefined {
  if (!(includedPerCycle && Number.isFinite(includedPerCycle) && includedPerCycle > 0) || !order.length) return undefined;
  if (typicalCycleUsage(series, cycles, today) > includedPerCycle) return undefined;
  const cycleDays = cycleDaysFor(cycles, today);
  const dailyDefault = tolerance
    ? defaultLevelValues(series, cycles, today, order, {}, undefined, undefined, toleranceDefaults(series, today, order, tolerance))
    : daily;
  const toleranceCycle = dailyMultiple(dailyDefault, order, cycleDays);
  const seed: LevelValues = {};
  order.forEach((id, index) => {
    if (index === 0) seed[id] = includedPerCycle * 0.8;
    else if (index === 1) seed[id] = includedPerCycle;
    else if (index === 2) seed[id] = Math.max(includedPerCycle, toleranceCycle?.[id] ?? includedPerCycle);
    else seed[id] = toleranceCycle?.[id] ?? includedPerCycle;
  });
  const axis = chooseAxis(series.map(point => point.value), Object.values(seed));
  let result: LevelValues = Object.fromEntries(order.map(id => [id, seed[id] ?? includedPerCycle]));
  for (const id of order) result = pushLevels(axis, order, result, id, result[id]!);
  return result;
}

/**
 * The map a window sits on when nobody has edited it. Daily maps follow the
 * risk tolerance; billing-cycle maps are the tolerance-derived daily default
 * times the days in the current cycle (a hand-edited day map never moves the
 * cycle default), falling back to the given daily map when no tolerance is
 * known. Returns undefined when the basis is not available yet. The chart
 * reset action, the collapsed-row seeding, the follow-through on tolerance
 * changes, and the "differs from defaults" marker all compare against this
 * one function.
 */
export function windowDefaults(
  series: DayPoint[],
  cycles: CycleBounds[] | undefined,
  today: string,
  order: readonly string[],
  window: "day" | "cycle",
  tolerance: LevelValues | undefined,
  daily: LevelValues | undefined,
  includedPerCycle?: number,
): LevelValues | undefined {
  const dayDefault = tolerance
    ? defaultLevelValues(series, cycles, today, order, {}, undefined, undefined, toleranceDefaults(series, today, order, tolerance))
    : undefined;
  if (window === "day") return dayDefault;
  const included = includedCycleDefaults(series, cycles, today, order, tolerance, daily, includedPerCycle);
  if (included) return included;
  const seed = dailyMultiple(dayDefault ?? daily, order, cycleDaysFor(cycles, today));
  if (!seed) return undefined;
  return defaultLevelValues(series, cycles, today, order, {}, undefined, seed);
}
