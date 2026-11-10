import { useEffect, useMemo, useRef } from "react";
import { costSeries, metricAggregationKind, metricIncluded, metricPool, rowSeries, useUsageSeries, type UsageSeriesResponse } from "./api";
import { cycleCumulative, denseSeries, visibleWindow, type AggregationKind, type DayPoint } from "./cycles";
import { displayPercent, windowBaseline, windowDefaults } from "./defaults";
import { compactLimitValue, unitLabel } from "./format";
import { LevelValueField } from "./LevelValueField";
import type { LevelValues } from "./levels";
import { CHART_ACCENT, type LimitsChartLevel } from "./LimitsChart";
import { Expander, Spinner } from "../ui";
import { MiniChart } from "./UsageDimensions";
import { sameMap, useScopeWindow, type ScopeWindow, type UsageLimitValues } from "./use-scope-window";
import { ChartScaleProvider, type ChartScaleMode } from "./ChartScaleMode";
import { recommendedUsageScale } from "./scale";

export interface WindowLimits {
  cost: LevelValues;
  usage: UsageLimitValues;
  enabled?: boolean;
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
  /**
   * Teaching layout: no row header (label, sparklines, chips, switch); the
   * charts render open with their headings. Used by the account step.
   */
  headerless?: boolean;
}

interface ChartRow {
  id: string;
  label: string;
  unit: string;
  series: DayPoint[];
  includedPerCycle?: number;
  poolSeries?: DayPoint[];
  aggregationKind?: AggregationKind;
  initialScale: ChartScaleMode;
}

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
export function LimitsChartDual({ data: dataProp, token, scope, levels, day, cycle, onChange, tolerance, open, onOpenChange, readOnly = false, costOnly = false, deviated, chartHeadings, separators = false, headerless = false }: LimitsChartDualProps) {
  const fetched = useUsageSeries(token ?? "", dataProp ? "" : scope ?? "");
  const data = dataProp ?? fetched.data;
  const scopeKey = scope ?? data?.scope;
  // Included allotments belong to family product meters. Account limits are
  // cost-only and resource charts are measured independently.
  const quotaScope = scopeKey?.startsWith("family:") === true;
  const planTier = (data as (UsageSeriesResponse & { planTier?: string }) | null)?.planTier;
  const dayWindow = useScopeWindow({
    data, window: "day", levels, cost: day.cost, usage: day.usage, tolerance, readOnly,
    quotaScope, usageEnabled: !costOnly,
    onCostChange: cost => onChange("day", current => ({ ...current, cost })),
    onUsageChange: usage => onChange("day", current => ({ ...current, usage })),
  });
  const cycleWindow = useScopeWindow({
    data, window: "cycle", levels, cost: cycle.cost, usage: cycle.usage, tolerance, readOnly, costFloor: day.cost, usageFloor: day.usage,
    quotaScope, usageEnabled: !costOnly,
    onCostChange: cost => onChange("cycle", current => ({ ...current, cost })),
    onUsageChange: usage => onChange("cycle", current => ({ ...current, usage })),
  });
  const metricIds = dayWindow.metricIds;
  const order = dayWindow.order;
  // A scope with no recorded usage has nothing to collapse: its rows are
  // level tracks, shown open with their own history controls.
  const trackOnly = !!data && !data.series.some(point => point.costUsd > 0 || Object.values(point.metrics).some(value => value > 0));
  const bare = headerless || trackOnly;
  const costUnsupported = data?.planTier === "enterprise";
  const previousTolerance = useRef(tolerance);
  useEffect(() => {
    const previous = previousTolerance.current;
    previousTolerance.current = tolerance;
    if (!data || !tolerance || !previous || sameMap(previous, tolerance)) return;
    const follow = (series: DayPoint[], dayMap: LevelValues | undefined, cycleMap: LevelValues | undefined, includedPerCycle?: number, aggregationKind: AggregationKind = "sum"): { day: LevelValues; cycle: LevelValues } | null => {
      if (!dayMap) return null;
      const dayBefore = windowDefaults(series, data.cycles, data.today, order, "day", previous, undefined, includedPerCycle, aggregationKind);
      if (!dayBefore || !sameMap(dayMap, dayBefore)) return null;
      if (cycleMap && order.some(id => Number.isFinite(cycleMap[id]))) {
        const cycleBefore = windowDefaults(series, data.cycles, data.today, order, "cycle", previous, undefined, includedPerCycle, aggregationKind);
        if (!cycleBefore || !sameMap(cycleMap, cycleBefore)) return null;
      }
      const dayAfter = windowDefaults(series, data.cycles, data.today, order, "day", tolerance, undefined, includedPerCycle, aggregationKind);
      const cycleAfter = windowDefaults(series, data.cycles, data.today, order, "cycle", tolerance, undefined, includedPerCycle, aggregationKind);
      if (!dayAfter || !cycleAfter) return null;
      return { day: dayAfter, cycle: cycleAfter };
    };
    const cost = follow(costSeries(data), day.cost, cycle.cost);
    const usage = Object.fromEntries(metricIds.map(id => [id, follow(rowSeries(data, id), day.usage[id], cycle.usage[id], quotaScope && data.planTier !== "free" ? metricIncluded(data, id) : undefined, metricAggregationKind(data, id))] as const).filter(([, next]) => next)) as Record<string, { day: LevelValues; cycle: LevelValues }>;
    if (!cost && !Object.keys(usage).length) return;
    onChange("day", current => ({ ...current, cost: cost ? cost.day : current.cost, usage: { ...current.usage, ...Object.fromEntries(Object.entries(usage).map(([id, next]) => [id, next.day])) } }));
    onChange("cycle", current => ({ ...current, cost: cost ? cost.cycle : current.cost, usage: { ...current.usage, ...Object.fromEntries(Object.entries(usage).map(([id, next]) => [id, next.cycle])) } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to tolerance changes only
  }, [tolerance]);

  const rows = useMemo<ChartRow[]>(() => data ? [
    { id: "cost", label: "Cost", unit: "USD", series: costSeries(data), initialScale: recommendedPairScale(costSeries(data), data) },
    ...(costOnly ? [] : metricIds.map(id => {
      const quota = quotaScope && data.planTier !== "free";
      const series = rowSeries(data, id);
      const aggregationKind = metricAggregationKind(data, id);
      const includedPerCycle = quota ? metricIncluded(data, id) : undefined;
      return { id, label: data.metrics[id]?.label ?? id, unit: data.metrics[id]?.unit ?? "", series, includedPerCycle, poolSeries: quota ? metricPool(data, id)?.series : undefined, aggregationKind, initialScale: recommendedPairScale(series, data, aggregationKind, includedPerCycle) };
    })),
  ] : [], [data, metricIds, costOnly, quotaScope]);
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
          // The cycle heading is as wide as the right-anchored cycle group
          // (chart + gap + level columns), so it starts over the cycle chart.
          <div className="flex items-end gap-x-10 px-3 pb-1 text-[10.5px] font-extrabold uppercase tracking-[.08em] text-faint max-lg:hidden">
            <span className="w-[140px] flex-none" />
            <span>Per day</span>
            <span className="ml-auto" style={{ width: 108 + levels.length * 94 - 10 }}>Per billing cycle</span>
          </div>
        )}
        {rows.map(row => {
          const unsupported = row.id === "cost" && costUnsupported;
          const isOpen = !unsupported && open === row.id;
          if (bare) {
            return (
              <ChartScaleProvider key={row.id} initialMode={row.initialScale}>
                <div className="grid grid-cols-2 gap-5 max-xl:grid-cols-1">
                  <div className="min-w-0">{row.id === "cost" ? dayWindow.costChart(chartHeadings?.day) : dayWindow.usageChart(row.id)}</div>
                  <div className="min-w-0">{row.id === "cost" ? cycleWindow.costChart(chartHeadings?.cycle) : cycleWindow.usageChart(row.id)}</div>
                  {unsupported && <p className="col-span-full m-0 text-[11.5px] text-muted">Cost tracking is not supported on Enterprise plans currently.</p>}
                </div>
              </ChartScaleProvider>
            );
          }
          return (
            <ChartScaleProvider key={row.id} initialMode={row.initialScale}>
              <DualRow
                row={row}
                open={isOpen}
                onToggleOpen={() => onOpenChange(isOpen ? null : row.id)}
                deviated={deviated?.has(row.id) ?? false}
                levels={levels}
                day={{ window: dayWindow, values: row.id === "cost" ? day.cost : day.usage[row.id] ?? {}, data }}
                cycle={{ window: cycleWindow, values: row.id === "cost" ? cycle.cost : cycle.usage[row.id] ?? {}, data }}
                tolerance={tolerance}
                quotaIncluded={quotaScope && data.planTier !== "free" ? row.includedPerCycle : undefined}
                readOnly={readOnly}
                unsupported={unsupported}
                chartHeadings={chartHeadings}
                separators={separators}
              />
            </ChartScaleProvider>
          );
        })}
      </div>
    </div>
  );
}

interface WindowCell { window: ScopeWindow; values: LevelValues; data: UsageSeriesResponse }

function DualRow({ row, open, onToggleOpen, deviated, levels, day, cycle, tolerance, quotaIncluded, readOnly, unsupported, chartHeadings, separators }: {
  row: ChartRow;
  open: boolean;
  onToggleOpen(): void;
  deviated: boolean;
  levels: LimitsChartLevel[];
  day: WindowCell;
  cycle: WindowCell;
  /** Global tolerance percents; untouched chips read these back instead of a recomputed percent. */
  tolerance?: LevelValues;
  /** Included allotment used for default seeding on quota scopes. */
  quotaIncluded?: number;
  readOnly: boolean;
  unsupported: boolean;
  chartHeadings?: { day: string; cycle: string };
  separators?: boolean;
}) {
  const accent = CHART_ACCENT;
  // An unsupported row desaturates its content.
  const dim = unsupported ? "opacity-55 saturate-0" : "";
  // Both states keep the same box: a full 1px border on every row, with the
  // closed row's sides and top transparent. Opening only recolors, so no
  // layout shift.
  const shell = separators
    ? open
      ? "rounded-panel border border-line-strong bg-panel"
      : "rounded-panel border border-transparent border-b-line-soft last:border-b-transparent"
    : `rounded-panel border bg-panel ${open ? "border-line-strong" : "border-line"}`;
  const order = levels.map(level => level.id);
  const cell = (window: "day" | "cycle", side: WindowCell) => {
    const baseline = windowBaseline(row.series, side.data.cycles, side.data.today, window, row.includedPerCycle, row.aggregationKind);
    // The untouched map this window seeds from; a value still on it shows the tolerance percent itself.
    const seeded = tolerance ? windowDefaults(row.series, side.data.cycles, side.data.today, order, window, tolerance, window === "cycle" ? day.values : undefined, quotaIncluded, row.aggregationKind ?? "sum") : undefined;
    return (
      // Fixed-width level columns keep the trio aligned across rows; the
      // chart sits a larger step away so the levels read as one group rather
      // than hanging off the chart.
      <span className="pointer-events-none relative flex min-w-0 items-center gap-x-9">
        <MiniChart series={row.series} cycles={side.data.cycles} today={side.data.today} window={window} accent={accent} levels={levels} values={side.values} includedPerCycle={row.includedPerCycle} poolSeries={row.poolSeries} aggregationKind={row.aggregationKind} className="h-6 w-[72px] flex-none" />
        <span className="grid min-w-0 auto-cols-[84px] grid-flow-col items-center gap-x-2.5">
        {levels.map(level => {
          const value = side.values[level.id];
          const commit = row.id === "cost" ? (next: number) => side.window.commitCost(level.id, next) : (next: number) => side.window.commitUsage(row.id, level.id, next);
          const deviates = value !== undefined && seeded?.[level.id] !== undefined && value !== seeded[level.id];
          return <LevelValueField key={level.id} variant="chip" level={level} value={value} unit={row.unit}
            percent={deviates ? displayPercent(value, baseline) : undefined}
            percentAccent={deviates}
            onCommit={!unsupported && value !== undefined && !readOnly ? commit : undefined} />;
        })}
        </span>
      </span>
    );
  };
  return (
    <div data-deviated={deviated || undefined} className={`isolate relative transition-colors duration-200 ${shell}`}>
      {/* Deviation glow: painted behind the row content so it can fade. */}
      <div aria-hidden="true" className={`pointer-events-none absolute inset-0 -z-10 rounded-panel bg-gradient-to-r from-orange-soft/40 via-transparent via-[96px] transition-opacity duration-300 ${deviated ? "opacity-100" : "opacity-0"}`} />
      <div className="relative flex items-center gap-x-10 px-3 py-3 max-lg:flex-wrap max-lg:gap-y-2">
        <button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${row.label}`} disabled={unsupported} onClick={onToggleOpen} className="absolute inset-0 cursor-pointer rounded-panel disabled:cursor-default" />
        <span className={`pointer-events-none relative w-[140px] flex-none min-w-0 ${dim}`}>
          <strong className="block truncate text-[12.5px]">{row.label}{deviated && <span className="ml-0.5 text-orange" title="Differs from the tolerance defaults">*</span>}</strong>
          <small className="block text-[10.5px] text-faint">{row.includedPerCycle ? `${compactLimitValue(row.includedPerCycle, row.unit)} included` : unitLabel(row.unit)}</small>
        </span>
        <span className={`pointer-events-none relative max-lg:order-last ${dim}`}>{cell("day", day)}</span>
        <span className={`pointer-events-none relative ml-auto max-lg:order-last max-lg:ml-0 ${dim}`}>{cell("cycle", cycle)}</span>
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

/**
 * The scale a day/cycle pair opens on, from the daily usage alone. A running
 * cycle total always spans tiny early-cycle values to a large cycle-end value,
 * so it reads as spiky even for steady spend; only genuine daily spikes should
 * open the pair on the logarithmic scale, and never while the whole history
 * sits comfortably inside the free allotment.
 */
function recommendedPairScale(series: DayPoint[], data: UsageSeriesResponse, aggregationKind: AggregationKind = "sum", includedPerCycle?: number): ChartScaleMode {
  const window = visibleWindow(series, data.cycles, data.today);
  const dense = denseSeries(series, window.fromDay, window.toDay);
  const maxCycleTotal = Math.max(0, ...cycleCumulative(dense, data.cycles, aggregationKind).map(point => point.cumulative));
  return recommendedUsageScale(series.map(point => point.value), maxCycleTotal, includedPerCycle);
}
