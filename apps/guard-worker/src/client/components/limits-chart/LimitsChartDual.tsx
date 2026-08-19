import { useMemo } from "react";
import { number as formatNumber } from "../../format";
import { Spinner, Switch } from "../ui";
import { billableMetricIds, costSeries, metricSeries, useUsageSeries, type UsageSeriesResponse } from "./api";
import { cycleIndexFor, type DayPoint } from "./cycles";
import { formatLimitValue, unitLabel } from "./format";
import { LevelValueField } from "./LevelValueField";
import type { LevelValues } from "./levels";
import type { LimitsChartLevel } from "./LimitsChart";
import { Expander, MiniChart } from "./UsageDimensions";
import { useScopeWindow, type ScopeWindow, type UsageLimitValues } from "./use-scope-window";

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
}

const COST_ACCENT = "#2f6fd6";
const USAGE_ACCENT = "#1a9c8c";

/**
 * One table per scope: a row per dimension (cost first) with the per-day and
 * per-billing-cycle mini charts and level chips side by side, one cycle
 * total, and one switch. The open row shows both charts under it.
 */
export function LimitsChartDual({ data: dataProp, token, scope, levels, day, cycle, onChange, tolerance, open, onOpenChange, readOnly = false, costOnly = false }: LimitsChartDualProps) {
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
  const currentCycle = data ? cycleIndexFor(data.cycles, data.today) : -1;
  const cycleTotal = (series: DayPoint[]) => data ? series.filter(point => cycleIndexFor(data.cycles, point.day) === currentCycle).reduce((sum, point) => sum + point.value, 0) : 0;
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
        <div className="grid grid-cols-[minmax(110px,150px)_minmax(0,1fr)_minmax(0,1fr)_84px_36px] items-end gap-x-4 px-3 pb-1 text-[10.5px] font-extrabold uppercase tracking-[.08em] text-faint max-lg:hidden">
          <span />
          <span>Per day</span>
          <span>Per billing cycle</span>
          <span className="text-right">This cycle</span>
          <span />
        </div>
        {rows.map(row => {
          const on = enabledFor(row.id);
          const isOpen = on && open === row.id;
          const total = cycleTotal(row.series);
          return (
            <DualRow
              key={row.id}
              row={row}
              on={on}
              open={isOpen}
              onToggleOpen={() => onOpenChange(isOpen ? null : row.id)}
              onToggle={readOnly ? undefined : next => setEnabled(row.id, next)}
              total={row.unit === "USD" ? formatLimitValue(total, "USD") : formatNumber(total)}
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

function DualRow({ row, on, open, onToggleOpen, onToggle, total, levels, day, cycle, readOnly }: {
  row: { id: string; label: string; unit: string; series: DayPoint[] };
  on: boolean;
  open: boolean;
  onToggleOpen(): void;
  onToggle?(next: boolean): void;
  total: string;
  levels: LimitsChartLevel[];
  day: WindowCell;
  cycle: WindowCell;
  readOnly: boolean;
}) {
  const accent = row.id === "cost" ? COST_ACCENT : USAGE_ACCENT;
  const cell = (window: "day" | "cycle", side: WindowCell) => {
    const activeLevels = levels.filter(level => side.levelEnabled?.[level.id] ?? true);
    return (
      <span className="pointer-events-none relative flex min-w-0 items-center gap-2.5">
        <MiniChart series={row.series} cycles={side.data.cycles} today={side.data.today} window={window} accent={accent} levels={activeLevels} values={side.values} className="h-6 w-[72px] flex-none" />
        <span className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          {levels.map(level => {
            const levelOn = side.levelEnabled?.[level.id] ?? true;
            const value = side.values[level.id];
            const commit = row.id === "cost" ? (next: number) => side.window.commitCost(level.id, next) : (next: number) => side.window.commitUsage(row.id, level.id, next);
            return <LevelValueField key={level.id} variant="chip" level={level} value={value} enabled={levelOn} unit={row.unit} onCommit={on && levelOn && value !== undefined && !readOnly ? commit : undefined} />;
          })}
        </span>
      </span>
    );
  };
  return (
    <div className={`rounded-panel border bg-panel transition-colors duration-200 ${open ? "border-line-strong" : "border-line"} ${on ? "" : "opacity-55"}`}>
      <div className="relative grid grid-cols-[minmax(110px,150px)_minmax(0,1fr)_minmax(0,1fr)_84px_36px] items-center gap-x-4 px-3 py-2 max-lg:grid-cols-[minmax(0,1fr)_84px_36px] max-lg:gap-y-2">
        <button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${row.label}`} disabled={!on} onClick={onToggleOpen} className="absolute inset-0 cursor-pointer rounded-panel disabled:cursor-default" />
        <span className="pointer-events-none relative min-w-0">
          <strong className="block truncate text-[12.5px]">{row.label}</strong>
          <small className="block text-[10.5px] text-faint">{unitLabel(row.unit)}</small>
        </span>
        <span className="relative max-lg:order-last max-lg:col-span-3">{cell("day", day)}</span>
        <span className="relative max-lg:order-last max-lg:col-span-3">{cell("cycle", cycle)}</span>
        <span className="pointer-events-none relative text-right text-[12.5px] font-[740] tabular-nums">{total}</span>
        <span className="relative flex justify-end">{onToggle ? <Switch label={`Monitor ${row.label}`} on={on} onChange={onToggle} title={on ? "Monitored. Switch off to ignore this dimension." : "Not monitored."} /> : null}</span>
      </div>
      <Expander open={open}>
        <div className="grid grid-cols-2 gap-5 max-xl:grid-cols-1">
          <div className="min-w-0">{row.id === "cost" ? day.window.costChart : day.window.usageChart(row.id)}</div>
          <div className="min-w-0">{row.id === "cost" ? cycle.window.costChart : cycle.window.usageChart(row.id)}</div>
        </div>
      </Expander>
    </div>
  );
}
