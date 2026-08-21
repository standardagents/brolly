/**
 * Billing-cycle math for the limits chart. Pure functions, no DOM.
 * Days are ISO `YYYY-MM-DD` strings in the ledger's local day; cycles are
 * `[startsAt, endsAt)` epoch milliseconds.
 */

export interface DayPoint { day: string; value: number; sealed?: boolean }
export interface CycleBounds { startsAt: number; endsAt: number }
export type AggregationKind = "sum" | "maximum" | "latest";

function isNonAdditive(kind: AggregationKind): boolean {
  return kind === "maximum" || kind === "latest";
}

export interface CumulativePoint extends DayPoint {
  /** Running total inside the day's billing cycle. */
  cumulative: number;
  /** Index into the cycles array, or -1 when no cycle contains the day. */
  cycle: number;
}

export interface CycleProjection {
  cycle: number;
  /** Cumulative value on `today`. */
  toDate: number;
  /** Days from cycle start through today, inclusive. */
  elapsedDays: number;
  /** Total days in the cycle. */
  totalDays: number;
  /** Recent daily pace: the median of the last seven days in the cycle. */
  rate: number;
  /** Projected total at cycle end: today's total plus the recent pace over the remaining days. */
  projected: number;
}

/** Days of the current cycle that set the projection's pace. */
export const PROJECTION_PACE_DAYS = 7;

export const DAY_MS = 86_400_000;

export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function daysBetween(startsAt: number, endsAt: number): number {
  return Math.max(1, Math.round((endsAt - startsAt) / DAY_MS));
}

/**
 * Calendar-month cycles covering `[fromDay, toDay]` for accounts whose real
 * billing cycles are unknown. Cycles are UTC month boundaries.
 */
export function monthlyCycles(fromDay: string, toDay: string): CycleBounds[] {
  const cycles: CycleBounds[] = [];
  const first = new Date(dayStart(fromDay));
  let year = first.getUTCFullYear();
  let month = first.getUTCMonth();
  const end = dayStart(toDay);
  for (let cursor = Date.UTC(year, month, 1); cursor <= end; cursor = Date.UTC(year, month, 1)) {
    const next = Date.UTC(year, month + 1, 1);
    cycles.push({ startsAt: cursor, endsAt: next });
    month += 1;
    if (month === 12) { month = 0; year += 1; }
  }
  return cycles;
}

/** Index of the cycle containing `day`, or -1. */
export function cycleIndexFor(cycles: readonly CycleBounds[], day: string): number {
  const at = dayStart(day);
  return cycles.findIndex(cycle => at >= cycle.startsAt && at < cycle.endsAt);
}

/** Running cycle value per day that resets at each cycle start. */
export function cycleCumulative(series: readonly DayPoint[], cycles: readonly CycleBounds[], aggregationKind: AggregationKind = "sum"): CumulativePoint[] {
  const totals = new Map<number, number>();
  return series.map(point => {
    const cycle = cycleIndexFor(cycles, point.day);
    const value = Math.max(0, point.value);
    const previous = totals.get(cycle) ?? 0;
    const cumulative = isNonAdditive(aggregationKind) ? Math.max(previous, value) : previous + value;
    totals.set(cycle, cumulative);
    return { ...point, cumulative, cycle };
  });
}

/**
 * Projection of the cycle that contains `today`. The total so far is fact;
 * the slope is the recent pace (median of the last PROJECTION_PACE_DAYS days
 * in the cycle), so a spike early in the cycle stays in the total without
 * dictating the rest of the month once usage has settled.
 */
export function projectCycle(series: readonly DayPoint[], cycles: readonly CycleBounds[], today: string, aggregationKind: AggregationKind = "sum"): CycleProjection | null {
  const cycle = cycleIndexFor(cycles, today);
  if (cycle < 0) return null;
  const bounds = cycles[cycle]!;
  const todayAt = dayStart(today);
  const currentPoints = series
    .filter(point => cycleIndexFor(cycles, point.day) === cycle && dayStart(point.day) <= todayAt)
    .sort((left, right) => left.day.localeCompare(right.day));
  const toDate = isNonAdditive(aggregationKind)
    ? Math.max(0, ...currentPoints.map(point => Math.max(0, point.value)))
    : currentPoints.reduce((sum, point) => sum + Math.max(0, point.value), 0);
  const elapsedDays = daysBetween(bounds.startsAt, todayAt + DAY_MS);
  const totalDays = daysBetween(bounds.startsAt, bounds.endsAt);
  const recent = currentPoints.slice(-PROJECTION_PACE_DAYS).map(point => Math.max(0, point.value)).sort((left, right) => left - right);
  const rate = isNonAdditive(aggregationKind) || !recent.length ? 0 : recent.length % 2 ? recent[(recent.length - 1) / 2]! : (recent[recent.length / 2 - 1]! + recent[recent.length / 2]!) / 2;
  const remainingDays = Math.max(0, totalDays - elapsedDays);
  return { cycle, toDate, elapsedDays, totalDays, rate, projected: isNonAdditive(aggregationKind) ? toDate : toDate + rate * remainingDays };
}

/**
 * Return the day on which the current cycle's straight-line projection first
 * reaches an included allotment. A cycle already above the allotment has no
 * future projected crossing to annotate.
 */
export function projectedCrossingDate(series: readonly DayPoint[], cycles: readonly CycleBounds[], today: string, includedPerCycle?: number, aggregationKind: AggregationKind = "sum"): string | null {
  const included = includedPerCycle;
  if (!(typeof included === "number" && Number.isFinite(included) && included > 0)) return null;
  const projection = projectCycle(series, cycles, today, aggregationKind);
  if (!projection || projection.toDate >= included || !(projection.projected > included)) return null;
  if (!(projection.rate > 0)) return null;
  const bounds = cycles[projection.cycle];
  if (!bounds) return null;
  // Values are recorded at the end of each UTC day. The crossing lands
  // `ceil(shortfall / pace)` days after today; day one has offset zero.
  const offset = Math.max(0, projection.elapsedDays + Math.ceil((included - projection.toDate) / projection.rate) - 1);
  const lastDay = Math.max(bounds.startsAt, bounds.endsAt - DAY_MS);
  return dayOf(Math.min(lastDay, bounds.startsAt + offset * DAY_MS));
}

export interface FreeRemainingPoint extends DayPoint {
  /** Index into the cycles array, or -1 when no cycle contains the day. */
  cycle: number;
  /** Included allotment still unspent at the start of the day. */
  before: number;
  /** Included allotment still unspent at the end of the day. */
  after: number;
}

/**
 * Free usage left in the cycle, day by day: the allotment minus the running
 * total, clamped at zero. It starts the cycle at the full allotment and falls
 * as usage accumulates, so the day chart can draw it as the inverse of the
 * cumulative usage. Point-in-time meters subtract the running maximum.
 */
export function freeRemainingSeries(series: readonly DayPoint[], cycles: readonly CycleBounds[], includedPerCycle: number | undefined, aggregationKind: AggregationKind = "sum"): FreeRemainingPoint[] {
  const included = includedPerCycle;
  if (!(typeof included === "number" && Number.isFinite(included) && included > 0)) return [];
  const used = new Map<number, number>();
  return series.map(point => {
    const cycle = cycleIndexFor(cycles, point.day);
    const usedBefore = used.get(cycle) ?? 0;
    const value = Math.max(0, point.value);
    const usedAfter = isNonAdditive(aggregationKind) ? Math.max(usedBefore, value) : usedBefore + value;
    used.set(cycle, usedAfter);
    return { ...point, cycle, before: Math.max(0, included - usedBefore), after: Math.max(0, included - usedAfter) };
  });
}

/**
 * How much of each running total is still inside the allotment. With a
 * shared pool the ceiling falls as the other members spend it: the room left
 * for this metric is the allotment minus everything the others have used.
 */
export function includedTops(selfCumulative: readonly number[], poolCumulative: readonly number[] | undefined, includedPerCycle: number): number[] {
  return selfCumulative.map((self, index) => {
    const others = poolCumulative ? Math.max(0, (poolCumulative[index] ?? self) - self) : 0;
    return Math.min(self, Math.max(0, includedPerCycle - others));
  });
}

/** Shorter name for chart callers that describe the annotation as a crossing. */
export const projectedCrossingDay = projectedCrossingDate;

/**
 * The window to render: the cycle containing `today` plus `priorCycles`
 * before it, clamped to the days present in `series`.
 */
export function visibleWindow(series: readonly DayPoint[], cycles: readonly CycleBounds[], today: string, priorCycles = 2): { fromDay: string; toDay: string } {
  const current = cycleIndexFor(cycles, today);
  const firstCycle = cycles[Math.max(0, current - priorCycles)];
  const oldest = series[0]?.day ?? today;
  const fromDay = firstCycle && current >= 0 ? dayOf(Math.max(firstCycle.startsAt, dayStart(oldest))) : oldest;
  return { fromDay: fromDay > today ? today : fromDay, toDay: today };
}

/** Every day from `fromDay` through `toDay`, filling gaps with zero. */
export function denseSeries(series: readonly DayPoint[], fromDay: string, toDay: string): DayPoint[] {
  const known = new Map(series.map(point => [point.day, point.value]));
  const output: DayPoint[] = [];
  for (let at = dayStart(fromDay); at <= dayStart(toDay); at += DAY_MS) {
    const day = dayOf(at);
    output.push({ day, value: Math.max(0, known.get(day) ?? 0) });
  }
  return output;
}
