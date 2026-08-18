import { useEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type PointerEvent, type SetStateAction } from "react";
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
    <ToleranceTrack levels={chartLevels} value={tolerance.percentOfTypical} typical={typical} cycleDays={cycleDays} onChange={next => commit("custom", next)} />
    {typical > 0
      ? <p className="mt-3 text-[11.5px] text-faint" aria-label="Risk tolerance estimates">Amounts are computed from your current {tolerance.baseline.windowDays}-day average account spend: {money(typical)} per day.</p>
      : <p className="mt-3 text-[11.5px] text-faint" aria-label="Risk tolerance estimates">Account history has no nonzero daily spend yet, so there are no amounts to show.</p>}
  </>;
}

/** Track geometry: linear from 0% to 100% over the first LINEAR_SHARE of the width, log above. */
const LINEAR_SHARE = 0.16;
const TRACK = { top: 44, height: 6, cards: 96 } as const;
const CARD_WIDTH = 168;
/** Axis ticks: 0, 50, then 1/2/5 × 10^n from 100% to the current maximum. */
function axisTicks(max: number): number[] {
  const ticks = [0, 50];
  for (let decade = 100; decade <= max; decade *= 10) for (const mantissa of [1, 2, 5]) if (mantissa * decade <= max) ticks.push(mantissa * decade);
  if (ticks.at(-1) !== max) ticks.push(max);
  return ticks;
}

/** Smallest nice maximum at or above `base` that keeps `highest` under 92% of the track, capped at MAX_TOLERANCE_PERCENT. */
export function fitAxisMax(base: number, highest: number): number {
  let max = Math.max(TOLERANCE_AXIS_MAX, base);
  while (trackPosition(highest, max) > 0.92 && max < MAX_TOLERANCE_PERCENT) max = Math.min(MAX_TOLERANCE_PERCENT, nextNice(max));
  return max;
}

function nextNice(value: number): number {
  const decade = 10 ** Math.floor(Math.log10(value));
  const mantissa = value / decade;
  return mantissa < 2 ? 2 * decade : mantissa < 5 ? 5 * decade : 10 * decade;
}

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
export function ToleranceTrack({ levels, value, typical, cycleDays, onChange }: {
  levels: Array<{ id: string; label: string; color: string }>;
  value: Record<string, number>;
  /** Typical daily spend; 0 hides the amounts. */
  typical: number;
  cycleDays: number;
  onChange: (next: Record<string, number>) => void;
}) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const order = useMemo(() => levels.map(level => level.id), [levels]);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // The visible maximum starts at TOLERANCE_AXIS_MAX and, once a drag is
  // released (never mid-drag), grows when a diamond sits near the right
  // edge and relaxes when everything sits well below it, up to the cap.
  const highest = Math.max(MIN_TOLERANCE_PERCENT, ...Object.values(value));
  const [axisMax, setAxisMax] = useState(() => fitAxisMax(TOLERANCE_AXIS_MAX, highest));
  const max = axisMax;
  useEffect(() => {
    if (dragging) return;
    setAxisMax(current => {
      if (trackPosition(highest, current) > 0.92) return fitAxisMax(current, highest);
      if (current > TOLERANCE_AXIS_MAX && trackPosition(highest, TOLERANCE_AXIS_MAX) < 0.85) return fitAxisMax(TOLERANCE_AXIS_MAX, highest);
      return current;
    });
  }, [highest, dragging]);
  const pad = 14;
  const trackWidth = Math.max(120, width - pad * 2);
  const xFor = (percent: number) => pad + trackPosition(percent, max) * trackWidth;
  const percentAt = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return MIN_TOLERANCE_PERCENT;
    const x = ((clientX - rect.left) / rect.width) * width;
    return Math.max(MIN_TOLERANCE_PERCENT, snapToNice(trackPercent((x - pad) / trackWidth, max), 1));
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

  // Cards sit in one evenly spaced row under the track (so they never
  // overlap) and a connector line runs from each diamond to its card.
  const positions = levels.map(level => xFor(value[level.id] ?? MIN_TOLERANCE_PERCENT));
  const columns = Math.max(1, levels.length);
  const gap = 12;
  const cardWidth = Math.min(CARD_WIDTH, Math.max(96, (width - gap * (columns - 1)) / columns));
  const rowWidth = columns * cardWidth + (columns - 1) * gap;
  const rowLeft = (width - rowWidth) / 2;
  const cardLeft = (index: number) => rowLeft + index * (cardWidth + gap);
  const trackY = TRACK.top;
  const cardTop = trackY + TRACK.height + 44;
  const height = cardTop + TRACK.cards;

  return (
    <div ref={containerRef} className="relative min-w-0 select-none" style={{ height }}>
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 block h-full w-full touch-none overflow-visible" role="group" aria-label="Percent of daily historical average by alert level">
        {/* Axis labels */}
        {axisTicks(max).map(tick => (
          <text key={tick} x={xFor(tick)} y={trackY - 8} style={{ transition: "x 240ms cubic-bezier(.2,.7,.2,1)" }} textAnchor={tick === 0 ? "start" : tick >= max ? "end" : "middle"} className={`text-[10.5px] tabular-nums ${tick === 100 ? "fill-ink font-bold" : "fill-faint"}`}>{formatPercent(tick)}</text>
        ))}
        <text x={xFor(100)} y={trackY - 24} textAnchor="middle" className="fill-muted text-[10.5px] font-bold" style={{ transition: "x 240ms cubic-bezier(.2,.7,.2,1)" }}>Daily historical average</text>
        {/* Track: neutral base, tinted segment per level from its diamond to the next */}
        <rect x={pad} y={trackY} width={trackWidth} height={TRACK.height} rx={TRACK.height / 2} className="fill-line-soft" />
        {levels.map((level, index) => {
          const start = positions[index]!;
          const end = index + 1 < positions.length ? positions[index + 1]! : pad + trackWidth;
          return <rect key={level.id} x={start} y={trackY} width={Math.max(0, end - start)} height={TRACK.height} fill={level.color} opacity=".85" style={{ transition: dragging ? "none" : "x 240ms cubic-bezier(.2,.7,.2,1), width 240ms cubic-bezier(.2,.7,.2,1)" }} />;
        })}
        {/* Heavy tick at the average */}
        <rect x={xFor(100) - 1} y={trackY - 6} width="2" height={TRACK.height + 12} className="fill-ink" style={{ transition: "x 240ms cubic-bezier(.2,.7,.2,1)" }} />
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
              <path d={connector(x, y + 11, cardLeft(index) + cardWidth / 2, cardTop)} fill="none" stroke={level.color} strokeWidth="1.25" opacity=".6"
                style={{ d: `path("${connector(x, y + 11, cardLeft(index) + cardWidth / 2, cardTop)}")`, transition: dragging === level.id ? "none" : "d 240ms cubic-bezier(.2,.7,.2,1)" } as React.CSSProperties} />
              <g style={{ transform: `translate(${x}px, ${y}px)`, transition: dragging === level.id ? "none" : "transform 240ms cubic-bezier(.2,.7,.2,1)" }}>
                <circle r="14" fill="transparent" />
                <polygon points="0,-9 9,0 0,9 -9,0" fill={level.color} stroke="var(--panel)" strokeWidth="2" />
              </g>
            </g>
          );
        })}
      </svg>
      {/* Cards: name, editable percentage, and amounts under each diamond */}
      {levels.map((level, index) => {
        const percent = value[level.id] ?? MIN_TOLERANCE_PERCENT;
        const daily = typical * percent / 100;
        return (
          <div key={level.id} className="absolute rounded-field border bg-panel px-2.5 py-2 shadow-panel" style={{ width: cardWidth, left: cardLeft(index), top: cardTop, borderColor: level.color }}>
            <div className="flex items-baseline justify-between gap-1">
              <span className="truncate text-[11.5px] font-bold" style={{ color: level.color }}>{level.label}</span>
              <PercentField label={level.label} value={percent} onCommit={next => change(level.id, next)} />
            </div>
            {typical > 0 && (
              <div className="mt-1 grid gap-0.5 text-[11px] tabular-nums text-muted">
                <span><b className="font-[740] text-ink">{money(daily)}</b> / day</span>
                <span><b className="font-[740] text-ink">{money(daily * cycleDays)}</b> / cycle</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** S-curve from a diamond to the top center of its card. Diamonds and cards share an order, so curves never cross. */
function connector(x1: number, y1: number, x2: number, y2: number): string {
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
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
