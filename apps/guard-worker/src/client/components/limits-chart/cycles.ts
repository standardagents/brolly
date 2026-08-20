/**
 * Billing-cycle math for the limits chart. Pure functions, no DOM.
 * Days are ISO `YYYY-MM-DD` strings in the ledger's local day; cycles are
 * `[startsAt, endsAt)` epoch milliseconds.
 */

export interface DayPoint { day: string; value: number; sealed?: boolean }
export interface CycleBounds { startsAt: number; endsAt: number }

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
  /** Straight-line projected total at cycle end. */
  projected: number;
}

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

/** Running total per day that resets at each cycle start. */
export function cycleCumulative(series: readonly DayPoint[], cycles: readonly CycleBounds[]): CumulativePoint[] {
  const totals = new Map<number, number>();
  return series.map(point => {
    const cycle = cycleIndexFor(cycles, point.day);
    const cumulative = (totals.get(cycle) ?? 0) + Math.max(0, point.value);
    totals.set(cycle, cumulative);
    return { ...point, cumulative, cycle };
  });
}

/** Straight-line projection of the cycle that contains `today`. */
export function projectCycle(series: readonly DayPoint[], cycles: readonly CycleBounds[], today: string): CycleProjection | null {
  const cycle = cycleIndexFor(cycles, today);
  if (cycle < 0) return null;
  const bounds = cycles[cycle]!;
  const todayAt = dayStart(today);
  const toDate = series
    .filter(point => cycleIndexFor(cycles, point.day) === cycle && dayStart(point.day) <= todayAt)
    .reduce((sum, point) => sum + Math.max(0, point.value), 0);
  const elapsedDays = daysBetween(bounds.startsAt, todayAt + DAY_MS);
  const totalDays = daysBetween(bounds.startsAt, bounds.endsAt);
  return { cycle, toDate, elapsedDays, totalDays, projected: (toDate / elapsedDays) * totalDays };
}

/**
 * Return the day on which the current cycle's straight-line projection first
 * reaches an included allotment. A cycle already above the allotment has no
 * future projected crossing to annotate.
 */
export function projectedCrossingDate(series: readonly DayPoint[], cycles: readonly CycleBounds[], today: string, includedPerCycle?: number): string | null {
  const included = includedPerCycle;
  if (!(typeof included === "number" && Number.isFinite(included) && included > 0)) return null;
  const projection = projectCycle(series, cycles, today);
  if (!projection || projection.toDate >= included || !(projection.projected > included)) return null;
  const dailyRate = projection.toDate / projection.elapsedDays;
  if (!(dailyRate > 0)) return null;
  const bounds = cycles[projection.cycle];
  if (!bounds) return null;
  // Values are recorded at the end of each UTC day. A crossing during day N
  // is shown against that day's label, so day one has offset zero.
  const offset = Math.max(0, Math.ceil(included / dailyRate) - 1);
  const lastDay = Math.max(bounds.startsAt, bounds.endsAt - DAY_MS);
  return dayOf(Math.min(lastDay, bounds.startsAt + offset * DAY_MS));
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
