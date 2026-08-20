import { useEffect, useMemo, useRef } from "react";
import { billableMetricIds, costSeries, metricSeries, useUsageSeries, type UsageSeriesResponse } from "./api";
import type { DayPoint } from "./cycles";
import { windowDefaults } from "./defaults";
import { unitLabel } from "./format";
import { LevelValueField } from "./LevelValueField";
import type { LevelValues } from "./levels";
import type { LimitsChartLevel } from "./LimitsChart";
import { Expander, Spinner, Switch } from "../ui";
import { MiniChart } from "./UsageDimensions";
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
export function LimitsChartDual({ data: dataProp, token, scope, levels, day, cycle, onChange, tolerance, open, onOpenChange, readOnly = false, costOnly = false, deviated }: LimitsChartDualProps) {
  const fetched = useUsageSeries(token ?? "", dataProp ? "" : scope ?? "");
  const data = dataProp ?? fetched.data;
  const dayWindow = useScopeWindow({
    data, window: "day", levels, cost: day.cost, usage: day.usage, tolerance, readOnly,
    onCostChange: cost => onChange("day", current => ({ ...current, cost })),
    onUsageChange: usage => onChange("day", current => ({ ...current, usage })),
    costLevelEnabled: day.costLevelEnabled, onCostLevelEnabledChange: costLevelEnabled => onChange("day", current => ({ ...current, costLevelEnabled })),
    usageLevelEnabled: day.usageLevelEnabled, onUsageLevelEnabledChange: usageLevelEnabled => onChange("day", current => ({ ...current, usageLevelEnabled })),
  });
  const cycleWindow = useScopeWindow({
    data, window: "cycle", levels, cost: cycle.cost, usage: cycle.usage, tolerance, readOnly, costFloor: day.cost, usageFloor: day.usage,
    onCostChange: cost => onChange("cycle", current => ({ ...current, cost })),
    onUsageChange: usage => onChange("cycle", current => ({ ...current, usage })),
    costLevelEnabled: cycle.costLevelEnabled, onCostLevelEnabledChange: costLevelEnabled => onChange("cycle", current => ({ ...current, costLevelEnabled })),
    usageLevelEnabled: cycle.usageLevelEnabled, onUsageLevelEnabledChange: usageLevelEnabled => onChange("cycle", current => ({ ...current, usageLevelEnabled })),
  });
  const metricIds = dayWindow.metricIds;
  const order = dayWindow.order;
  const chipColumns = { gridTemplateColumns: `72px repeat(${levels.length}, minmax(0, 1fr))` } as const;
  const previousTolerance = useRef(tolerance);
  useEffect(() => {
    const previous = previousTolerance.current;
    previousTolerance.current = tolerance;
    if (!data || !tolerance || !previous || sameMap(previous, tolerance)) return;
    const follow = (series: DayPoint[], dayMap: LevelValues | undefined, cycleMap: LevelValues | undefined): { day: LevelValues; cycle: LevelValues } | null => {
      if (!dayMap) return null;
      const dayBefore = windowDefaults(series, data.cycles, data.today, order, "day", previous, undefined);
      if (!dayBefore || !sameMap(dayMap, dayBefore)) return null;
      if (cycleMap && order.some(id => Number.isFinite(cycleMap[id]))) {
        const cycleBefore = windowDefaults(series, data.cycles, data.today, order, "cycle", previous, undefined);
        if (!cycleBefore || !sameMap(cycleMap, cycleBefore)) return null;
      }
      const dayAfter = windowDefaults(series, data.cycles, data.today, order, "day", tolerance, undefined);
      const cycleAfter = windowDefaults(series, data.cycles, data.today, order, "cycle", tolerance, undefined);
      if (!dayAfter || !cycleAfter) return null;
      return { day: dayAfter, cycle: cycleAfter };
    };
    const cost = follow(costSeries(data), day.cost, cycle.cost);
    const usage = Object.fromEntries(metricIds.map(id => [id, follow(metricSeries(data, id), day.usage[id], cycle.usage[id])] as const).filter(([, next]) => next)) as Record<string, { day: LevelValues; cycle: LevelValues }>;
    if (!cost && !Object.keys(usage).length) return;
    onChange("day", current => ({ ...current, cost: cost ? cost.day : current.cost, usage: { ...current.usage, ...Object.fromEntries(Object.entries(usage).map(([id, next]) => [id, next.day])) } }));
    onChange("cycle", current => ({ ...current, cost: cost ? cost.cycle : current.cost, usage: { ...current.usage, ...Object.fromEntries(Object.entries(usage).map(([id, next]) => [id, next.cycle])) } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to tolerance changes only
  }, [tolerance]);

  const rows = useMemo(() => data ? [
    { id: "cost", label: "Cost", unit: "USD", series: costSeries(data) },
    ...(costOnly ? [] : metricIds.map(id => ({ id, label: data.metrics[id]?.label ?? id, unit: data.metrics[id]?.unit ?? "", series: metricSeries(data, id) }))),
  ] : [], [data, metricIds, costOnly]);
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
      <div className="grid gap-1.5">
        <div className="grid grid-cols-[minmax(110px,150px)_minmax(0,1fr)_minmax(0,1fr)_36px] items-end gap-x-4 px-3 pb-1 text-[10.5px] font-extrabold uppercase tracking-[.08em] text-faint max-lg:hidden">
          <span />
          <span>Per day</span>
          <span>Per billing cycle</span>
          <span />
        </div>
        {rows.map(row => {
          const on = enabledFor(row.id);
          const isOpen = on && open === row.id;
          return (
            <DualRow
              key={row.id}
              row={row}
              on={on}
              open={isOpen}
              onToggleOpen={() => onOpenChange(isOpen ? null : row.id)}
              onToggle={readOnly ? undefined : next => setEnabled(row.id, next)}
              deviated={deviated?.has(row.id) ?? false}
              chipColumns={chipColumns}
              levels={levels}
              day={{ window: dayWindow, values: row.id === "cost" ? day.cost : day.usage[row.id] ?? {}, levelEnabled: row.id === "cost" ? day.costLevelEnabled : day.usageLevelEnabled?.[row.id], data }}
              cycle={{ window: cycleWindow, values: row.id === "cost" ? cycle.cost : cycle.usage[row.id] ?? {}, levelEnabled: row.id === "cost" ? cycle.costLevelEnabled : cycle.usageLevelEnabled?.[row.id], data }}
              readOnly={readOnly}
            />
          );
        })}
      </div>
    </div>
  );
}

interface WindowCell { window: ScopeWindow; values: LevelValues; levelEnabled?: Record<string, boolean>; data: UsageSeriesResponse }

function DualRow({ row, on, open, onToggleOpen, onToggle, deviated, chipColumns, levels, day, cycle, readOnly }: {
  row: { id: string; label: string; unit: string; series: DayPoint[] };
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
}) {
  const accent = row.id === "cost" ? COST_ACCENT : USAGE_ACCENT;
  const cell = (window: "day" | "cycle", side: WindowCell) => {
    const activeLevels = levels.filter(level => side.levelEnabled?.[level.id] ?? true);
    return (
      <span className="pointer-events-none relative grid min-w-0 items-center gap-x-2.5" style={chipColumns}>
        <MiniChart series={row.series} cycles={side.data.cycles} today={side.data.today} window={window} accent={accent} levels={activeLevels} values={side.values} className="h-6 w-[72px]" />
        {levels.map(level => {
          const levelOn = side.levelEnabled?.[level.id] ?? true;
          const value = side.values[level.id];
          const commit = row.id === "cost" ? (next: number) => side.window.commitCost(level.id, next) : (next: number) => side.window.commitUsage(row.id, level.id, next);
          const toggle = row.id === "cost" ? side.window.toggleCostLevel : side.window.toggleUsageLevel && ((levelId: string, next: boolean) => side.window.toggleUsageLevel!(row.id, levelId, next));
          return <LevelValueField key={level.id} variant="chip" level={level} value={value} enabled={levelOn} unit={row.unit}
            onCommit={on && levelOn && value !== undefined && !readOnly ? commit : undefined}
            onToggle={on && !readOnly && toggle ? next => toggle(level.id, next) : undefined} />;
        })}
      </span>
    );
  };
  return (
    <div data-deviated={deviated || undefined} className={`isolate relative rounded-panel border bg-panel transition-colors duration-200 ${open ? "border-line-strong" : "border-line"} ${on ? "" : "opacity-55"}`}>
      {/* Deviation glow: painted behind the row content so it can fade. */}
      <div aria-hidden="true" className={`pointer-events-none absolute inset-0 -z-10 rounded-panel bg-gradient-to-r from-orange-soft/40 via-transparent via-[96px] transition-opacity duration-300 ${deviated ? "opacity-100" : "opacity-0"}`} />
      <div className="relative grid grid-cols-[minmax(110px,150px)_minmax(0,1fr)_minmax(0,1fr)_36px] items-center gap-x-4 px-3 py-2 max-lg:grid-cols-[minmax(0,1fr)_36px] max-lg:gap-y-2">
        <button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${row.label}`} disabled={!on} onClick={onToggleOpen} className="absolute inset-0 cursor-pointer rounded-panel disabled:cursor-default" />
        <span className="pointer-events-none relative min-w-0">
          <strong className="block truncate text-[12.5px]">{row.label}{deviated && <span className="ml-0.5 text-orange" title="Differs from the tolerance defaults">*</span>}</strong>
          <small className="block text-[10.5px] text-faint">{unitLabel(row.unit)}</small>
        </span>
        <span className="pointer-events-none relative max-lg:order-last max-lg:col-span-2">{cell("day", day)}</span>
        <span className="pointer-events-none relative max-lg:order-last max-lg:col-span-2">{cell("cycle", cycle)}</span>
        <span className="pointer-events-none relative flex justify-end">{onToggle ? <span className="pointer-events-auto"><Switch label={`Monitor ${row.label}`} on={on} onChange={onToggle} title={on ? "Monitored. Switch off to ignore this dimension." : "Not monitored."} /></span> : null}</span>
      </div>
      <Expander open={open} innerClassName="px-3 pb-3 pt-1">
        {() => (
          <div className="grid grid-cols-2 gap-5 max-xl:grid-cols-1">
            <div className="min-w-0">{row.id === "cost" ? day.window.costChart() : day.window.usageChart(row.id)}</div>
            <div className="min-w-0">{row.id === "cost" ? cycle.window.costChart() : cycle.window.usageChart(row.id)}</div>
          </div>
        )}
      </Expander>
    </div>
  );
}
