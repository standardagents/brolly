import { DAY_MS, type AggregationKind, type CycleBounds, type DayPoint, cycleCumulative, dayStart, daysBetween, denseSeries, monthlyCycles, projectCycle, visibleWindow } from "./cycles";
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

export function deriveSeries(series: DayPoint[], cyclesProp: CycleBounds[] | undefined, todayProp?: string, aggregationKind: AggregationKind = "sum"): DerivedSeries {
  let byKey = deriveCache.get(series);
  if (!byKey) { byKey = new Map(); deriveCache.set(series, byKey); }
  const key = `${todayProp ?? ""}|${aggregationKind}|${cyclesProp ? cyclesProp.map(cycle => cycle.startsAt).join(",") : ""}`;
  let derived = byKey.get(key);
  if (!derived) { derived = deriveSeriesImpl(series, cyclesProp, todayProp, aggregationKind); byKey.set(key, derived); }
  return derived;
}
function deriveSeriesImpl(series: DayPoint[], cyclesProp: CycleBounds[] | undefined, todayProp: string | undefined, aggregationKind: AggregationKind) {
  const today = todayProp ?? series.at(-1)?.day ?? new Date().toISOString().slice(0, 10);
  const cycles = cyclesProp?.length ? cyclesProp : monthlyCycles(series[0]?.day ?? today, today);
  const window = visibleWindow(series, cycles, today);
  const dense = denseSeries(series, window.fromDay, window.toDay);
  const cumulative = cycleCumulative(dense, cycles, aggregationKind);
  const projection = projectCycle(dense, cycles, today, aggregationKind);
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
export function defaultLevelValues(series: DayPoint[], cycles: CycleBounds[] | undefined, today: string | undefined, order: readonly string[], value: LevelValues, floor?: LevelValues, seed?: LevelValues, tolerance?: LevelValues, aggregationKind: AggregationKind = "sum"): LevelValues {
  const derived = deriveSeries(series, cycles, today, aggregationKind);
  return completeWithDefaults(derived.heightValues, derived.observedMax, order, value, floor, seed, tolerance);
}

/** Set one level on a series with no chart mounted, pushing neighbors like a drag would. */
export function pushLevelValue(series: DayPoint[], cycles: CycleBounds[] | undefined, today: string | undefined, order: readonly string[], values: LevelValues, levelId: string, next: number, floor?: LevelValues, aggregationKind: AggregationKind = "sum"): LevelValues {
  const derived = deriveSeries(series, cycles, today, aggregationKind);
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
export function dailyMultiple(daily: LevelValues | undefined, order: readonly string[], cycleDays: number, aggregationKind: AggregationKind = "sum"): LevelValues | undefined {
  if (!daily || !order.every(id => Number.isFinite(daily[id]))) return undefined;
  return Object.fromEntries(order.map(id => [id, aggregationKind === "sum" ? daily[id]! * cycleDays : daily[id]!]));
}

/**
 * Robust typical usage for one billing cycle: the median non-zero day in the
 * lookback window times the days in the current cycle (point-in-time meters
 * use the median day itself). A median day shrugs off a runaway fortnight,
 * which a median of two or three whole cycles cannot.
 */
export function typicalCycleUsage(series: DayPoint[], cycles: CycleBounds[] | undefined, today: string, aggregationKind: AggregationKind = "sum", windowDays = 90): number {
  const cutoff = dayStart(today) - Math.max(0, windowDays - 1) * DAY_MS;
  const inWindow = series.filter(point => dayStart(point.day) >= cutoff && dayStart(point.day) <= dayStart(today));
  const day = median(inWindow.map(point => point.value).filter(value => value > 0));
  return aggregationKind === "sum" ? day * cycleDaysFor(cycles, today) : day;
}

/**
 * The quantity a tolerance percent applies to for one cycle: the larger of
 * typical cycle usage and the included allotment. Inside the free tier the
 * allotment is the baseline, so "100%" is where billing starts; a meter that
 * is consistently billable keeps its typical usage as the baseline.
 */
export function cycleBaseline(series: DayPoint[], cycles: CycleBounds[] | undefined, today: string, includedPerCycle: number | undefined, aggregationKind: AggregationKind = "sum"): number {
  const included = typeof includedPerCycle === "number" && Number.isFinite(includedPerCycle) && includedPerCycle > 0 ? includedPerCycle : 0;
  return Math.max(typicalCycleUsage(series, cycles, today, aggregationKind), included);
}

/** Level values at `percent` of `baseline`, snapped and pushed into order on the series axis. */
function levelsFromBaseline(series: DayPoint[], order: readonly string[], percent: LevelValues, baseline: number): LevelValues {
  if (!(baseline > 0)) return Object.fromEntries(order.map((id, index) => [id, niceLadder(0, order.length)[index]!])) as LevelValues;
  let values: LevelValues = Object.fromEntries(order.map(id => [id, snapToNice(baseline * Math.max(1, percent[id] ?? 100) / 100)]));
  const axis = chooseAxis(series.map(point => point.value), Object.values(values));
  for (const id of order) values = pushLevels(axis, order, values, id, values[id]!);
  return values;
}

/**
 * Daily defaults for a meter with an included allotment: the cycle baseline
 * spread over the cycle's days, times each level's tolerance percent. A daily
 * warning then means "on pace to leave the free tier", and the cycle default
 * stays the daily default times the days in the cycle. Without an allotment
 * this is `toleranceDefaults`.
 */
export function dailyToleranceDefaults(series: DayPoint[], cycles: CycleBounds[] | undefined, today: string, order: readonly string[], percent: LevelValues, includedPerCycle?: number, aggregationKind: AggregationKind = "sum"): LevelValues {
  if (!(typeof includedPerCycle === "number" && Number.isFinite(includedPerCycle) && includedPerCycle > 0)) return toleranceDefaults(series, today, order, percent);
  const baseline = cycleBaseline(series, cycles, today, includedPerCycle, aggregationKind);
  const daily = aggregationKind === "sum" ? baseline / cycleDaysFor(cycles, today) : baseline;
  return levelsFromBaseline(series, order, percent, daily);
}

/**
 * The map a window sits on when nobody has edited it. Daily maps follow the
 * risk tolerance; billing-cycle maps are the tolerance-derived daily default
 * times the days in the current cycle (a hand-edited day map never moves the
 * cycle default), falling back to the given daily map when no tolerance is
 * known. Meters with an included allotment derive both windows from
 * `cycleBaseline`. Returns undefined when the basis is not available yet. The chart
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
  aggregationKind: AggregationKind = "sum",
): LevelValues | undefined {
  const dayDefault = tolerance
    ? defaultLevelValues(series, cycles, today, order, {}, undefined, undefined, dailyToleranceDefaults(series, cycles, today, order, tolerance, includedPerCycle, aggregationKind), aggregationKind)
    : undefined;
  if (window === "day") return dayDefault;
  const hasAllotment = typeof includedPerCycle === "number" && Number.isFinite(includedPerCycle) && includedPerCycle > 0;
  if (tolerance && hasAllotment) {
    // Allotment meters seed the cycle straight from the baseline so snapping
    // on the daily side cannot drift the cycle values off the boundary.
    const seed = levelsFromBaseline(series, order, tolerance, cycleBaseline(series, cycles, today, includedPerCycle, aggregationKind));
    return defaultLevelValues(series, cycles, today, order, {}, undefined, seed, undefined, aggregationKind);
  }
  const seed = dailyMultiple(dayDefault ?? daily, order, cycleDaysFor(cycles, today), aggregationKind);
  if (!seed) return undefined;
  return defaultLevelValues(series, cycles, today, order, {}, undefined, seed, undefined, aggregationKind);
}
