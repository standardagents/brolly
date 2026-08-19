import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { billableMetricIds, costSeries, metricSeries, type UsageSeriesResponse } from "./api";
import { defaultLevelValues, pushLevelValue, toleranceDefaults } from "./defaults";
import type { LevelValues } from "./levels";
import { LevelTrack } from "./LevelTrack";
import { LimitsChart, type LimitsChartLevel } from "./LimitsChart";
import { useLimitHistories } from "./use-limit-history";

export interface UsageLimitValues { [metricId: string]: LevelValues }

export interface ScopeWindowInput {
  data: UsageSeriesResponse | null;
  window: "day" | "cycle";
  levels: LimitsChartLevel[];
  cost: LevelValues;
  onCostChange(next: LevelValues): void;
  usage: UsageLimitValues;
  onUsageChange(next: UsageLimitValues): void;
  /** Daily maps, for the cycle window: they seed cycle defaults and show as a reference. */
  costFloor?: LevelValues;
  usageFloor?: UsageLimitValues;
  /** Global tolerance: levelId → percent of typical. */
  tolerance?: LevelValues;
  readOnly?: boolean;
  costLevelEnabled?: Record<string, boolean>;
  onCostLevelEnabledChange?(next: Record<string, boolean>): void;
  usageLevelEnabled?: Record<string, Record<string, boolean>>;
  onUsageLevelEnabledChange?(next: Record<string, Record<string, boolean>>): void;
}

export interface ScopeWindow {
  metricIds: string[];
  order: string[];
  /** The cost chart for this window (or a note while cycle waits for daily values). */
  costChart: ReactNode;
  usageChart(id: string): ReactNode;
  /** Chip edits: push the value like a drag would and record undo history. */
  commitCost(levelId: string, next: number): void;
  commitUsage(id: string, levelId: string, next: number): void;
  toggleCostLevel?(levelId: string, next: boolean): void;
  toggleUsageLevel?(id: string, levelId: string, next: boolean): void;
}

/**
 * Everything one window (day or cycle) of a scope needs behind its rows:
 * default seeding for collapsed rows, tolerance follow-through, per-chart
 * undo history, chart nodes, and chip edit handlers. Layouts decide how the
 * rows look; this decides what they contain.
 */
export function useScopeWindow({ data, window, levels, cost, onCostChange, usage, onUsageChange, costFloor, usageFloor, tolerance, readOnly, costLevelEnabled, onCostLevelEnabledChange, usageLevelEnabled, onUsageLevelEnabledChange }: ScopeWindowInput): ScopeWindow {
  const metricIds = useMemo(() => (data ? billableMetricIds(data) : []), [data]);
  const order = useMemo(() => levels.map(level => level.id), [levels]);
  const histories = useLimitHistories();
  const usageRef = useRef(usage);
  usageRef.current = usage;
  const costRef = useRef(cost);
  costRef.current = cost;
  const publishUsage = (next: UsageLimitValues) => { usageRef.current = next; onUsageChange(next); };
  const changeUsage = (id: string, next: LevelValues) => publishUsage({ ...usageRef.current, [id]: next });

  const cycleDays = useMemo(() => {
    if (!data) return 30;
    const todayAt = Date.parse(`${data.today}T00:00:00Z`);
    const current = data.cycles.find(cycle => todayAt >= cycle.startsAt && todayAt < cycle.endsAt);
    return current ? Math.max(1, Math.round((current.endsAt - current.startsAt) / 86_400_000)) : 30;
  }, [data]);
  const scaleFloor = (floor?: LevelValues) => (window === "cycle" && floor ? Object.fromEntries(Object.entries(floor).map(([id, item]) => [id, item * cycleDays])) : undefined);
  const floorReady = (floor?: LevelValues) => window !== "cycle" || (!!floor && order.every(id => Number.isFinite(floor[id])));

  // Collapsed rows show the same defaults the chart would compute.
  useEffect(() => {
    if (!data) return;
    const costMissing = order.some(levelId => !Number.isFinite(costRef.current[levelId])) && floorReady(costFloor);
    if (costMissing) {
      const series = costSeries(data);
      const fromTolerance = tolerance ? toleranceDefaults(series, data.cycles, data.today, order, tolerance, window) : undefined;
      onCostChange(defaultLevelValues(series, data.cycles, data.today, order, costRef.current, undefined, scaleFloor(costFloor), fromTolerance));
    }
    const missing = metricIds.filter(id => order.some(levelId => !(Number.isFinite(usageRef.current[id]?.[levelId])))).filter(id => floorReady(usageFloor?.[id]));
    if (!missing.length) return;
    const next = { ...usageRef.current };
    for (const id of missing) {
      const series = metricSeries(data, id);
      const fromTolerance = tolerance ? toleranceDefaults(series, data.cycles, data.today, order, tolerance, window) : undefined;
      next[id] = defaultLevelValues(series, data.cycles, data.today, order, usageRef.current[id] ?? {}, undefined, scaleFloor(usageFloor?.[id]), fromTolerance);
    }
    publishUsage(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when data, floors, tolerance, or the level order change
  }, [data, metricIds, order, usageFloor, costFloor, tolerance, window]);

  // Maps still sitting on the previous tolerance's values follow a tolerance change.
  const previousTolerance = useRef(tolerance);
  useEffect(() => {
    const previous = previousTolerance.current;
    previousTolerance.current = tolerance;
    if (!data || !tolerance || !previous || sameMap(previous, tolerance)) return;
    const resetFor = (series: ReturnType<typeof costSeries>, floor: LevelValues | undefined, percent: LevelValues) =>
      defaultLevelValues(series, data.cycles, data.today, order, {}, undefined, scaleFloor(floor), toleranceDefaults(series, data.cycles, data.today, order, percent, window));
    const history = costSeries(data);
    if (sameMap(costRef.current, resetFor(history, costFloor, previous))) onCostChange(resetFor(history, costFloor, tolerance));
    const nextUsage = { ...usageRef.current };
    let changed = false;
    for (const id of metricIds) {
      const series = metricSeries(data, id);
      if (nextUsage[id] && sameMap(nextUsage[id]!, resetFor(series, usageFloor?.[id], previous))) { nextUsage[id] = resetFor(series, usageFloor?.[id], tolerance); changed = true; }
    }
    if (changed) publishUsage(nextUsage);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to tolerance changes only
  }, [tolerance]);

  const waitingNote = <div className="grid h-[120px] place-content-center text-center text-[13px] text-faint">Set the daily limits first. Billing-cycle limits start from them.</div>;
  // A scope with no recorded usage has nothing to plot; its levels are set on
  // a plain track in absolute units instead of a chart.
  const hasUsage = !!data && data.series.some(point => point.costUsd > 0 || Object.values(point.metrics).some(value => value > 0));
  const costChart = (() => {
    if (!data) return null;
    if (!floorReady(costFloor)) return waitingNote;
    if (!hasUsage) return <LevelTrack levels={levels} unit="USD" value={cost} onChange={onCostChange} readOnly={readOnly} levelEnabled={costLevelEnabled} onLevelEnabledChange={onCostLevelEnabledChange} />;
    const series = costSeries(data);
    const fromTolerance = tolerance ? toleranceDefaults(series, data.cycles, data.today, order, tolerance, window) : undefined;
    const reset = fromTolerance ? defaultLevelValues(series, data.cycles, data.today, order, {}, undefined, scaleFloor(costFloor), fromTolerance) : undefined;
    return (
      <LimitsChart kind="cost" unit="USD" window={window} series={series} cycles={data.cycles} today={data.today}
        levels={levels} value={cost} seed={scaleFloor(costFloor)} tolerance={fromTolerance} resetToTolerance={reset}
        reference={window === "cycle" ? costFloor : undefined} onChange={onCostChange} readOnly={readOnly}
        levelEnabled={costLevelEnabled} onLevelEnabledChange={onCostLevelEnabledChange} history={histories("cost")} fields="inline" />
    );
  })();
  const usageChart = (id: string): ReactNode => {
    if (!data) return null;
    if (!floorReady(usageFloor?.[id])) return waitingNote;
    if (!hasUsage) return <LevelTrack levels={levels} unit={data.metrics[id]?.unit ?? ""} value={usage[id] ?? {}} onChange={next => changeUsage(id, next)} readOnly={readOnly}
      levelEnabled={usageLevelEnabled?.[id]} onLevelEnabledChange={onUsageLevelEnabledChange ? next => onUsageLevelEnabledChange({ ...usageLevelEnabled, [id]: next }) : undefined} />;
    const series = metricSeries(data, id);
    const fromTolerance = tolerance ? toleranceDefaults(series, data.cycles, data.today, order, tolerance, window) : undefined;
    const reset = fromTolerance ? defaultLevelValues(series, data.cycles, data.today, order, {}, undefined, scaleFloor(usageFloor?.[id]), fromTolerance) : undefined;
    return <LimitsChart key={id} kind="usage" unit={data.metrics[id]?.unit ?? ""} window={window} series={series}
      cycles={data.cycles} today={data.today} levels={levels} value={usage[id] ?? {}} seed={scaleFloor(usageFloor?.[id])}
      tolerance={fromTolerance} resetToTolerance={reset} reference={window === "cycle" ? usageFloor?.[id] : undefined}
      onChange={next => changeUsage(id, next)} readOnly={readOnly}
      levelEnabled={usageLevelEnabled?.[id]} onLevelEnabledChange={onUsageLevelEnabledChange ? next => onUsageLevelEnabledChange({ ...usageLevelEnabled, [id]: next }) : undefined}
      history={histories(id)} fields="inline" />;
  };

  const commitCost = (levelId: string, next: number) => {
    if (!data || readOnly) return;
    const pushed = pushLevelValue(costSeries(data), data.cycles, data.today, order, costRef.current, levelId, next, window === "cycle" ? undefined : costFloor);
    histories("cost").seed(costRef.current);
    histories("cost").record(pushed);
    onCostChange(pushed);
  };
  const commitUsage = (id: string, levelId: string, next: number) => {
    if (!data || readOnly) return;
    const current = usageRef.current[id] ?? {};
    const pushed = pushLevelValue(metricSeries(data, id), data.cycles, data.today, order, current, levelId, next, window === "cycle" ? undefined : usageFloor?.[id]);
    histories(id).seed(current);
    histories(id).record(pushed);
    changeUsage(id, pushed);
  };

  return {
    metricIds, order, costChart, usageChart, commitCost, commitUsage,
    toggleCostLevel: onCostLevelEnabledChange && !readOnly ? (levelId, next) => onCostLevelEnabledChange({ ...costLevelEnabled, [levelId]: next }) : undefined,
    toggleUsageLevel: onUsageLevelEnabledChange && !readOnly ? (id, levelId, next) => onUsageLevelEnabledChange({ ...usageLevelEnabled, [id]: { ...usageLevelEnabled?.[id], [levelId]: next } }) : undefined,
  };
}

export function sameMap(left: LevelValues, right: LevelValues): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(key => left[key] === right[key]);
}
