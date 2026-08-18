import { useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type PointerEvent, type SetStateAction } from "react";
import { costSeries, useUsageSeries } from "../components/limits-chart/api";
import { cycleIndexFor, daysBetween } from "../components/limits-chart/cycles";
import { levelColor } from "../components/limits-chart/LimitsChart";
import { snapStep, snapToNice } from "../components/limits-chart/scale";
import { useElementWidth } from "../components/limits-chart/use-element-width";
import { Spinner } from "../components/ui";
import type { AlertLevel, Policy, RiskTolerancePreset } from "../types";
import { StepIntro } from "./BudgetSteps";
import {
  changeToleranceValue,
  MAX_TOLERANCE_PERCENT,
  MIN_TOLERANCE_PERCENT,
  normalizeRiskTolerance,
  RISK_TOLERANCE_WINDOW_DAYS,
  TOLERANCE_AXIS_MAX,
  tolerancePresetValues,
  typicalDay,
} from "./risk-tolerance";

const PRESETS: Array<{ id: Exclude<RiskTolerancePreset, "custom">; label: string }> = [
  { id: "conservative", label: "Conservative" },
  { id: "balanced", label: "Balanced" },
  { id: "growth", label: "Growth" },
];

export function RiskToleranceStep({ token, policy, levels, setPolicy }: {
  token: string;
  policy: Policy;
  levels: AlertLevel[];
  setPolicy: Dispatch<SetStateAction<Policy>>;
}) {
  const usage = useUsageSeries(token, "account");
  const order = useMemo(() => levels.map(level => level.id), [levels]);
  const tolerance = normalizeRiskTolerance(policy.riskTolerance, order);
  const series = usage.data ? costSeries(usage.data) : [];
  const typical = usage.data ? typicalDay(series, usage.data.today, tolerance.baseline.windowDays) : 0;
  const cycleDays = useMemo(() => {
    if (!usage.data) return 30;
    const current = cycleIndexFor(usage.data.cycles, usage.data.today);
    const cycle = usage.data.cycles[current] ?? usage.data.cycles.at(-1);
    return cycle ? daysBetween(cycle.startsAt, cycle.endsAt) : 30;
  }, [usage.data]);
  const chartLevels = levels.map((level, index) => ({ id: level.id, label: level.label, color: levelColor(index, levels.length) }));

  const commit = (preset: RiskTolerancePreset, percentOfTypical: Record<string, number>) => {
    setPolicy(current => ({
      ...current,
      riskTolerance: {
        preset,
        percentOfTypical,
        baseline: { computedAt: Date.now(), windowDays: RISK_TOLERANCE_WINDOW_DAYS },
      },
    }));
  };

  return <>
    <StepIntro title="Risk tolerance">
      How far above your daily historical average each alert should sit. This sets every starting limit. You can fine-tune each limit on the next steps.
    </StepIntro>
    <div className="mb-6 flex flex-wrap items-center gap-2" role="group" aria-label="Risk tolerance preset">
      {PRESETS.map(preset => (
        <button
          key={preset.id}
          type="button"
          aria-pressed={tolerance.preset === preset.id}
          className={`rounded-field border px-3.5 py-2 text-[12.5px] font-bold transition-colors ${tolerance.preset === preset.id ? "border-orange bg-orange-soft text-orange-deep" : "border-line bg-panel-soft text-muted hover:border-orange hover:text-ink"}`}
          onClick={() => commit(preset.id, tolerancePresetValues(preset.id, order))}
        >{preset.label}</button>
      ))}
      {tolerance.preset === "custom" && <span className="ml-1 rounded-full bg-chip px-2.5 py-1 text-[11.5px] font-bold text-chip-ink">Custom</span>}
    </div>
    {usage.loading && <div className="mb-4 inline-flex items-center gap-2 text-[12.5px] text-muted"><Spinner /> Loading account history…</div>}
    {usage.error && <p className="mb-4 text-[12.5px] text-muted">Account history is unavailable. Percentages can still be configured.</p>}
    <ToleranceTrack levels={chartLevels} value={tolerance.percentOfTypical} onChange={next => commit("custom", next)} />
    <section className="mt-8" aria-label="Risk tolerance estimates">
      <h3 className="mb-2 text-[11px] font-extrabold uppercase tracking-[.08em] text-faint">At your current account spend</h3>
      {typical > 0 ? (
        <table className="w-max max-w-full text-[13px] tabular-nums">
          <tbody>
            {chartLevels.map(level => {
              const daily = typical * (tolerance.percentOfTypical[level.id] ?? 0) / 100;
              return (
                <tr key={level.id}>
                  <td className="py-1 pr-3"><i className="inline-block size-2 rotate-45 rounded-[1px]" style={{ background: level.color }} aria-hidden="true" /></td>
                  <td className="py-1 pr-6 font-bold text-ink">{level.label}</td>
                  <td className="py-1 pr-6 text-right"><span className="font-[740] text-ink">{money(daily)}</span> <span className="text-faint">/ day</span></td>
                  <td className="py-1 text-right"><span className="font-[740] text-ink">{money(daily * cycleDays)}</span> <span className="text-faint">/ cycle</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="text-[12.5px] text-muted">Account history has no nonzero daily spend yet, so there is nothing to estimate.</p>
      )}
    </section>
  </>;
}

/** Track geometry: linear from 0% to 100% over the first LINEAR_SHARE of the width, log above. */
const LINEAR_SHARE = 0.16;
const TRACK = { top: 44, height: 6, captions: 74 } as const;
const AXIS_TICKS = [0, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000];

export function trackPosition(percent: number, max = TOLERANCE_AXIS_MAX): number {
  if (percent <= 0) return 0;
  if (percent <= 100) return (percent / 100) * LINEAR_SHARE;
  const span = Math.log10(max / 100);
  return Math.min(1, LINEAR_SHARE + (Math.log10(percent / 100) / span) * (1 - LINEAR_SHARE));
}

export function trackPercent(position: number, max = TOLERANCE_AXIS_MAX): number {
  const clamped = Math.min(1, Math.max(0, position));
  if (clamped <= LINEAR_SHARE) return (clamped / LINEAR_SHARE) * 100;
  const span = Math.log10(max / 100);
  return 100 * 10 ** (((clamped - LINEAR_SHARE) / (1 - LINEAR_SHARE)) * span);
}

/**
 * One horizontal track, 0% to 10,000% of the daily historical average, with
 * a diamond per level. Diamonds push each other and never cross. Each
 * level's name and editable percentage hang under its diamond.
 */
export function ToleranceTrack({ levels, value, onChange }: {
  levels: Array<{ id: string; label: string; color: string }>;
  value: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
}) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const order = useMemo(() => levels.map(level => level.id), [levels]);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const max = Math.max(TOLERANCE_AXIS_MAX, ...Object.values(value));
  const pad = 14;
  const trackWidth = Math.max(120, width - pad * 2);
  const xFor = (percent: number) => pad + trackPosition(percent, max) * trackWidth;
  const percentAt = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return MIN_TOLERANCE_PERCENT;
    const x = ((clientX - rect.left) / rect.width) * width;
    return snapToNice(Math.max(MIN_TOLERANCE_PERCENT, trackPercent((x - pad) / trackWidth, max)), 1);
  };
  const change = (id: string, next: number) => onChange(changeToleranceValue(value, order, id, next));

  const pointerDown = (id: string) => (event: PointerEvent<SVGElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(id);
    change(id, percentAt(event.clientX));
  };
  const pointerMove = (id: string) => (event: PointerEvent<SVGElement>) => {
    if (dragging === id) change(id, percentAt(event.clientX));
  };
  const pointerUp = (event: PointerEvent<SVGElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(null);
  };
  const keyDown = (id: string) => (event: KeyboardEvent<SVGElement>) => {
    const current = value[id] ?? MIN_TOLERANCE_PERCENT;
    const step = snapStep(current, 1) * (event.shiftKey ? 10 : 1);
    const jumps: Record<string, number> = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: step * 10, PageDown: -step * 10, Home: MIN_TOLERANCE_PERCENT - current, End: max - current };
    const delta = jumps[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    change(id, current + delta);
  };

  // Captions alternate rows when neighbors sit closer than a caption's width.
  const positions = levels.map(level => xFor(value[level.id] ?? MIN_TOLERANCE_PERCENT));
  const rows = positions.map((x, index) => (index > 0 && x - positions[index - 1]! < 84 && (index % 2 === 1) ? 1 : 0));
  const stagger = rows.some(Boolean);
  const trackY = TRACK.top;
  const height = trackY + TRACK.height + TRACK.captions + (stagger ? 40 : 0);

  return (
    <div ref={containerRef} className="relative min-w-0 select-none" style={{ height }}>
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 block h-full w-full touch-none overflow-visible" role="group" aria-label="Percent of daily historical average by alert level">
        {/* Axis labels */}
        {AXIS_TICKS.filter(tick => tick <= max).map(tick => (
          <text key={tick} x={xFor(tick)} y={trackY - 8} textAnchor={tick === 0 ? "start" : tick >= max ? "end" : "middle"} className={`text-[10.5px] tabular-nums ${tick === 100 ? "fill-ink font-bold" : "fill-faint"}`}>{formatPercent(tick)}</text>
        ))}
        <text x={xFor(100)} y={trackY - 24} textAnchor="middle" className="fill-muted text-[10.5px] font-bold">Daily historical average</text>
        {/* Track: neutral base, tinted segment per level from its diamond to the next */}
        <rect x={pad} y={trackY} width={trackWidth} height={TRACK.height} rx={TRACK.height / 2} className="fill-line-soft" />
        {levels.map((level, index) => {
          const start = positions[index]!;
          const end = index + 1 < positions.length ? positions[index + 1]! : pad + trackWidth;
          return <rect key={level.id} x={start} y={trackY} width={Math.max(0, end - start)} height={TRACK.height} fill={level.color} opacity=".85" />;
        })}
        {/* Heavy tick at the average */}
        <rect x={xFor(100) - 1} y={trackY - 6} width="2" height={TRACK.height + 12} className="fill-ink" />
        {/* Diamonds */}
        {levels.map((level, index) => {
          const percent = value[level.id] ?? MIN_TOLERANCE_PERCENT;
          const x = positions[index]!;
          const y = trackY + TRACK.height / 2;
          return (
            <g key={level.id}
              role="slider"
              tabIndex={0}
              aria-label={`${level.label} risk tolerance`}
              aria-valuemin={MIN_TOLERANCE_PERCENT}
              aria-valuemax={MAX_TOLERANCE_PERCENT}
              aria-valuenow={percent}
              aria-valuetext={formatPercent(percent)}
              aria-orientation="horizontal"
              className="cursor-ew-resize outline-none focus-visible:[&>polygon]:stroke-ink focus-visible:[&>polygon]:stroke-[2.5]"
              onPointerDown={pointerDown(level.id)}
              onPointerMove={pointerMove(level.id)}
              onPointerUp={pointerUp}
              onPointerCancel={pointerUp}
              onKeyDown={keyDown(level.id)}
            >
              <title>{`${level.label} · ${formatPercent(percent)}`}</title>
              <circle cx={x} cy={y} r="14" fill="transparent" />
              <polygon points={`${x},${y - 9} ${x + 9},${y} ${x},${y + 9} ${x - 9},${y}`} fill={level.color} stroke="var(--panel)" strokeWidth="2" />
              <line x1={x} x2={x} y1={y + 12} y2={trackY + TRACK.height + 18 + rows[index]! * 40} stroke={level.color} strokeWidth="1" opacity=".5" />
            </g>
          );
        })}
      </svg>
      {/* Captions: name and editable percentage under each diamond */}
      {levels.map((level, index) => (
        <div key={level.id} className="absolute w-[92px] -translate-x-1/2 text-center" style={{ left: positions[index]!, top: trackY + TRACK.height + 20 + rows[index]! * 40 }}>
          <div className="truncate text-[11.5px] font-bold" style={{ color: level.color }}>{level.label}</div>
          <PercentField label={level.label} value={value[level.id] ?? MIN_TOLERANCE_PERCENT} onCommit={next => change(level.id, next)} />
        </div>
      ))}
    </div>
  );
}

function PercentField({ label, value, onCommit }: { label: string; value: number; onCommit: (next: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Math.round(value));
  const commit = () => {
    if (draft === null) return;
    const next = Number(draft.replace(/[% ,]/g, ""));
    setDraft(null);
    if (Number.isFinite(next)) onCommit(next);
  };
  return (
    <span className="inline-flex items-baseline justify-center gap-0.5 rounded-[4px] border border-transparent px-1 text-[15px] font-[740] tabular-nums text-ink hover:border-line focus-within:border-orange focus-within:bg-field">
      <input
        className="min-w-[2ch] border-0 bg-transparent text-right text-[15px] font-[740] tabular-nums text-ink outline-none"
        style={{ width: `${Math.max(2, shown.length) + 0.5}ch` }}
        aria-label={`${label} percent of typical`}
        inputMode="decimal"
        value={shown}
        onFocus={event => { setDraft(String(Math.round(value))); event.target.select(); }}
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur(); }
          if (event.key === "Escape") { setDraft(null); event.currentTarget.blur(); }
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const step = snapStep(value, 1) * (event.shiftKey ? 10 : 1);
            const next = value + (event.key === "ArrowUp" ? step : -step);
            setDraft(String(Math.round(next)));
            onCommit(next);
          }
        }}
      />
      <span className="text-[11px] font-medium text-faint">%</span>
    </span>
  );
}

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)}%`;
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value < 10 ? 2 : 0 }).format(value);
}
