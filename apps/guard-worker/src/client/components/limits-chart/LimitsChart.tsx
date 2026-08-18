import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { money, number as formatNumber } from "../../format";
import { type CycleBounds, type DayPoint, cycleCumulative, dayStart, denseSeries, monthlyCycles, projectCycle, visibleWindow } from "./cycles";
import { type LevelValues, completeLevels, crossedLevel, pushLevels } from "./levels";
import { type Axis, chooseAxis, niceLadder, snapStep, snapToNice } from "./scale";
import { useElementWidth } from "./use-element-width";

export interface LimitsChartLevel { id: string; label: string; color: string }

export interface LimitsChartProps {
  kind: "cost" | "usage";
  /** "USD" or a usage unit label such as "requests" or "GB-s". */
  unit: string;
  window: "day" | "cycle";
  /** Per-day values, ascending by day. Gaps are rendered as zero. */
  series: DayPoint[];
  /** Billing cycle bounds. When empty, UTC calendar months are used. */
  cycles?: CycleBounds[];
  /** ISO day of "today"; defaults to the last day in the series. */
  today?: string;
  /** Levels in board order, lowest severity first. */
  levels: LimitsChartLevel[];
  /** levelId → threshold. Missing ids get computed defaults on first render. */
  value: LevelValues;
  /** levelId → minimum allowed value (cycle limits stay ≥ daily limits). */
  floor?: LevelValues;
  /** levelId → suggested value for levels that have no saved value yet. */
  seed?: LevelValues;
  onChange(next: LevelValues): void;
  readOnly?: boolean;
  /** Accessible name for the chart. */
  label?: string;
}

const PLOT = { left: 62, right: 14, top: 12, bottom: 28, height: 250 } as const;
/** Bar accents sit outside the warm level ramp: cool blue for cost, teal for usage. */
const ACCENT = { cost: "#2f6fd6", usage: "#1a9c8c" } as const;
/** Level ramp, lowest to highest severity: amber → red → magenta → deep plum. */
const LEVEL_PALETTE = ["#e79021", "#e0632a", "#c9412c", "#a8232f", "#8c1d45", "#701a58", "#521a5c", "#3a1748"];

/** Default color for a level by board position, so any level count reads as an ordered ramp. */
export function levelColor(index: number, count: number): string {
  if (count <= 1) return LEVEL_PALETTE[2]!;
  const step = (LEVEL_PALETTE.length - 1) / Math.max(1, count - 1);
  return LEVEL_PALETTE[Math.min(LEVEL_PALETTE.length - 1, Math.round(index * step))]!;
}

export function formatLimitValue(value: number, unit: string): string {
  if (unit === "USD") return money(value);
  return `${formatNumber(value)} ${unit}`;
}

export function LimitsChart({ kind, unit, window: limitWindow, series, cycles: cyclesProp, today: todayProp, levels, value, floor, seed, onChange, readOnly = false, label }: LimitsChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const patternId = useId();
  const order = useMemo(() => levels.map(level => level.id), [levels]);
  const today = todayProp ?? series.at(-1)?.day ?? new Date().toISOString().slice(0, 10);
  const cycles = useMemo(
    () => (cyclesProp?.length ? cyclesProp : monthlyCycles(series[0]?.day ?? today, today)),
    [cyclesProp, series, today],
  );
  const window = useMemo(() => visibleWindow(series, cycles, today), [series, cycles, today]);
  const dense = useMemo(() => denseSeries(series, window.fromDay, window.toDay), [series, window]);
  const cumulative = useMemo(() => cycleCumulative(dense, cycles), [dense, cycles]);
  const projection = useMemo(() => projectCycle(dense, cycles, today), [dense, cycles, today]);
  const observedMax = useMemo(() => Math.max(0, ...dense.map(point => point.value)), [dense]);
  const seriesValues = useMemo(() => dense.map(point => point.value), [dense]);
  const heightValues = useMemo(() => [
    ...seriesValues, ...cumulative.map(point => point.cumulative), projection?.projected ?? 0,
  ], [seriesValues, cumulative, projection]);

  // The axis extends to keep every level visible, but stays frozen while a
  // handle is dragged so the chart does not rescale under the pointer.
  const [frozenAxis, setFrozenAxis] = useState<Axis | null>(null);
  const liveAxis = useMemo(() => chooseAxis(heightValues, order.map(id => value[id] ?? 0)), [heightValues, order, value]);
  const axis = frozenAxis ?? liveAxis;

  // Fill in defaults for levels that have no value yet. The defaults are
  // pushed on an axis that already contains the default ladder, so a ladder
  // above today's data does not get clamped to the top of the chart.
  const complete = useMemo(() => {
    const ladder = niceLadder(observedMax, order.length);
    const defaultsAxis = chooseAxis(heightValues, [...order.map(id => value[id] ?? 0), ...ladder, ...Object.values(floor ?? {}), ...Object.values(seed ?? {})]);
    return completeLevels(defaultsAxis, order, value, observedMax, floor, seed);
  }, [heightValues, order, value, observedMax, floor, seed]);
  useEffect(() => {
    if (order.some(id => complete[id] !== value[id])) onChange(complete);
  }, [complete, order, value, onChange]);

  const plotWidth = Math.max(80, width - PLOT.left - PLOT.right);
  const plotHeight = PLOT.height - PLOT.top - PLOT.bottom;
  const yFor = (item: number) => PLOT.top + (1 - axis.position(item)) * plotHeight;
  const valueForY = (y: number) => axis.invert(1 - (y - PLOT.top) / plotHeight);
  // Reserve room for the rest of the current cycle so the projection has
  // somewhere to go.
  const remainingDays = projection ? Math.max(0, projection.totalDays - projection.elapsedDays) : 0;
  const barSlot = plotWidth / Math.max(1, dense.length + remainingDays);
  const barWidth = Math.max(1.5, barSlot * 0.62);
  const xFor = (index: number) => PLOT.left + index * barSlot + barSlot / 2;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // While a handle is dragged, values live here and the parent hears about
  // the result once on release. Pointer moves are coalesced to one update
  // per animation frame.
  const [dragValues, setDragValues] = useState<LevelValues | null>(null);
  const shown = dragValues ?? complete;
  const frame = useRef<number | null>(null);
  const pending = useRef<{ id: string; clientY: number } | null>(null);
  const svgRect = useRef<DOMRect | null>(null);

  const commit = (id: string, next: number) => {
    onChange(pushLevels(axis, order, complete, id, next, floor));
  };

  const valueAtClientY = (clientY: number) => {
    const rect = svgRect.current ?? svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const y = ((clientY - rect.top) / rect.height) * PLOT.height;
    return snapToNice(valueForY(y));
  };

  const flushDrag = () => {
    frame.current = null;
    const move = pending.current;
    if (!move) return;
    const next = valueAtClientY(move.clientY);
    if (next === null) return;
    setDragValues(current => pushLevels(axis, order, current ?? complete, move.id, next, floor));
  };

  const startDrag = (id: string) => (event: PointerEvent<SVGElement>) => {
    if (readOnly) return;
    event.preventDefault();
    (event.currentTarget as SVGElement).setPointerCapture?.(event.pointerId);
    svgRect.current = svgRef.current?.getBoundingClientRect() ?? null;
    setFrozenAxis(axis);
    setDragValues(complete);
    setDragging(id);
  };
  const moveDrag = (id: string) => (event: PointerEvent<SVGElement>) => {
    if (dragging !== id) return;
    pending.current = { id, clientY: event.clientY };
    if (frame.current === null) frame.current = requestAnimationFrame(flushDrag);
  };
  const endDrag = (id: string) => (event: PointerEvent<SVGElement>) => {
    if (dragging !== id) return;
    (event.currentTarget as SVGElement).releasePointerCapture?.(event.pointerId);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const last = pending.current ? valueAtClientY(pending.current.clientY) : null;
    pending.current = null;
    svgRect.current = null;
    const final = last === null ? dragValues ?? complete : pushLevels(axis, order, dragValues ?? complete, id, last, floor);
    setDragging(null);
    setDragValues(null);
    setFrozenAxis(null);
    onChange(final);
  };
  const keyStep = (id: string) => (event: KeyboardEvent<SVGElement>) => {
    if (readOnly) return;
    const current = complete[id] ?? 0;
    const step = snapStep(current) * (event.shiftKey ? 10 : 1);
    const jumps: Record<string, number> = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: step * 10, PageDown: -step * 10 };
    const delta = jumps[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    commit(id, Math.max(0, current + delta));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- xFor/yFor derive from axis, plotWidth, and barSlot
  const sawtooth = useMemo(() => cyclePolygons(cumulative, xFor, yFor, PLOT.top + plotHeight, barSlot), [cumulative, axis, plotWidth, plotHeight, barSlot]);
  const barTitles = useMemo(
    () => dense.map((point, index) => `${dayLabel(point.day)} · ${formatLimitValue(point.value, unit)} · cycle to date ${formatLimitValue(cumulative[index]?.cumulative ?? 0, unit)}`),
    [dense, cumulative, unit],
  );
  const cycleMode = limitWindow === "cycle";
  // Horizontal color bands for the cycle sawtooth: accent under the lowest
  // line, then each level's color up to the next line, the top one open.
  const bands = useMemo(() => {
    const edges = order.map(id => ({ id, value: shown[id] ?? 0 }));
    const list: Array<{ id: string; color: string; bottom: number; top: number }> = [{ id: "base", color: ACCENT[kind], bottom: 0, top: edges[0]?.value ?? Number.POSITIVE_INFINITY }];
    edges.forEach((edge, index) => list.push({ id: edge.id, color: levels[index]?.color ?? ACCENT[kind], bottom: edge.value, top: edges[index + 1]?.value ?? Number.POSITIVE_INFINITY }));
    return list;
  }, [order, shown, levels, kind]);
  const colorById = useMemo(() => new Map(levels.map(level => [level.id, level.color])), [levels]);
  const cycleStarts = cycles.filter(cycle => cycle.startsAt > dayStart(window.fromDay) && cycle.startsAt <= dayStart(window.toDay));
  const indexForDay = new Map(dense.map((point, index) => [point.day, index]));
  const accent = ACCENT[kind];
  const chartLabel = label ?? `${kind === "cost" ? "Cost" : "Usage"} per ${limitWindow === "day" ? "day" : "billing cycle"}`;

  return (
    <div ref={containerRef} className="min-w-0 select-none" data-limits-chart={kind}>
      <svg
        ref={svgRef}
        className="block w-full touch-none overflow-visible text-ink"
        style={{ height: PLOT.height }}
        viewBox={`0 0 ${width} ${PLOT.height}`}
        role="group"
        aria-label={chartLabel}
      >
        <defs>
          <pattern id={`${patternId}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="1" opacity=".22" />
          </pattern>
        </defs>
        {/* Axes */}
        <line x1={PLOT.left} x2={PLOT.left} y1={PLOT.top} y2={PLOT.top + plotHeight} className="stroke-line-strong" />
        <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={PLOT.top + plotHeight} y2={PLOT.top + plotHeight} className="stroke-line-strong" />
        {/* Y ticks */}
        {axis.ticks.map(tick => (
          <g key={tick}>
            {tick > 0 && <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={yFor(tick)} y2={yFor(tick)} className="stroke-line-soft" strokeDasharray="2 5" />}
            <text x={PLOT.left - 10} y={yFor(tick) + 3.5} textAnchor="end" className="fill-faint text-[10.5px] tabular-nums">{formatTick(tick, unit)}</text>
          </g>
        ))}

        {/* Cumulative sawtooth per cycle */}
        {cycleMode ? (
          // Cycle step: the running total is the primary mark. Each horizontal
          // band between two level lines paints the total in that level's
          // color; the band under the lowest line keeps the accent.
          <>
            <defs>
              {bands.map(band => (
                <clipPath key={band.id} id={`${patternId}-band-${band.id}`}>
                  <rect x={PLOT.left} width={plotWidth} y={Number.isFinite(band.top) ? yFor(band.top) : PLOT.top} height={Math.max(0, yFor(band.bottom) - (Number.isFinite(band.top) ? yFor(band.top) : PLOT.top))} />
                </clipPath>
              ))}
            </defs>
            {bands.map(band => sawtooth.map((points, index) => (
              <polygon key={`${band.id}-${index}`} points={points} fill={band.color} opacity=".82" clipPath={`url(#${patternId}-band-${band.id})`} />
            )))}
          </>
        ) : sawtooth.map((points, index) => (
          <polygon key={index} points={points} fill="currentColor" opacity=".07" />
        ))}
        {projection && remainingDays > 0 && (() => {
          const x1 = xFor(dense.length - 1) + barSlot / 2;
          const x2 = xFor(dense.length - 1 + remainingDays) + barSlot / 2;
          const y1 = yFor(projection.toDate);
          const y2 = yFor(projection.projected);
          const base = PLOT.top + plotHeight;
          return <g>
            <polygon points={`${x1},${base} ${x1},${y1} ${x2},${y2} ${x2},${base}`} fill={`url(#${patternId}-hatch)`} />
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" opacity=".4" strokeDasharray="2 3" strokeWidth="1" />
          </g>;
        })()}

        {/* Cycle boundaries */}
        {cycleStarts.map(cycle => {
          const index = indexForDay.get(new Date(cycle.startsAt).toISOString().slice(0, 10));
          if (index === undefined) return null;
          const x = PLOT.left + index * barSlot;
          return <g key={cycle.startsAt}>
            <line x1={x} x2={x} y1={PLOT.top} y2={PLOT.top + plotHeight} className="stroke-line-strong" strokeDasharray="1 3" />
            <text x={x + 4} y={PLOT.top + plotHeight + 16} className="fill-faint text-[10.5px]">{monthLabel(cycle.startsAt)}</text>
          </g>;
        })}
        <text x={PLOT.left} y={PLOT.top + plotHeight + 16} className="fill-faint text-[10.5px]">{dayLabel(window.fromDay)}</text>
        <text x={xFor(dense.length - 1)} y={PLOT.top + plotHeight + 16} textAnchor={remainingDays > 2 ? "middle" : "end"} className="fill-ink text-[10.5px] font-bold">Today</text>
        {remainingDays > 2 && <text x={PLOT.left + plotWidth} y={PLOT.top + plotHeight + 16} textAnchor="end" className="fill-faint text-[10.5px]">Cycle end</text>}

        {/* Bars */}
        {dense.map((point, index) => {
          const crossed = crossedLevel(order, shown, point.value);
          const color = (crossed && colorById.get(crossed)) || accent;
          const top = yFor(point.value);
          const base = PLOT.top + plotHeight;
          return (
            <rect key={point.day} x={xFor(index) - barWidth / 2} y={Math.min(top, base - 0.5)} width={barWidth} height={Math.max(0.5, base - top)} rx={Math.min(1.5, barWidth / 3)}
              fill={cycleMode ? "currentColor" : color} opacity={cycleMode ? 0.16 : crossed ? 1 : 0.9}>
              <title>{barTitles[index]}</title>
            </rect>
          );
        })}

        {/* Level lines and handles */}
        {levels.map(level => {
          const current = shown[level.id] ?? 0;
          const y = yFor(current);
          const interactive = !readOnly;
          return (
            <g key={level.id}
              role={interactive ? "slider" : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={interactive ? `${level.label} limit` : undefined}
              aria-valuemin={interactive ? 0 : undefined}
              aria-valuemax={interactive ? axis.max : undefined}
              aria-valuenow={interactive ? current : undefined}
              aria-valuetext={interactive ? formatLimitValue(current, unit) : undefined}
              aria-orientation={interactive ? "vertical" : undefined}
              className={interactive ? "cursor-ns-resize outline-none focus-visible:[&>polygon]:stroke-ink focus-visible:[&>polygon]:stroke-[2.5]" : undefined}
              onPointerDown={startDrag(level.id)}
              onPointerMove={moveDrag(level.id)}
              onPointerUp={endDrag(level.id)}
              onPointerCancel={endDrag(level.id)}
              onKeyDown={keyStep(level.id)}
            >
              <title>{`${level.label} · ${formatLimitValue(current, unit)}`}</title>
              <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={y} y2={y} stroke="transparent" strokeWidth="14" />
              <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={y} y2={y} stroke={level.color} strokeWidth="2" strokeDasharray="7 5" />
              <polygon points={diamond(PLOT.left - 3, y, 6.5)} fill={level.color} stroke="var(--panel)" strokeWidth="1.5" />
            </g>
          );
        })}
      </svg>

      {readOnly ? (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] font-bold text-muted">
          {levels.map(level => (
            <li key={level.id} className="inline-flex items-center gap-1.5">
              <i className="size-2 flex-none rotate-45 rounded-[1.5px]" style={{ background: level.color }} aria-hidden="true" />
              {level.label} <span className="font-[740] tabular-nums text-ink">{formatLimitValue(shown[level.id] ?? 0, unit)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-2.5 grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(128px, 1fr))` }}>
          {levels.map(level => (
            <LevelField key={level.id} level={level} unit={unit} value={shown[level.id] ?? 0} onCommit={next => commit(level.id, next)} />
          ))}
        </div>
      )}
    </div>
  );
}

function LevelField({ level, unit, value, onCommit }: { level: LimitsChartLevel; unit: string; value: number; onCommit(next: number): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(roundForField(value));
  const commitDraft = () => {
    if (draft === null) return;
    const parsed = Number(draft.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"));
    setDraft(null);
    if (Number.isFinite(parsed) && parsed >= 0) onCommit(parsed);
  };
  return (
    <label className="flex min-w-0 flex-col gap-1 rounded-field border border-field-line bg-field px-2.5 py-2 focus-within:border-orange focus-within:shadow-[0_0_0_3px_#f6821f1c]">
      <span className="flex items-center gap-1.5 text-[11.5px] font-bold text-muted">
        <i className="size-2 flex-none rotate-45 rounded-[1.5px]" style={{ background: level.color }} aria-hidden="true" />
        <span className="truncate">{level.label}</span>
        {unit !== "USD" && <small className="ml-auto truncate text-[10.5px] font-medium text-faint">{unit}</small>}
      </span>
      <span className="flex min-w-0 items-baseline gap-1 text-ink">
        {unit === "USD" && <b className="text-[13px] text-faint">$</b>}
        <input
          className="min-w-0 flex-1 border-0 bg-transparent text-[15px] font-[740] tabular-nums outline-none"
          inputMode="decimal"
          value={shown}
          aria-label={`${level.label} limit${unit === "USD" ? " in dollars" : ` in ${unit}`}`}
          onChange={event => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={event => {
            if (event.key === "Enter") { event.preventDefault(); commitDraft(); (event.target as HTMLInputElement).blur(); return; }
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const step = snapStep(value) * (event.shiftKey ? 10 : 1);
            onCommit(Math.max(0, value + (event.key === "ArrowUp" ? step : -step)));
          }}
        />
      </span>
    </label>
  );
}

function roundForField(value: number): number {
  return Number(value.toFixed(value >= 100 ? 0 : 2));
}

function formatTick(value: number, unit: string): string {
  if (value === 0) return unit === "USD" ? "$0" : "0";
  if (unit === "USD") return value >= 10 ? `$${formatNumber(value)}` : money(value);
  return formatNumber(value);
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

function dayLabel(day: string): string {
  return DAY_FORMAT.format(dayStart(day));
}

function monthLabel(at: number): string {
  return MONTH_FORMAT.format(at);
}

function diamond(cx: number, cy: number, r: number): string {
  return `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
}

/** One polygon per billing cycle: baseline → running total → drop to baseline at cycle end. */
function cyclePolygons(
  points: ReturnType<typeof cycleCumulative>,
  xFor: (index: number) => number,
  yFor: (value: number) => number,
  baseline: number,
  slot: number,
): string[] {
  const groups = new Map<number, string[]>();
  points.forEach((point, index) => {
    const list = groups.get(point.cycle) ?? [];
    if (!list.length) list.push(`${xFor(index) - slot / 2},${baseline}`);
    list.push(`${xFor(index)},${yFor(point.cumulative)}`);
    groups.set(point.cycle, list);
  });
  return [...groups.entries()].map(([cycle, list]) => {
    const lastIndex = points.map(point => point.cycle).lastIndexOf(cycle);
    const lastX = xFor(lastIndex) + slot / 2;
    const last = points[lastIndex]!;
    return [...list, `${lastX},${yFor(last.cumulative)}`, `${lastX},${baseline}`].join(" ");
  });
}
