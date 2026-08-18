import { useMemo } from "react";
import { number as formatNumber } from "../../format";
import type { UsageSeriesResponse } from "./api";
import { cycleIndexFor, type DayPoint } from "./cycles";
import type { LevelValues } from "./levels";
import { formatLimitValue, type LimitsChartLevel } from "./LimitsChart";

/**
 * Dimension rows for the limits chart pair: every billable dimension as a
 * sparkline row with its level values; the selected row expands into the
 * chart. Cost uses the same row shape with a single "dimension".
 */

export interface DimensionSummary {
  id: string;
  label: string;
  unit: string;
  /** Total inside the billing cycle that contains today. */
  cycleToDate: number;
  /** Total over the whole visible series. */
  total: number;
  series: DayPoint[];
}

export function summarizeDimensions(data: UsageSeriesResponse, ids: string[]): DimensionSummary[] {
  const current = cycleIndexFor(data.cycles, data.today);
  return ids.map(id => {
    const series = data.series.map(point => ({ day: point.day, value: point.metrics[id] ?? 0 }));
    const cycleToDate = series
      .filter(point => cycleIndexFor(data.cycles, point.day) === current)
      .reduce((sum, point) => sum + point.value, 0);
    return {
      id, label: data.metrics[id]?.label ?? id, unit: data.metrics[id]?.unit ?? "", series, cycleToDate,
      total: series.reduce((sum, point) => sum + point.value, 0),
    };
  });
}

/** The cost series shaped like a dimension so it can share the row treatment. */
export function summarizeCost(data: UsageSeriesResponse): DimensionSummary {
  const current = cycleIndexFor(data.cycles, data.today);
  const series = data.series.map(point => ({ day: point.day, value: point.costUsd }));
  return {
    id: "cost", label: "Cost", unit: "USD", series,
    cycleToDate: series.filter(point => cycleIndexFor(data.cycles, point.day) === current).reduce((sum, point) => sum + point.value, 0),
    total: series.reduce((sum, point) => sum + point.value, 0),
  };
}

/**
 * Every dimension as a row with a sparkline, cycle-to-date total, and its
 * level values, laid out on one shared grid so cells align row to row. The
 * selected row expands and `renderChart` draws the full chart under it; the
 * open/close transition animates through a `grid-template-rows` tween.
 */
const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_72px_84px_180px_36px] items-center gap-3";

export function DimensionRows({ dimensions, levels, values, selected, onSelect, renderChart, accent = "#1a9c8c", label = "Usage dimensions", enabled, onToggle, levelEnabled }: {
  dimensions: DimensionSummary[];
  levels: LimitsChartLevel[];
  values: Record<string, LevelValues>;
  selected: string | null;
  onSelect(id: string): void;
  /** Chart for the selected row, rendered directly under it. */
  renderChart?(id: string): React.ReactNode;
  accent?: string;
  label?: string;
  /** id → monitored. Missing ids count as enabled. Rows get a switch when `onToggle` is set. */
  enabled?: Record<string, boolean>;
  onToggle?(id: string, next: boolean): void;
  /** id → levelId → active. Inactive levels render as dimmed chips. */
  levelEnabled?: Record<string, Record<string, boolean>>;
}) {
  return (
    <ul className="grid gap-1.5" aria-label={label}>
      {dimensions.map(dimension => {
        const on = enabled?.[dimension.id] ?? true;
        const open = on && dimension.id === selected;
        return (
          <li key={dimension.id} className={`rounded-panel border bg-panel transition-colors duration-200 ${open ? "border-line-strong" : "border-line"} ${on ? "" : "opacity-55"}`}>
            <div className={`relative ${ROW_GRID} px-3 py-2`}>
              {/* Whole-row expand target; the switch sits above it. */}
              <button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${dimension.label}`} disabled={!on} onClick={() => onSelect(dimension.id)} className="absolute inset-0 cursor-pointer rounded-panel disabled:cursor-default" />
              <span className="pointer-events-none relative min-w-0">
                <strong className="block truncate text-[12.5px]">{dimension.label}</strong>
                <small className="block text-[10.5px] text-faint">{dimension.unit}</small>
              </span>
              <Sparkline series={dimension.series} className={`pointer-events-none relative h-6 w-[72px] transition-opacity duration-200 ${open ? "opacity-0" : "opacity-100"}`} style={{ color: accent }} />
              <span className="pointer-events-none relative text-right text-[12.5px] font-[740] tabular-nums">
                {dimension.unit === "USD" ? formatLimitValue(dimension.cycleToDate, "USD") : formatNumber(dimension.cycleToDate)}
                <small className="block text-[10px] font-medium text-faint">this cycle</small>
              </span>
              <span className="pointer-events-none relative flex items-center justify-end gap-2">
                {levels.map(level => {
                  const levelOn = levelEnabled?.[dimension.id]?.[level.id] ?? true;
                  return (
                    <span key={level.id} className={`inline-flex items-center gap-1 text-[10.5px] tabular-nums text-muted ${levelOn ? "" : "opacity-40 line-through"}`} title={`${level.label} limit${levelOn ? "" : " (off)"}`}>
                      <i className="size-1.5 rotate-45 rounded-[1px]" style={{ background: level.color }} aria-hidden="true" />
                      {shortValue(values[dimension.id]?.[level.id])}
                    </span>
                  );
                })}
              </span>
              <span className="relative flex justify-end">
                {onToggle ? <MonitorSwitch label={dimension.label} on={on} onChange={next => onToggle(dimension.id, next)} /> : null}
              </span>
            </div>
            {renderChart && (
              <div className="grid transition-[grid-template-rows] duration-300 ease-out" style={{ gridTemplateRows: open ? "1fr" : "0fr" }} aria-hidden={!open}>
                <div className="min-h-0 overflow-hidden">
                  <div className={`px-3 pb-3 pt-1 transition-opacity duration-300 ${open ? "opacity-100" : "opacity-0"}`}>{open && renderChart(dimension.id)}</div>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function MonitorSwitch({ label, on, onChange }: { label: string; on: boolean; onChange(next: boolean): void }) {
  return (
    <label className="inline-flex cursor-pointer items-center" title={on ? "Monitored. Switch off to ignore this dimension." : "Not monitored."}>
      <span className="sr-only">Monitor {label}</span>
      <input type="checkbox" role="switch" checked={on} aria-checked={on} className="peer sr-only" onChange={event => onChange(event.target.checked)} />
      <span className="relative inline-block h-[18px] w-[32px] rounded-full bg-[#c3cad2] transition-colors peer-checked:bg-[#1a9c8c] peer-focus-visible:shadow-[0_0_0_3px_#f6821f33] dark:bg-[#505862] after:absolute after:top-[2px] after:left-[2px] after:size-[14px] after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-[14px]" aria-hidden="true" />
    </label>
  );
}

function shortValue(value: number | undefined): string {
  if (value === undefined) return "–";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function Sparkline({ series, className, style }: { series: DayPoint[]; className?: string; style?: React.CSSProperties }) {
  const points = useMemo(() => {
    const width = 84;
    const height = 24;
    const max = Math.max(1e-9, ...series.map(point => point.value));
    const step = width / Math.max(1, series.length - 1);
    return series.map((point, index) => `${(index * step).toFixed(1)},${(height - (point.value / max) * (height - 2) - 1).toFixed(1)}`).join(" ");
  }, [series]);
  return (
    <svg viewBox="0 0 84 24" className={className} style={style} aria-hidden="true" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
