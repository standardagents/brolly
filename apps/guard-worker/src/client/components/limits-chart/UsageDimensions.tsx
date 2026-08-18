import { useEffect, useMemo, useState } from "react";
import { number as formatNumber } from "../../format";
import type { UsageSeriesResponse } from "./api";
import { type CycleBounds, cycleIndexFor, type DayPoint } from "./cycles";
import { deriveSeries } from "./defaults";
import { type LevelValues, crossedLevel } from "./levels";
import { chooseAxis } from "./scale";
import { compactValue, editableValue, formatLimitValue, parseCompact, selectNumber, unitLabel, type LimitsChartLevel } from "./LimitsChart";

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
/**
 * Row layout follows the pair's container width (not the viewport): narrow
 * columns put the level chips on a second line; from 620px up everything
 * sits on one line.
 */
const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_84px_84px_36px] items-center gap-x-3 gap-y-1.5 @[640px]:grid-cols-[minmax(120px,240px)_120px_92px_minmax(0,1fr)_36px] @[640px]:gap-4";

export function DimensionRows({ dimensions, levels, values, selected, onSelect, renderChart, accent = "#1a9c8c", label = "Usage dimensions", enabled, onToggle, levelEnabled, onToggleLevel, onValueChange, window = "day", cycles, today }: {
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
  /** Toggle one alert level for one dimension through its diamond. */
  onToggleLevel?(id: string, levelId: string, next: boolean): void;
  /** Click-to-edit for the level chips. Omit to render them read-only. */
  onValueChange?(id: string, levelId: string, next: number): void;
  /** Mini chart mode: daily bars, or the running total per billing cycle. */
  window?: "day" | "cycle";
  cycles?: CycleBounds[];
  today?: string;
}) {
  return (
    <ul className="@container grid gap-1.5" aria-label={label}>
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
                <small className="block text-[10.5px] text-faint">{unitLabel(dimension.unit)}</small>
              </span>
              <MiniChart series={dimension.series} cycles={cycles} today={today} window={window} accent={accent}
                levels={levels.filter(level => levelEnabled?.[dimension.id]?.[level.id] ?? true)} values={values[dimension.id] ?? {}}
                className="pointer-events-none relative h-6 w-[84px] @[640px]:h-7 @[640px]:w-[120px]" />
              <span className="pointer-events-none relative text-right text-[12.5px] font-[740] tabular-nums">
                {dimension.unit === "USD" ? formatLimitValue(dimension.cycleToDate, "USD") : formatNumber(dimension.cycleToDate)}
                <small className="block text-[10px] font-medium text-faint">this cycle</small>
              </span>
              <span className="relative order-last col-span-4 flex flex-wrap items-center gap-x-3 gap-y-1 @[640px]:order-none @[640px]:col-span-1 @[640px]:pl-2">
                {levels.map(level => {
                  const levelOn = levelEnabled?.[dimension.id]?.[level.id] ?? true;
                  const value = values[dimension.id]?.[level.id];
                  return (
                    <LevelChip key={level.id} level={level} value={value} on={levelOn} unit={dimension.unit}
                      onToggle={onToggleLevel && on ? next => onToggleLevel(dimension.id, level.id, next) : undefined}
                      onCommit={onValueChange && on && levelOn && value !== undefined ? next => onValueChange(dimension.id, level.id, next) : undefined} />
                  );
                })}
              </span>
              <span className="relative flex justify-end">
                {onToggle ? <MonitorSwitch label={dimension.label} on={on} onChange={next => onToggle(dimension.id, next)} /> : null}
              </span>
            </div>
            {renderChart && <Expander open={open}>{renderChart(dimension.id)}</Expander>}
          </li>
        );
      })}
    </ul>
  );
}

const EXPAND_MS = 260;

/**
 * Height + opacity transition on one clock. The chart stays mounted while it
 * collapses, so open and close both animate over the same duration and the
 * closing row never snaps.
 */
export function Expander({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const timer = setTimeout(() => setMounted(false), EXPAND_MS);
    return () => clearTimeout(timer);
  }, [open]);
  return (
    <div className="grid" style={{ gridTemplateRows: open ? "1fr" : "0fr", transition: `grid-template-rows ${EXPAND_MS}ms cubic-bezier(.2,.7,.2,1)` }} aria-hidden={!open}>
      <div className="min-h-0 overflow-hidden">
        <div className="px-3 pb-3 pt-1" style={{ opacity: open ? 1 : 0, transition: `opacity ${EXPAND_MS}ms cubic-bezier(.2,.7,.2,1)` }}>
          {mounted && children}
        </div>
      </div>
    </div>
  );
}

export function MonitorSwitch({ label, on, onChange }: { label: string; on: boolean; onChange(next: boolean): void }) {
  return (
    <label className="inline-flex cursor-pointer items-center" title={on ? "Monitored. Switch off to ignore this dimension." : "Not monitored."}>
      <span className="sr-only">Monitor {label}</span>
      <input type="checkbox" role="switch" checked={on} aria-checked={on} className="peer sr-only" onChange={event => onChange(event.target.checked)} />
      <span className="relative inline-block h-[18px] w-[32px] rounded-full bg-[#c3cad2] transition-colors peer-checked:bg-[#1a9c8c] peer-focus-visible:shadow-[0_0_0_3px_#f6821f33] dark:bg-[#505862] after:absolute after:top-[2px] after:left-[2px] after:size-[14px] after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-[14px]" aria-hidden="true" />
    </label>
  );
}

/** One level value in a row: click to edit in place, Enter/blur commits, Escape cancels. */
export function LevelChip({ level, value, on, unit, onToggle, onCommit }: { level: LimitsChartLevel; value: number | undefined; on: boolean; unit: string; onToggle?(next: boolean): void; onCommit?(next: number): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = value === undefined ? "–" : compactValue(value, unit);
  const commit = () => {
    if (draft === null) return;
    const parsed = parseCompact(draft);
    setDraft(null);
    if (parsed !== null && parsed >= 0 && onCommit) onCommit(parsed);
  };
  return (
    <span className={`inline-flex items-center gap-1 text-[10.5px] tabular-nums text-muted ${on ? "" : "opacity-40 line-through"}`} title={`${level.label} limit${on ? "" : " (off)"}${onCommit ? " · click to edit" : ""}`}>
      {onToggle ? <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${on ? "Disable" : "Enable"} ${level.label} for this dimension`}
        className="size-3 flex-none cursor-pointer rounded-[2px] p-[3px] outline-none focus-visible:ring-2 focus-visible:ring-orange focus-visible:ring-offset-1"
        onClick={event => { event.stopPropagation(); onToggle(!on); }}
      ><i className="block size-1.5 rotate-45 rounded-[1px]" style={{ background: level.color }} aria-hidden="true" /></button>
        : <i className="size-1.5 rotate-45 rounded-[1px]" style={{ background: level.color }} aria-hidden="true" />}
      {onCommit ? (
        <input
          className="w-[5ch] rounded-[3px] border border-transparent bg-transparent px-0.5 text-[10.5px] tabular-nums text-muted outline-none hover:border-line focus:border-orange focus:bg-field focus:text-ink"
          style={{ width: `${Math.max(3, (draft ?? shown).length) + 1}ch` }}
          value={draft ?? shown}
          aria-label={`${level.label} limit`}
          inputMode="decimal"
          onFocus={event => { const text = editableValue(value ?? 0, unit); setDraft(text); selectNumber(event.target, text); }}
          onChange={event => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === "Enter") { event.preventDefault(); commit(); (event.target as HTMLInputElement).blur(); }
            if (event.key === "Escape") { setDraft(null); (event.target as HTMLInputElement).blur(); }
          }}
        />
      ) : shown}
    </span>
  );
}

/**
 * Miniature of the main chart: one thin bar per day, colored like the main
 * chart's bars (accent under every active line, the highest crossed level's
 * color above). In cycle mode the bars are the running total per billing
 * cycle, so the sawtooth and its level colors show at row scale.
 */
export function MiniChart({ series, cycles, today, window, levels, values, accent, className }: {
  series: DayPoint[];
  cycles?: CycleBounds[];
  today?: string;
  window: "day" | "cycle";
  levels: LimitsChartLevel[];
  values: LevelValues;
  accent: string;
  className?: string;
}) {
  const bars = useMemo(() => {
    const derived = deriveSeries(series, cycles, today);
    const points = window === "cycle" ? derived.cumulative.map(point => point.cumulative) : derived.dense.map(point => point.value);
    const levelValues = levels.map(level => values[level.id] ?? 0);
    // Same axis rule as the full chart: level values extend the domain and
    // the symlog switch depends on the same outlier test.
    const axis = chooseAxis(derived.heightValues, levelValues);
    const order = levels.map(level => level.id);
    const colorById = new Map(levels.map(level => [level.id, level.color]));
    const width = 120;
    const height = 28;
    const slot = width / Math.max(1, points.length);
    const yFor = (value: number) => height - axis.position(value) * (height - 1);
    return points.flatMap((point, index) => {
      const x = index * slot;
      const barWidth = Math.max(0.6, slot * 0.7);
      if (window === "day") {
        const crossed = crossedLevel(order, values, point);
        return [{ key: `${index}`, x, width: barWidth, y: yFor(point), height: Math.max(0.6, height - yFor(point)), color: (crossed && colorById.get(crossed)) || accent }];
      }
      // Cycle mode: stack the running total into value bands, like the full chart.
      const edges = [0, ...levelValues.map(value => Math.min(value, point)).filter(value => value > 0 && value < point), point];
      const bounds = [...new Set(edges)].sort((left, right) => left - right);
      return bounds.slice(1).map((top, segment) => {
        const bottom = bounds[segment]!;
        const crossed = crossedLevel(order, values, bottom + (top - bottom) / 2 + 1e-9);
        return { key: `${index}-${segment}`, x, width: barWidth, y: yFor(top), height: Math.max(0.4, yFor(bottom) - yFor(top)), color: (crossed && colorById.get(crossed)) || accent };
      });
    });
  }, [series, cycles, today, window, levels, values, accent]);
  return (
    <svg viewBox="0 0 120 28" className={className} aria-hidden="true" preserveAspectRatio="none">
      {bars.map(bar => <rect key={bar.key} x={bar.x} y={bar.y} width={bar.width} height={bar.height} fill={bar.color} opacity={window === "cycle" ? 0.82 : 1} />)}
    </svg>
  );
}
