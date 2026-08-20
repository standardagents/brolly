import { useEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type PointerEvent, type SetStateAction } from "react";
import { costSeries, useUsageSeries } from "../components/limits-chart/api";
import { cycleIndexFor, daysBetween } from "../components/limits-chart/cycles";
import { LevelValueField } from "../components/limits-chart/LevelValueField";
import { levelColor } from "../components/limits-chart/LimitsChart";
import { snapStep, snapToNice } from "../components/limits-chart/scale";
import { useElementWidth } from "../components/limits-chart/use-element-width";
import { Icon, Spinner } from "../components/ui";
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

export function RiskToleranceStep({ token, policy, levels, setPolicy, accountName = null, accountId = "" }: {
  token: string;
  policy: Policy;
  levels: AlertLevel[];
  setPolicy: Dispatch<SetStateAction<Policy>>;
  accountName?: string | null;
  accountId?: string;
}) {
  const usage = useUsageSeries(token, "account");
  const order = useMemo(() => levels.map(level => level.id), [levels]);
  const tolerance = normalizeRiskTolerance(policy.riskTolerance, order);
  // First render: a policy without tolerance starts on Balanced with the
  // Balanced values written into the policy, and a saved named preset whose
  // values no longer match its curve (older defaults) snaps back to it.
  useEffect(() => {
    if (!order.length) return;
    const saved = policy.riskTolerance;
    const preset = saved?.preset && saved.preset !== "custom" ? saved.preset : saved ? null : "balanced";
    if (!preset) return;
    const expected = tolerancePresetValues(preset, order);
    if (saved && order.every(id => saved.percentOfTypical?.[id] === expected[id])) return;
    commit(preset, expected);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the policy or level set changes
  }, [policy.riskTolerance, order]);
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
      Set how far above your usual daily spend each alert level starts. These become the starting limits for the next two steps, where you can adjust any of them.
    </StepIntro>
    <div className="grid grid-cols-[340px_minmax(0,1fr)] gap-8 max-lg:grid-cols-1">
      <BaselinePanel state={usage} series={series} typical={typical} windowDays={tolerance.baseline.windowDays} accountName={accountName} accountId={accountId} />
      <div className="flex min-w-0 flex-col">
        <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label="Risk tolerance preset">
          <span className="mr-1 text-[12px] font-[650] text-muted">Preset</span>
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
        <div className="flex flex-1 flex-col justify-center rounded-panel border border-line bg-panel px-5 py-4">
          <ToleranceTrack levels={chartLevels} value={tolerance.percentOfTypical} typical={typical} cycleDays={cycleDays} onChange={next => commit("custom", next)} />
        </div>
      </div>
    </div>
  </>;
}

/**
 * The number every level is measured against: the median of this account's
 * own daily spend over the window, with the days that produced it.
 */
function BaselinePanel({ state, series, typical, windowDays, accountName, accountId }: {
  state: { loading: boolean; error: string; data: { today: string } | null };
  series: Array<{ day: string; value: number }>;
  typical: number;
  windowDays: number;
  accountName: string | null;
  accountId: string;
}) {
  const account = accountName ?? (accountId ? shortId(accountId) : "");
  const today = state.data?.today;
  const windowed = useMemo(() => {
    if (!today) return [];
    const todayAt = Date.parse(`${today}T00:00:00Z`);
    const cutoff = todayAt - (windowDays - 1) * 86_400_000;
    return series.filter(point => { const at = Date.parse(`${point.day}T00:00:00Z`); return at >= cutoff && at <= todayAt; });
  }, [series, today, windowDays]);
  const daysWithSpend = windowed.filter(point => point.value > 0).length;
  const first = windowed[0]?.day;
  const last = windowed.at(-1)?.day;
  return (
    <section className="self-start rounded-panel border border-line bg-panel-soft p-4" aria-label="Your baseline">
      <p className="text-[10.5px] font-[700] uppercase tracking-[0.06em] text-faint">Your Cloudflare account</p>
      {account && <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[12.5px] font-[650] text-ink" title={accountName ?? accountId}><Icon name="layers" className="size-3.5 flex-none text-faint" /><span className="truncate">{account}</span></p>}
      {state.loading && <p className="mt-2 inline-flex items-center gap-2 text-[12.5px] text-muted"><Spinner /> Reading your account history…</p>}
      {!state.loading && state.error && <p className="mt-2 text-[12.5px] leading-[1.5] text-muted">Brolly could not read your account history. You can still set the percentages.</p>}
      {!state.loading && !state.error && typical > 0 && (
        <>
          <p className="mt-4 text-[10.5px] font-[700] uppercase tracking-[0.06em] text-faint">Usual daily spend</p>
          <p className="mt-1 text-[28px] font-[760] leading-none tracking-[-0.01em] text-ink tabular-nums">{money(typical)} <span className="text-[13px] font-[600] text-muted">per day</span></p>
          <p className="mt-3 text-[12.5px] leading-[1.55] text-muted">
            Brolly read {daysWithSpend} {daysWithSpend === 1 ? "day" : "days"} of spend from this account, {shortDate(first)} to {shortDate(last)}, and took the median.
          </p>
          <Sparkline points={windowed} median={typical} />
        </>
      )}
      {!state.loading && !state.error && typical === 0 && (
        <p className="mt-2 text-[12.5px] leading-[1.55] text-muted">Your account has no daily spend in the last {windowDays} days, so there is no baseline yet. Levels are saved as percentages and take effect once spend appears.</p>
      )}
    </section>
  );
}

/**
 * Daily spend bars for the window with the median drawn across them. The
 * scale clamps at three times the median so a spike cannot flatten the
 * baseline; clamped days are drawn to the top in a lighter tone and counted
 * in the caption.
 */
function Sparkline({ points, median }: { points: Array<{ day: string; value: number }>; median: number }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const height = 72;
  const max = median * 3 || 1;
  const clipped = points.filter(point => point.value > max).length;
  const slot = width / Math.max(1, points.length);
  const barWidth = Math.max(1, slot - 1);
  const y = (value: number) => height - (Math.min(value, max) / max) * (height - 14);
  return (
    <figure ref={ref} className="m-0 mt-4 w-full" aria-label={`Your daily spend for the last ${points.length} days`}>
      {width > 0 && (
        <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="block overflow-visible">
          {points.map((point, index) => (
            <rect key={point.day} x={index * slot} y={y(point.value)} width={barWidth} height={Math.max(0, height - y(point.value))} rx="0.5"
              className={point.value > max ? "fill-orange/25" : point.value > 0 ? "fill-orange/60" : "fill-line"} />
          ))}
          <line x1="0" x2={width} y1={y(median)} y2={y(median)} className="stroke-ink" strokeWidth="1.25" strokeDasharray="3 3" />
          <text x={width} y={y(median) - 4} textAnchor="end" className="fill-ink text-[10px] font-[700]">median {money(median)}</text>
        </svg>
      )}
      <figcaption className="mt-1 flex justify-between gap-3 text-[10px] text-faint">
        <span>{shortDate(points[0]?.day)}</span>
        <span className="truncate">{clipped > 0 ? `${clipped} ${clipped === 1 ? "day" : "days"} above ${money(max)} clipped` : "Daily spend"}</span>
        <span>{shortDate(points.at(-1)?.day)}</span>
      </figcaption>
    </figure>
  );
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function shortDate(day: string | undefined): string {
  if (!day) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
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
  // While dragging, values live here and the parent hears once on release
  // (the parent is the whole wizard; per-move updates re-render every step).
  // Moves are coalesced to one per frame and the track rect is measured once.
  const [dragValues, setDragValues] = useState<Record<string, number> | null>(null);
  const shown = dragValues ?? value;
  const dragBase = useRef<Record<string, number> | null>(null);
  const draggingRef = useRef<string | null>(null);
  const trackRect = useRef<DOMRect | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<{ id: string; clientX: number } | null>(null);
  // The visible maximum starts at TOLERANCE_AXIS_MAX and, once a drag is
  // released (never mid-drag), grows when a diamond sits near the right
  // edge and relaxes when everything sits well below it, up to the cap.
  const highest = Math.max(MIN_TOLERANCE_PERCENT, ...Object.values(shown));
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
  // While dragging the value follows the pointer continuously (no snap), so
  // the diamond glides; it snaps to a nice number on release.
  const percentAt = (clientX: number, snap: boolean) => {
    const rect = trackRect.current ?? svgRef.current?.getBoundingClientRect();
    if (!rect) return MIN_TOLERANCE_PERCENT;
    const x = ((clientX - rect.left) / rect.width) * width;
    const raw = trackPercent((x - pad) / trackWidth, max);
    return Math.max(MIN_TOLERANCE_PERCENT, snap ? snapToNice(raw, 1) : Math.round(raw * 10) / 10);
  };
  const change = (id: string, next: number) => onChange(changeToleranceValue(value, order, id, next));

  const flushDrag = () => {
    frame.current = null;
    const move = pending.current;
    if (!move) return;
    setDragValues(changeToleranceValue(dragBase.current ?? value, order, move.id, percentAt(move.clientX, false)));
  };
  const pointerDown = (id: string) => (event: PointerEvent<SVGElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    trackRect.current = svgRef.current?.getBoundingClientRect() ?? null;
    dragBase.current = value;
    draggingRef.current = id;
    setDragging(id);
    setDragValues(changeToleranceValue(value, order, id, percentAt(event.clientX, false)));
  };
  const pointerMove = (id: string) => (event: PointerEvent<SVGElement>) => {
    if (draggingRef.current !== id) return;
    pending.current = { id, clientX: event.clientX };
    if (frame.current === null) frame.current = requestAnimationFrame(flushDrag);
  };
  const pointerUp = (event: PointerEvent<SVGElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const last = pending.current;
    const active = draggingRef.current;
    const final = active
      ? changeToleranceValue(dragBase.current ?? value, order, active, percentAt(last?.clientX ?? event.clientX, true))
      : null;
    pending.current = null;
    trackRect.current = null;
    dragBase.current = null;
    draggingRef.current = null;
    setDragging(null);
    setDragValues(null);
    if (final) onChange(final);
  };
  const keyDown = (id: string) => (event: KeyboardEvent<SVGElement>) => {
    const current = shown[id] ?? MIN_TOLERANCE_PERCENT;
    const step = snapStep(current, 1) * (event.shiftKey ? 10 : 1);
    const jumps: Record<string, number> = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: step * 10, PageDown: -step * 10, Home: MIN_TOLERANCE_PERCENT - current, End: max - current };
    const delta = jumps[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    change(id, current + delta);
  };

  // Cards sit in one evenly spaced row under the track (so they never
  // overlap) and a connector line runs from each diamond to its card.
  const positions = levels.map(level => xFor(shown[level.id] ?? MIN_TOLERANCE_PERCENT));
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
        <text x={xFor(100)} y={trackY - 24} textAnchor="middle" className="fill-ink text-[10.5px] font-bold" style={{ transition: "x 240ms cubic-bezier(.2,.7,.2,1)" }}>{typical > 0 ? `Your daily average · ${money(typical)}` : "Your daily average"}</text>
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
          const percent = shown[level.id] ?? MIN_TOLERANCE_PERCENT;
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
        const percent = shown[level.id] ?? MIN_TOLERANCE_PERCENT;
        const daily = typical * percent / 100;
        return (
          <div key={level.id} className="absolute rounded-field border bg-panel px-2.5 py-2 shadow-panel" style={{ width: cardWidth, left: cardLeft(index), top: cardTop, borderColor: level.color }}>
            <div className="flex items-baseline justify-between gap-1">
              <span className="truncate text-[11.5px] font-bold" style={{ color: level.color }}>{level.label}</span>
              <span className="[&_[data-level-field]]:w-auto [&_[data-level-label]]:hidden">
                <LevelValueField level={level} unit="%" value={percent} enabled variant="bare" step={value => snapStep(value, 1)} onCommit={next => change(level.id, next)} />
              </span>
            </div>
            {typical > 0 && (
              <div className="mt-1 grid gap-0.5 text-[11px] tabular-nums text-muted">
                <span><b className="font-[740] text-ink">{money(daily)}</b> per day</span>
                <span><b className="font-[740] text-ink">{money(daily * cycleDays)}</b> per cycle</span>
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

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)}%`;
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value < 10 ? 2 : 0 }).format(value);
}
