import { useEffect, useMemo, useRef } from "react";
import { billableMetricIds, costSeries, metricSeries, useUsageSeries, type UsageSeriesResponse } from "./api";
import type { DayPoint } from "./cycles";
import { windowDefaults } from "./defaults";
import { unitLabel } from "./format";
import { LevelValueField } from "./LevelValueField";
import type { LevelValues } from "./levels";
import type { LimitsChartLevel } from "./LimitsChart";
import { Expander, Spinner, Switch } from "../ui";
import { IncludedUsageReadout, MiniChart } from "./UsageDimensions";
import { sameMap, useScopeWindow, type ScopeWindow, type UsageLimitValues } from "./use-scope-window";

export interface WindowLimits {
  cost: LevelValues;
  usage: UsageLimitValues;
  enabled?: boolean;
  costEnabled?: boolean;
  usageEnabled?: Record<string, boolean>;
  costLevelEnabled?: Record<string, boolean>;
  usageLevelEnabled?: Record<string, Record<string, boolean>>;
}

export interface LimitsChartDualProps {
  /** Preloaded series. Preferred when the caller has already fetched this scope. */
  data?: UsageSeriesResponse;
  /** Session token and policy scope used to fetch series when data is omitted. */
  token?: string;
  scope?: string;
  levels: LimitsChartLevel[];
  day: WindowLimits;
  cycle: WindowLimits;
  onChange(window: "day" | "cycle", change: (current: WindowLimits) => WindowLimits): void;
  tolerance?: LevelValues;
  /** Open row: "cost", a metric id, or null. */
  open: string | null;
  onOpenChange(next: string | null): void;
  readOnly?: boolean;
  /** Render only the cost row for account-wide limits. */
  costOnly?: boolean;
  /** Row ids whose values deviate from their defaults; they get the orange edge glow. */
  deviated?: ReadonlySet<string>;
  /**
   * Teaching headings rendered inside the open row, one above each chart.
   * They replace the external Per day / Per billing cycle column header.
   */
  chartHeadings?: { day: string; cycle: string };
  /**
   * Line layout: closed rows are borderless with a faint separator; only the
   * open row draws a full box and pushes its neighbors away.
   */
  separators?: boolean;
}

const COST_ACCENT = "#2f6fd6";
const USAGE_ACCENT = "#1a9c8c";

/**
 * One table per scope: a row per dimension (cost first) with the per-day and
 * per-billing-cycle mini charts, level chips in fixed per-level columns, and
 * one switch. The open row shows both charts under it.
 *
 * A tolerance change moves a dimension's two maps together, and only while
 * both still sit on their defaults (the day map on the previous tolerance,
 * the cycle map on that day map's multiple). Once either is edited, neither
 * follows tolerance until both are reset. Manual daily edits never move the
 * cycle map.
 */
export function LimitsChartDual({ data: dataProp, token, scope, levels, day, cycle, onChange, tolerance, open, onOpenChange, readOnly = false, costOnly = false, deviated, chartHeadings, separators = false }: LimitsChartDualProps) {
  const fetched = useUsageSeries(token ?? "", dataProp ? "" : scope ?? "");
  const data = dataProp ?? fetched.data;
  const accountScope = (scope ?? data?.scope) === "account";
  const planTier = (data as (UsageSeriesResponse & { planTier?: string }) | null)?.planTier;
  const includedBoundaryLabel = planTier === "enterprise" ? "Standard paid-plan allotment" : undefined;
  const dayWindow = useScopeWindow({
    data, window: "day", levels, cost: day.cost, usage: day.usage, tolerance, readOnly,
    accountScope, includedBoundaryLabel,
    onCostChange: cost => onChange("day", current => ({ ...current, cost })),
    onUsageChange: usage => onChange("day", current => ({ ...current, usage })),
    costLevelEnabled: day.costLevelEnabled, onCostLevelEnabledChange: costLevelEnabled => onChange("day", current => ({ ...current, costLevelEnabled })),
    usageLevelEnabled: day.usageLevelEnabled, onUsageLevelEnabledChange: usageLevelEnabled => onChange("day", current => ({ ...current, usageLevelEnabled })),
  });
  const cycleWindow = useScopeWindow({
    data, window: "cycle", levels, cost: cycle.cost, usage: cycle.usage, tolerance, readOnly, costFloor: day.cost, usageFloor: day.usage,
    accountScope, includedBoundaryLabel,
    onCostChange: cost => onChange("cycle", current => ({ ...current, cost })),
    onUsageChange: usage => onChange("cycle", current => ({ ...current, usage })),
    costLevelEnabled: cycle.costLevelEnabled, onCostLevelEnabledChange: costLevelEnabled => onChange("cycle", current => ({ ...current, costLevelEnabled })),
    usageLevelEnabled: cycle.usageLevelEnabled, onUsageLevelEnabledChange: usageLevelEnabled => onChange("cycle", current => ({ ...current, usageLevelEnabled })),
  });
  const metricIds = dayWindow.metricIds;
  const order = dayWindow.order;
  const costUnsupported = data?.planTier === "enterprise";
  // Capped chip columns keep each level's diamond and value a tight pair with
  // even spacing between levels, instead of stretching across the cell; the
  // fixed cap keeps values aligned across rows.
  const chipColumns = { gridTemplateColumns: `96px repeat(${levels.length}, minmax(0, 76px))`, justifyContent: "start" } as const;
  const previousTolerance = useRef(tolerance);
  useEffect(() => {
    const previous = previousTolerance.current;
    previousTolerance.current = tolerance;
    if (!data || !tolerance || !previous || sameMap(previous, tolerance)) return;
    const follow = (series: DayPoint[], dayMap: LevelValues | undefined, cycleMap: LevelValues | undefined, includedPerCycle?: number): { day: LevelValues; cycle: LevelValues } | null => {
      if (!dayMap) return null;
      const dayBefore = windowDefaults(series, data.cycles, data.today, order, "day", previous, undefined);
      if (!dayBefore || !sameMap(dayMap, dayBefore)) return null;
      if (cycleMap && order.some(id => Number.isFinite(cycleMap[id]))) {
        const cycleBefore = windowDefaults(series, data.cycles, data.today, order, "cycle", previous, undefined, includedPerCycle);
        if (!cycleBefore || !sameMap(cycleMap, cycleBefore)) return null;
      }
      const dayAfter = windowDefaults(series, data.cycles, data.today, order, "day", tolerance, undefined);
      const cycleAfter = windowDefaults(series, data.cycles, data.today, order, "cycle", tolerance, undefined, includedPerCycle);
      if (!dayAfter || !cycleAfter) return null;
      return { day: dayAfter, cycle: cycleAfter };
    };
    const cost = follow(costSeries(data), day.cost, cycle.cost);
    const usage = Object.fromEntries(metricIds.map(id => [id, follow(metricSeries(data, id), day.usage[id], cycle.usage[id], accountScope && data.planTier !== "free" ? data.metrics[id]?.includedPerCycle : undefined)] as const).filter(([, next]) => next)) as Record<string, { day: LevelValues; cycle: LevelValues }>;
    if (!cost && !Object.keys(usage).length) return;
    onChange("day", current => ({ ...current, cost: cost ? cost.day : current.cost, usage: { ...current.usage, ...Object.fromEntries(Object.entries(usage).map(([id, next]) => [id, next.day])) } }));
    onChange("cycle", current => ({ ...current, cost: cost ? cost.cycle : current.cost, usage: { ...current.usage, ...Object.fromEntries(Object.entries(usage).map(([id, next]) => [id, next.cycle])) } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to tolerance changes only
  }, [tolerance]);

  const rows = useMemo(() => data ? [
    { id: "cost", label: "Cost", unit: "USD", series: costSeries(data) },
    ...(costOnly ? [] : metricIds.map(id => ({ id, label: data.metrics[id]?.label ?? id, unit: data.metrics[id]?.unit ?? "", series: metricSeries(data, id), includedPerCycle: accountScope && data.planTier !== "free" ? metricIncludedPerCycle(data, id) : undefined }))),
  ] : [], [data, metricIds, costOnly, accountScope]);
  // One switch per dimension, written to both windows; the day map is authoritative.
  const enabledFor = (id: string) => (id === "cost" ? day.costEnabled ?? true : day.usageEnabled?.[id] ?? true);
  const setEnabled = (id: string, next: boolean) => {
    for (const window of ["day", "cycle"] as const) {
      onChange(window, current => (id === "cost" ? { ...current, costEnabled: next } : { ...current, usageEnabled: { ...current.usageEnabled, [id]: next } }));
    }
  };

  if (!dataProp && scope && fetched.loading) {
    return <div className="grid h-[200px] place-content-center text-[13px] text-faint"><span className="inline-flex items-center gap-2"><Spinner /> Loading usage history…</span></div>;
  }
  if (!data) {
    const message = fetched.error || "Usage history is unavailable.";
    return <div className="grid h-[200px] place-content-center text-center text-[13px] text-faint">Usage history is unavailable. {message === "Usage history is unavailable." ? "" : message}</div>;
  }

  return (
    <div className="@container">
      <div className={separators ? "grid" : "grid gap-1.5"}>
        {!chartHeadings && (
          <div className="grid grid-cols-[minmax(110px,150px)_minmax(0,1fr)_minmax(0,1fr)_36px] items-end gap-x-4 px-3 pb-1 text-[10.5px] font-extrabold uppercase tracking-[.08em] text-faint max-lg:hidden">
            <span />
            <span>Per day</span>
            <span>Per billing cycle</span>
            <span />
          </div>
        )}
        {rows.map(row => {
          const on = enabledFor(row.id);
          const unsupported = row.id === "cost" && costUnsupported;
          const isOpen = on && !unsupported && open === row.id;
          return (
            <DualRow
              key={row.id}
              row={row}
              on={on}
              open={isOpen}
              onToggleOpen={() => onOpenChange(isOpen ? null : row.id)}
              onToggle={readOnly || unsupported ? undefined : next => setEnabled(row.id, next)}
              deviated={deviated?.has(row.id) ?? false}
              chipColumns={chipColumns}
              levels={levels}
              day={{ window: dayWindow, values: row.id === "cost" ? day.cost : day.usage[row.id] ?? {}, levelEnabled: row.id === "cost" ? day.costLevelEnabled : day.usageLevelEnabled?.[row.id], data }}
              cycle={{ window: cycleWindow, values: row.id === "cost" ? cycle.cost : cycle.usage[row.id] ?? {}, levelEnabled: row.id === "cost" ? cycle.costLevelEnabled : cycle.usageLevelEnabled?.[row.id], data }}
              readOnly={readOnly}
              unsupported={unsupported}
              chartHeadings={chartHeadings}
              separators={separators}
            />
          );
        })}
      </div>
    </div>
  );
}

interface WindowCell { window: ScopeWindow; values: LevelValues; levelEnabled?: Record<string, boolean>; data: UsageSeriesResponse }

function DualRow({ row, on, open, onToggleOpen, onToggle, deviated, chipColumns, levels, day, cycle, readOnly, unsupported, chartHeadings, separators }: {
  row: { id: string; label: string; unit: string; series: DayPoint[]; includedPerCycle?: number };
  on: boolean;
  open: boolean;
  onToggleOpen(): void;
  onToggle?(next: boolean): void;
  deviated: boolean;
  chipColumns: { gridTemplateColumns: string };
  levels: LimitsChartLevel[];
  day: WindowCell;
  cycle: WindowCell;
  readOnly: boolean;
  unsupported: boolean;
  chartHeadings?: { day: string; cycle: string };
  separators?: boolean;
}) {
  const accent = row.id === "cost" ? COST_ACCENT : USAGE_ACCENT;
  // A disabled row desaturates its content; the switch keeps full strength so
  // the way back on stays obvious.
  const dim = on && !unsupported ? "" : "opacity-55 saturate-0";
  const shell = separators
    ? open
      ? "my-2 rounded-panel border border-line-strong bg-panel first:mt-0 last:mb-0"
      : "border-b border-line-soft last:border-b-0"
    : `rounded-panel border bg-panel ${open ? "border-line-strong" : "border-line"}`;
  // Stable per-side active-level arrays so the memoized MiniChart can skip
  // re-rendering when a sibling row changes.
  const dayActiveLevels = useMemo(() => levels.filter(level => day.levelEnabled?.[level.id] ?? true), [levels, day.levelEnabled]);
  const cycleActiveLevels = useMemo(() => levels.filter(level => cycle.levelEnabled?.[level.id] ?? true), [levels, cycle.levelEnabled]);
  const cell = (window: "day" | "cycle", side: WindowCell) => {
    const activeLevels = window === "day" ? dayActiveLevels : cycleActiveLevels;
    const readout = window === "day" && row.id !== "cost" ? (
      <IncludedUsageReadout series={row.series} cycles={side.data.cycles} today={side.data.today} includedPerCycle={row.includedPerCycle}
        className="block whitespace-nowrap text-[9px] leading-3 text-faint" />
    ) : null;
    return (
      <span className="pointer-events-none relative grid min-w-0 items-center gap-x-2.5" style={chipColumns}>
        <span className="grid min-w-0 gap-0.5">
          <MiniChart series={row.series} cycles={side.data.cycles} today={side.data.today} window={window} accent={accent} levels={activeLevels} values={side.values} className="h-6 w-[72px]" />
          {readout}
        </span>
        {levels.map(level => {
          const levelOn = side.levelEnabled?.[level.id] ?? true;
          const value = side.values[level.id];
          const commit = row.id === "cost" ? (next: number) => side.window.commitCost(level.id, next) : (next: number) => side.window.commitUsage(row.id, level.id, next);
          const toggle = row.id === "cost" ? side.window.toggleCostLevel : side.window.toggleUsageLevel && ((levelId: string, next: boolean) => side.window.toggleUsageLevel!(row.id, levelId, next));
          return <LevelValueField key={level.id} variant="chip" level={level} value={value} enabled={levelOn} unit={row.unit}
            onCommit={on && !unsupported && levelOn && value !== undefined && !readOnly ? commit : undefined}
            onToggle={on && !unsupported && !readOnly && toggle ? next => toggle(level.id, next) : undefined} />;
        })}
      </span>
    );
  };
  return (
    <div data-deviated={deviated || undefined} className={`isolate relative transition-colors duration-200 ${shell}`}>
      {/* Deviation glow: painted behind the row content so it can fade. */}
      <div aria-hidden="true" className={`pointer-events-none absolute inset-0 -z-10 rounded-panel bg-gradient-to-r from-orange-soft/40 via-transparent via-[96px] transition-opacity duration-300 ${deviated ? "opacity-100" : "opacity-0"}`} />
      <div className="relative grid grid-cols-[minmax(110px,150px)_minmax(0,1fr)_minmax(0,1fr)_36px] items-center gap-x-4 px-3 py-2 max-lg:grid-cols-[minmax(0,1fr)_36px] max-lg:gap-y-2">
        <button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${row.label}`} disabled={!on || unsupported} onClick={onToggleOpen} className="absolute inset-0 cursor-pointer rounded-panel disabled:cursor-default" />
        <span className={`pointer-events-none relative min-w-0 ${dim}`}>
          <strong className="block truncate text-[12.5px]">{row.label}{deviated && <span className="ml-0.5 text-orange" title="Differs from the tolerance defaults">*</span>}</strong>
          <small className="block text-[10.5px] text-faint">{unitLabel(row.unit)}</small>
        </span>
        <span className={`pointer-events-none relative max-lg:order-last max-lg:col-span-2 ${dim}`}>{cell("day", day)}</span>
        <span className={`pointer-events-none relative max-lg:order-last max-lg:col-span-2 ${dim}`}>{cell("cycle", cycle)}</span>
        <span className="pointer-events-none relative flex justify-end">{onToggle ? <span className="pointer-events-auto"><Switch label={`Monitor ${row.label}`} on={on} onChange={onToggle} title={on ? "Monitored. Switch off to ignore this dimension." : "Not monitored."} /></span> : null}</span>
      </div>
      {unsupported && <p className="relative m-0 px-3 pb-2 text-[11.5px] text-muted">Cost tracking is not supported on Enterprise plans currently.</p>}
      <Expander open={open} innerClassName={separators ? "px-3 pb-4 pt-1" : "px-3 pb-3 pt-1"}>
        {() => (
          <div className="grid grid-cols-2 gap-5 max-xl:grid-cols-1">
            <div className="min-w-0">
              {row.id === "cost" ? day.window.costChart(chartHeadings?.day) : day.window.usageChart(row.id)}
            </div>
            <div className="min-w-0">
              {row.id === "cost" ? cycle.window.costChart(chartHeadings?.cycle) : cycle.window.usageChart(row.id)}
            </div>
          </div>
        )}
      </Expander>
    </div>
  );
}

function metricIncludedPerCycle(data: UsageSeriesResponse, metricId: string): number | undefined {
  const metric = data.metrics[metricId] as (UsageSeriesResponse["metrics"][string] & { includedPerCycle?: number }) | undefined;
  const included = metric?.includedPerCycle;
  return typeof included === "number" && Number.isFinite(included) && included > 0 ? included : undefined;
}
