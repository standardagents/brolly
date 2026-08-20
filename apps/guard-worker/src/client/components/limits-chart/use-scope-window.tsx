import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { billableCostSeries, billableMetricIds, costSeries, metricSeries, type UsageSeriesResponse } from "./api";
import { cycleDaysFor, dailyMultiple, defaultLevelValues, pushLevelValue, toleranceDefaults, windowDefaults } from "./defaults";
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
  /** Daily maps, for the cycle window: cycle defaults are daily × cycle days, and they show as a reference. */
  costFloor?: LevelValues;
  usageFloor?: UsageLimitValues;
  /** Global tolerance: seeds the day window; the cycle window uses it only to recognize an untouched seeded multiple. */
  tolerance?: LevelValues;
  /** Included allotments are account-wide and must stay off family/resource charts. */
  accountScope?: boolean;
  /** Boundary label override used for enterprise's paid-plan baseline. */
  includedBoundaryLabel?: string;
  readOnly?: boolean;
  costLevelEnabled?: Record<string, boolean>;
  onCostLevelEnabledChange?(next: Record<string, boolean>): void;
  usageLevelEnabled?: Record<string, Record<string, boolean>>;
  onUsageLevelEnabledChange?(next: Record<string, Record<string, boolean>>): void;
}

export interface ScopeWindow {
  metricIds: string[];
  order: string[];
  /** The cost chart for this window (or a note while cycle waits for daily values). Built lazily: only the open row pays for it. */
  costChart(title?: string): ReactNode;
  usageChart(id: string): ReactNode;
  /** Chip edits: push the value like a drag would and record undo history. */
  commitCost(levelId: string, next: number): void;
  commitUsage(id: string, levelId: string, next: number): void;
  toggleCostLevel?(levelId: string, next: boolean): void;
  toggleUsageLevel?(id: string, levelId: string, next: boolean): void;
}

/**
 * Everything one window (day or cycle) of a scope needs behind its rows:
 * default seeding for collapsed rows, per-chart
 * undo history, chart nodes, and chip edit handlers. Layouts decide how the
 * rows look; this decides what they contain.
 */
export function useScopeWindow({ data, window, levels, cost, onCostChange, usage, onUsageChange, costFloor, usageFloor, tolerance, accountScope = false, includedBoundaryLabel, readOnly, costLevelEnabled, onCostLevelEnabledChange, usageLevelEnabled, onUsageLevelEnabledChange }: ScopeWindowInput): ScopeWindow {
  const metricIds = useMemo(() => (data ? billableMetricIds(data) : []), [data]);
  const order = useMemo(() => levels.map(level => level.id), [levels]);
  const histories = useLimitHistories();
  const usageRef = useRef(usage);
  usageRef.current = usage;
  const costRef = useRef(cost);
  costRef.current = cost;
  const publishUsage = (next: UsageLimitValues) => { usageRef.current = next; onUsageChange(next); };
  const changeUsage = (id: string, next: LevelValues) => publishUsage({ ...usageRef.current, [id]: next });

  const cycleDays = data ? cycleDaysFor(data.cycles, data.today) : 30;
  const scaleFloor = (floor?: LevelValues) => (window === "cycle" ? dailyMultiple(floor, order, cycleDays) : undefined);
  const floorReady = (floor?: LevelValues) => window !== "cycle" || !!dailyMultiple(floor, order, cycleDays);
  const dayTolerance = window === "day" ? tolerance : undefined;
  const defaultsFor = (series: ReturnType<typeof costSeries>, floor: LevelValues | undefined, includedPerCycle?: number) =>
    data ? windowDefaults(series, data.cycles, data.today, order, window, tolerance, floor, includedPerCycle) : undefined;

  // Collapsed rows show the same defaults the chart would compute.
  useEffect(() => {
    if (!data) return;
    const costMissing = order.some(levelId => !Number.isFinite(costRef.current[levelId])) && floorReady(costFloor);
    if (costMissing) {
      const series = costSeries(data);
      const fromTolerance = dayTolerance ? toleranceDefaults(series, data.today, order, dayTolerance) : undefined;
      onCostChange(defaultLevelValues(series, data.cycles, data.today, order, costRef.current, undefined, scaleFloor(costFloor), fromTolerance));
    }
    const missing = metricIds.filter(id => order.some(levelId => !(Number.isFinite(usageRef.current[id]?.[levelId])))).filter(id => floorReady(usageFloor?.[id]));
    if (!missing.length) return;
    const next = { ...usageRef.current };
    for (const id of missing) {
      const series = metricSeries(data, id);
      const fromTolerance = dayTolerance ? toleranceDefaults(series, data.today, order, dayTolerance) : undefined;
      const included = accountScope && window === "cycle" && data.planTier !== "free" ? data.metrics[id]?.includedPerCycle : undefined;
      const seeded = window === "cycle"
        ? windowDefaults(series, data.cycles, data.today, order, "cycle", tolerance, usageFloor?.[id], included)
        : undefined;
      next[id] = defaultLevelValues(series, data.cycles, data.today, order, usageRef.current[id] ?? {}, undefined, seeded ?? scaleFloor(usageFloor?.[id]), seeded ? undefined : fromTolerance);
    }
    publishUsage(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when data, floors, tolerance, or the level order change
  }, [data, metricIds, order, usageFloor, costFloor, dayTolerance, window, accountScope]);

  const waitingNote = <div className="grid h-[120px] place-content-center text-center text-[13px] text-faint">Set the daily limits first. Billing-cycle limits start from them.</div>;
  // A scope with no recorded usage has nothing to plot; its levels are set on
  // a plain track in absolute units instead of a chart.
  const hasUsage = !!data && data.series.some(point => point.costUsd > 0 || Object.values(point.metrics).some(value => value > 0));
  const costChart = (title?: string): ReactNode => {
    if (!data) return null;
    if (!floorReady(costFloor)) return waitingNote;
    if (!hasUsage) return <LevelTrack levels={levels} unit="USD" value={cost} onChange={onCostChange} readOnly={readOnly} levelEnabled={costLevelEnabled} onLevelEnabledChange={onCostLevelEnabledChange} />;
    const series = costSeries(data);
    const secondarySeries = billableCostSeries(data);
    const fromTolerance = dayTolerance ? toleranceDefaults(series, data.today, order, dayTolerance) : undefined;
    const reset = defaultsFor(series, costFloor);
    return (
      <LimitsChart kind="cost" unit="USD" window={window} series={series} cycles={data.cycles} today={data.today}
        secondarySeries={secondarySeries.length ? secondarySeries : undefined} secondaryLabel="Estimated billable cost"
        title={title} titleIndent={Boolean(title)}
        levels={levels} value={cost} seed={scaleFloor(costFloor)} tolerance={fromTolerance} resetToTolerance={reset}
        reference={window === "cycle" ? costFloor : undefined} onChange={onCostChange} readOnly={readOnly}
        levelEnabled={costLevelEnabled} onLevelEnabledChange={onCostLevelEnabledChange} history={histories("cost")} fields="inline" />
    );
  };
  const usageChart = (id: string): ReactNode => {
    if (!data) return null;
    if (!floorReady(usageFloor?.[id])) return waitingNote;
    if (!hasUsage) return <LevelTrack levels={levels} unit={data.metrics[id]?.unit ?? ""} value={usage[id] ?? {}} onChange={next => changeUsage(id, next)} readOnly={readOnly}
      levelEnabled={usageLevelEnabled?.[id]} onLevelEnabledChange={onUsageLevelEnabledChange ? next => onUsageLevelEnabledChange({ ...usageLevelEnabled, [id]: next }) : undefined} />;
    const series = metricSeries(data, id);
    const fromTolerance = dayTolerance ? toleranceDefaults(series, data.today, order, dayTolerance) : undefined;
    const included = accountScope && window === "cycle" && data.planTier !== "free" ? data.metrics[id]?.includedPerCycle : undefined;
    const reset = defaultsFor(series, usageFloor?.[id], included);
    return <LimitsChart key={id} kind="usage" unit={data.metrics[id]?.unit ?? ""} window={window} series={series}
      cycles={data.cycles} today={data.today} levels={levels} value={usage[id] ?? {}} seed={scaleFloor(usageFloor?.[id])}
      tolerance={fromTolerance} resetToTolerance={reset} reference={window === "cycle" ? usageFloor?.[id] : undefined}
      includedPerCycle={included} includedBoundaryLabel={includedBoundaryLabel}
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
