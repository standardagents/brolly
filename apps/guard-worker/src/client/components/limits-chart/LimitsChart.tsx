import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { money } from "../../format";
import type { MetricPart } from "./api";
import { ProductIcon } from "../ui";
import { DAY_MS, type AggregationKind, type CycleBounds, type DayPoint, cycleCumulative, dayOf, dayStart, denseSeries, freeRemainingSeries, includedTops, monthlyCycles, projectCycle, projectedCrossingDate, visibleWindow } from "./cycles";
import { type LevelValues, crossedLevel, pushLevels } from "./levels";
import { completeWithDefaults } from "./defaults";
import { compactValue, formatLimitValue } from "./format";
import { LevelValueField, type LimitsChartLevel } from "./LevelValueField";
import { type Axis, chooseAxisWithIncluded, includedBandGeometry, snapStep, snapToNice } from "./scale";
import { useLimitHistory, type LimitHistory } from "./use-limit-history";
import { useElementWidth } from "./use-element-width";

export type { LimitsChartLevel } from "./LevelValueField";

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
  /** Optional levelId → minimum allowed value. */
  floor?: LevelValues;
  /** levelId → suggested value for levels that have no saved value yet. */
  seed?: LevelValues;
  /** levelId → tolerance-derived default for levels that have no saved value. */
  tolerance?: LevelValues;
  /** Complete tolerance-derived map reapplied by the chart's reset action. */
  resetToTolerance?: LevelValues;
  /** Daily values shown as a non-blocking reference on cycle charts. */
  reference?: LevelValues;
  /** Included family allotment for this usage metric's billing cycle (in this metric's units). */
  includedPerCycle?: number;
  /** Usage of a shared allotment pool in this metric's units, including this metric, when the allotment is shared. */
  poolSeries?: DayPoint[];
  /** Parts that make up `series` (meter first, then folded sources), each in this metric's units. */
  composition?: MetricPart[];
  /** How daily metric values combine within a billing cycle. Legacy data sums. */
  aggregationKind?: AggregationKind;
  onChange(next: LevelValues): void;
  readOnly?: boolean;
  /** levelId → active on this chart. Missing ids are active. Inactive levels keep their value but draw no line. */
  levelEnabled?: Record<string, boolean>;
  onLevelEnabledChange?(next: Record<string, boolean>): void;
  /** Accessible name for the chart. */
  label?: string;
  /** Optional heading rendered above the chart. */
  title?: string;
  /** Indent the title to the plot's left edge so it aligns with the x axis. */
  titleIndent?: boolean;
  /** Product family glyph rendered before the heading. */
  family?: string;
  /** Undo/redo store shared with a parent (survives unmount). Defaults to a private one. */
  history?: LimitHistory;
  /**
   * Value editors under the chart: "cards" (default), "inline" (one plain
   * row: diamond, label, value, switch per level, no boxes), or false.
   */
  fields?: "cards" | "inline" | false;
  /** Content placed beside the history controls in the heading row. */
  headerContent?: ReactNode;
}

const EASE = "cubic-bezier(.2,.7,.2,1)";
const PLOT = { left: 62, right: 14, top: 12, bottom: 28, height: 250 } as const;
/** Left plot-area edge, exported so headings above a chart can align with its x axis. */
export const CHART_PLOT_LEFT = PLOT.left;
/** Floating readouts over the chart: the day tooltip and the axis value chip share one look. */
const FLOAT_CHIP = "pointer-events-none absolute z-10 whitespace-nowrap rounded-[6px] border border-line bg-panel px-2 py-1 text-[11px] leading-[1.45] shadow-[0_2px_8px_rgba(0,0,0,.08)]";
/** One series accent for every chart, cost and usage alike: cool blue, outside the warm level ramp. */
export const CHART_ACCENT = "#2f6fd6";
/** Included (free-allotment) usage is green: it costs nothing. Blue is billable usage under the first level. */
export const INCLUDED_COLOR = "#2e9d62";
/** Included usage and the free-usage-left area share one light dithered green fill. */
const DITHER_SWATCH = { backgroundColor: `${INCLUDED_COLOR}08`, backgroundImage: `radial-gradient(${INCLUDED_COLOR}7a 0.5px, transparent 0.6px)`, backgroundSize: "3px 3px" } as const;
/** Level ramp, lowest to highest severity: amber → red → magenta → deep plum. */
const LEVEL_PALETTE = ["#e79021", "#e0632a", "#c9412c", "#a8232f", "#8c1d45", "#701a58", "#521a5c", "#3a1748"];

/** Default color for a level by board position, so any level count reads as an ordered ramp. */
export function levelColor(index: number, count: number): string {
  if (count <= 1) return LEVEL_PALETTE[2]!;
  const step = (LEVEL_PALETTE.length - 1) / Math.max(1, count - 1);
  return LEVEL_PALETTE[Math.min(LEVEL_PALETTE.length - 1, Math.round(index * step))]!;
}

export { compactValue, editableValue, formatLimitValue, parseCompact, selectNumber, unitLabel } from "./format";

export function LimitsChart({ kind, unit, window: limitWindow, series, cycles: cyclesProp, today: todayProp, levels, value, floor, seed, tolerance, resetToTolerance, reference, includedPerCycle, poolSeries, composition, aggregationKind = "sum", onChange, readOnly = false, label, title, titleIndent = false, family, headerContent, levelEnabled, onLevelEnabledChange, history: historyProp, fields = "cards" }: LimitsChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const patternId = useId();
  // Every level, on or off, takes part in ordering, pushing, and defaults, so
  // a switched-off level keeps a consistent value and can be switched back
  // on without landing out of order. Only active levels are drawn and used
  // for bar and band colors.
  const order = useMemo(() => levels.map(level => level.id), [levels]);
  const activeLevels = useMemo(() => levels.filter(level => levelEnabled?.[level.id] ?? true), [levels, levelEnabled]);
  const activeOrder = useMemo(() => activeLevels.map(level => level.id), [activeLevels]);
  const today = todayProp ?? series.at(-1)?.day ?? new Date().toISOString().slice(0, 10);
  const cycles = useMemo(
    () => (cyclesProp?.length ? cyclesProp : monthlyCycles(series[0]?.day ?? today, today)),
    [cyclesProp, series, today],
  );
  const window = useMemo(() => visibleWindow(series, cycles, today), [series, cycles, today]);
  const dense = useMemo(() => denseSeries(series, window.fromDay, window.toDay), [series, window]);
  // Composition parts aligned to `dense`, for the seams inside day bars and the tooltip breakdown.
  const partsDense = useMemo(() => (composition && composition.length > 1 ? composition.map(part => denseSeries(part.series, window.fromDay, window.toDay)) : []), [composition, window]);
  const cumulative = useMemo(() => cycleCumulative(dense, cycles, aggregationKind), [dense, cycles, aggregationKind]);
  const projection = useMemo(() => projectCycle(dense, cycles, today, aggregationKind), [dense, cycles, today, aggregationKind]);
  const observedMax = useMemo(() => Math.max(0, ...dense.map(point => point.value)), [dense]);
  const seriesValues = useMemo(() => dense.map(point => point.value), [dense]);
  const cycleMode = limitWindow === "cycle";
  // Allotments are cycle-scoped usage quantities. The cycle chart draws the
  // boundary; the day chart draws the free usage left as the cycle spends it.
  // The kind guard keeps a cost chart from acquiring quota geometry.
  const chartIncluded = kind === "usage" && Number.isFinite(includedPerCycle) && includedPerCycle! > 0 ? includedPerCycle : undefined;
  const cycleIncluded = cycleMode ? chartIncluded : undefined;
  // With a shared pool the free usage is judged against the whole pool.
  const poolDense = useMemo(() => (poolSeries && chartIncluded ? denseSeries(poolSeries, window.fromDay, window.toDay) : undefined), [poolSeries, chartIncluded, window]);
  const poolCumulative = useMemo(() => (poolDense ? cycleCumulative(poolDense, cycles, aggregationKind) : undefined), [poolDense, cycles, aggregationKind]);
  const freeLeft = useMemo(() => (!cycleMode && chartIncluded ? freeRemainingSeries(poolDense ?? dense, cycles, chartIncluded, aggregationKind) : []), [cycleMode, chartIncluded, poolDense, dense, cycles, aggregationKind]);
  // Per day of the cycle chart: how much of the running total is included,
  // and where the ceiling sits once the pool's other members have spent.
  const includedTop = useMemo(() => (cycleMode && chartIncluded ? includedTops(cumulative.map(point => point.cumulative), poolCumulative?.map(point => point.cumulative), chartIncluded) : []), [cycleMode, chartIncluded, cumulative, poolCumulative]);
  const ceiling = useMemo(() => (cycleMode && chartIncluded && poolCumulative
    ? cumulative.map((point, index) => Math.max(0, chartIncluded - Math.max(0, (poolCumulative[index]?.cumulative ?? point.cumulative) - point.cumulative)))
    : []), [cycleMode, chartIncluded, cumulative, poolCumulative]);
  // The daily chart is about days: its axis fits the bars and levels, and the
  // cumulative background may run off the top. The cycle chart's axis must
  // hold the running total and the projection.
  const heightValues = useMemo(() => (limitWindow === "cycle"
    ? [...seriesValues, ...cumulative.map(point => point.cumulative), projection?.projected ?? 0]
    : seriesValues), [seriesValues, cumulative, projection, limitWindow]);

  // The axis extends to keep every level visible, but stays frozen while a
  // handle is dragged so the chart does not rescale under the pointer.
  const [frozenAxis, setFrozenAxis] = useState<Axis | null>(null);
  // The day axis fits bars and levels only; the free-left area is clipped to
  // the plot and reads as a full-height wash until it descends into range.
  const liveAxis = useMemo(() => chooseAxisWithIncluded(heightValues, order.map(id => value[id] ?? 0), cycleIncluded), [heightValues, order, value, cycleIncluded]);
  const axis = frozenAxis ?? liveAxis;

  // Fill in defaults for levels that have no value yet. The defaults are
  // pushed on an axis that already contains the default ladder, so a ladder
  // above today's data does not get clamped to the top of the chart.
  const complete = useMemo(() => completeWithDefaults(heightValues, observedMax, order, value, floor, seed, tolerance), [heightValues, order, value, observedMax, floor, seed, tolerance]);
  // Values this chart itself emitted. Anything else that arrives in `value`
  // (a chip edit in the dimension row, an outside reset) is recorded in the
  // chart's undo history so undo/redo covers every edit of this map.
  const emitted = useRef<LevelValues | null>(null);
  const emit = (next: LevelValues) => { emitted.current = next; onChange(next); };
  useEffect(() => {
    if (order.some(id => complete[id] !== value[id])) { emit(complete); return; }
    const last = emitted.current;
    if (last && order.every(id => last[id] === value[id])) return;
    emitted.current = value;
    // A map that lands exactly on this chart's default arrived by following
    // its basis (a tolerance or daily change), not by an edit: no undo step.
    if (resetToTolerance && order.every(id => value[id] === resetToTolerance[id])) return;
    history.record(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- record only when the map or order changes
  }, [complete, order, value]);

  const plotWidth = Math.max(80, width - PLOT.left - PLOT.right);
  const plotHeight = PLOT.height - PLOT.top - PLOT.bottom;
  const yFor = (item: number) => PLOT.top + (1 - axis.position(item)) * plotHeight;
  const valueForY = (y: number) => axis.invert(1 - (y - PLOT.top) / plotHeight);
  const includedBand = includedBandGeometry(axis, cycleIncluded);
  // The free marker lives on the y axis as a highlighted tick: a value label
  // in the gutter with a soft green field, drawn under the level diamonds.
  // Cycle charts only: the day chart's green area carries its own meaning.
  const freeMark = cycleMode && chartIncluded && includedBand?.boundary !== null
    ? { value: chartIncluded, label: compactValue(chartIncluded, unit) }
    : null;
  const freeMarkY = freeMark ? yFor(freeMark.value) : null;
  const projectedCrossing = useMemo(
    () => cycleMode ? projectedCrossingDate(dense, cycles, today, cycleIncluded, aggregationKind) : null,
    [cycleMode, dense, cycles, today, cycleIncluded, aggregationKind],
  );
  // Reserve room for the rest of the current cycle so the projection has
  // somewhere to go.
  const remainingDays = projection ? Math.max(0, projection.totalDays - projection.elapsedDays) : 0;
  const barSlot = plotWidth / Math.max(1, dense.length + remainingDays);
  const xFor = (index: number) => PLOT.left + index * barSlot + barSlot / 2;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // Pointer hover: a day column under the cursor, and a level line under the
  // cursor. The day tooltip hides while a line is hovered or dragged; the
  // hovered or dragged line highlights its legend field instead.
  const [hoverDay, setHoverDay] = useState<{ index: number; x: number; y: number } | null>(null);
  const [hoverLevel, setHoverLevel] = useState<string | null>(null);
  // While a handle is dragged, values live here and the parent hears about
  // the result once on release. Pointer moves are coalesced to one update
  // per animation frame.
  const [dragValues, setDragValues] = useState<LevelValues | null>(null);
  const shown = dragValues ?? complete;
  const ownHistory = useLimitHistory();
  const history = historyProp ?? ownHistory;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- seed is idempotent; the handle changes identity every render
  useEffect(() => { history.seed(complete); }, [complete]);
  const dragBase = useRef<LevelValues | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<{ id: string; clientY: number } | null>(null);
  const svgRect = useRef<DOMRect | null>(null);

  const commit = (id: string, next: number) => {
    const result = pushLevels(axis, order, complete, id, next, floor);
    history.record(result);
    emit(result);
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
    setDragValues(() => pushLevels(axis, order, dragBase.current ?? complete, move.id, next, floor));
  };

  const startDrag = (id: string) => (event: PointerEvent<SVGElement>) => {
    if (readOnly) return;
    event.preventDefault();
    (event.currentTarget as SVGElement).setPointerCapture?.(event.pointerId);
    svgRect.current = svgRef.current?.getBoundingClientRect() ?? null;
    setFrozenAxis(axis);
    dragBase.current = complete;
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
    const final = last === null ? dragValues ?? dragBase.current ?? complete : pushLevels(axis, order, dragBase.current ?? complete, id, last, floor);
    dragBase.current = null;
    setDragging(null);
    setDragValues(null);
    setFrozenAxis(null);
    history.record(final);
    emit(final);
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

  const historyStep = (direction: "undo" | "redo") => {
    if (readOnly) return;
    const next = direction === "undo" ? history.undo() : history.redo();
    if (next) emit(next);
  };
  const reset = () => {
    if (readOnly || !resetToTolerance) return;
    history.seed(complete);
    history.record(resetToTolerance);
    emit(resetToTolerance);
  };
  const historyKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly || (!event.metaKey && !event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "z" && event.shiftKey) {
      event.preventDefault();
      historyStep("redo");
    } else if (key === "z") {
      event.preventDefault();
      historyStep("undo");
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- xFor/yFor derive from axis, plotWidth, and barSlot
  const sawtooth = useMemo(() => cyclePolygons(cumulative, xFor, yFor, PLOT.top + plotHeight, barSlot), [cumulative, axis, plotWidth, plotHeight, barSlot]);
  // Horizontal color bands for the cycle sawtooth: accent under the lowest
  // line, then each level's color up to the next line, the top one open.
  const bands = useMemo(() => {
    const edges = activeOrder.map(id => ({ id, value: shown[id] ?? 0 }));
    const list: Array<{ id: string; color: string; bottom: number; top: number }> = [{ id: "base", color: CHART_ACCENT, bottom: 0, top: edges[0]?.value ?? Number.POSITIVE_INFINITY }];
    edges.forEach((edge, index) => list.push({ id: edge.id, color: activeLevels[index]?.color ?? CHART_ACCENT, bottom: edge.value, top: edges[index + 1]?.value ?? Number.POSITIVE_INFINITY }));
    return list;
  }, [activeOrder, shown, activeLevels]);
  // The included part of the running total, painted green over the bands.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- xFor/yFor derive from axis, plotWidth, and barSlot
  const includedPolygons = useMemo(() => (includedTop.length
    ? cyclePolygons(cumulative.map((point, index) => ({ ...point, cumulative: includedTop[index]! })), xFor, yFor, PLOT.top + plotHeight, barSlot)
    : []), [cumulative, includedTop, axis, plotWidth, plotHeight, barSlot]);
  // A shared pool's ceiling, one stepped line per cycle.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- xFor/yFor derive from axis, plotWidth, and barSlot
  const ceilingLines = useMemo(() => {
    const groups = new Map<number, string[]>();
    ceiling.forEach((value, index) => {
      const cycle = cumulative[index]?.cycle ?? -1;
      const group = groups.get(cycle) ?? [];
      group.push(`${xFor(index) - barSlot / 2},${yFor(value)}`, `${xFor(index) + barSlot / 2},${yFor(value)}`);
      groups.set(cycle, group);
    });
    return [...groups.values()].map(group => group.join(" "));
  }, [ceiling, cumulative, axis, plotWidth, barSlot]);
  const colorById = useMemo(() => new Map(levels.map(level => [level.id, level.color])), [levels]);
  const cycleStarts = cycles.filter(cycle => cycle.startsAt > dayStart(window.fromDay) && cycle.startsAt <= dayStart(window.toDay));
  const indexForDay = new Map(dense.map((point, index) => [point.day, index]));
  const accent = CHART_ACCENT;
  const chartLabel = label ?? `${kind === "cost" ? "Cost" : "Usage"} per ${limitWindow === "day" ? "day" : "billing cycle"}`;
  const trackHover = (event: PointerEvent<SVGRectElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = event.clientX - rect.left;
    const index = Math.floor((x - PLOT.left) / barSlot);
    if (index < 0 || index >= dense.length + remainingDays) { setHoverDay(null); return; }
    setHoverDay({ index, x, y: event.clientY - rect.top });
  };
  const highlightLevel = dragging ?? hoverLevel;
  // Hover covers the projected days too: those report the forecast, since
  // there is no actual value to show yet.
  const hovered = useMemo(() => {
    if (!hoverDay || dragging || hoverLevel) return null;
    const point = dense[hoverDay.index];
    if (point) return { day: point.day, value: point.value, projected: false, index: hoverDay.index };
    const ahead = hoverDay.index - dense.length + 1;
    if (!projection || ahead < 1 || ahead > remainingDays) return null;
    return { day: dayOf(dayStart(today) + ahead * DAY_MS), value: projection.rate, projected: true, index: hoverDay.index, ahead };
  }, [hoverDay, dragging, hoverLevel, dense, projection, remainingDays, today]);
  // Tooltip rows: one labeled line per fact instead of a single run-on string.
  const hoverRows = ((): Array<[string, string]> => {
    if (!hovered) return [];
    const rows: Array<[string, string]> = [];
    if (cycleMode) {
      if (!hovered.projected) rows.push(["So far this cycle", formatLimitValue(cumulative[hovered.index]?.cumulative ?? 0, unit)]);
      else rows.push(["Projected by this day", formatLimitValue(projection!.toDate + projection!.rate * hovered.ahead!, unit)]);
      return rows;
    }
    rows.push([hovered.projected ? "Projected usage" : "Usage", formatLimitValue(hovered.value, unit)]);
    if (!hovered.projected && partsDense.length > 1 && composition) {
      partsDense.forEach((part, which) => rows.push([composition[which]!.label, compactValue(part[hovered.index]?.value ?? 0, unit)]));
    }
    const free = hovered.projected
      ? Math.max(0, (freeLeft.at(-1)?.after ?? 0) - projection!.rate * hovered.ahead!)
      : freeLeft[hovered.index]?.after;
    if (chartIncluded && free !== undefined) rows.push(["Free left", formatLimitValue(free, unit)]);
    return rows;
  })();
  // Free-usage-left area per cycle: starts at the allotment, falls with each
  // day's usage (start-of-day to end-of-day), closed on the baseline.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- xFor/yFor derive from axis, plotWidth, and barSlot
  const freeAreas = useMemo(() => {
    const groups = new Map<number, { points: string[]; left: number; right: number }>();
    const base = PLOT.top + plotHeight;
    freeLeft.forEach((point, index) => {
      const left = xFor(index) - barSlot / 2;
      const right = xFor(index) + barSlot / 2;
      const group = groups.get(point.cycle) ?? { points: [], left, right };
      group.points.push(`${left},${yFor(point.before)}`, `${right},${yFor(point.after)}`);
      group.right = right;
      groups.set(point.cycle, group);
    });
    return [...groups.values()].map(group => ({ area: [`${group.left},${base}`, ...group.points, `${group.right},${base}`].join(" ") }));
  }, [freeLeft, axis, plotWidth, plotHeight, barSlot]);
  // Projected burn-down for the rest of the current cycle at the recent pace:
  // the same area, plus a dashed top edge so it reads as a forecast.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- xFor/yFor derive from axis, plotWidth, and barSlot
  const projectedFree = useMemo(() => {
    const last = freeLeft.at(-1);
    if (!last || !projection || last.cycle !== projection.cycle || remainingDays <= 0) return null;
    const base = PLOT.top + plotHeight;
    const area: string[] = [];
    let left = last.after;
    for (let day = 1; day <= remainingDays; day += 1) {
      const index = dense.length - 1 + day;
      const after = Math.max(0, left - projection.rate);
      area.push(`${xFor(index) - barSlot / 2},${yFor(left)}`, `${xFor(index) + barSlot / 2},${yFor(after)}`);
      left = after;
    }
    const start = xFor(dense.length) - barSlot / 2;
    const end = xFor(dense.length - 1 + remainingDays) + barSlot / 2;
    return { area: [`${start},${base}`, ...area, `${end},${base}`].join(" ") };
  }, [freeLeft, projection, remainingDays, dense.length, axis, plotWidth, plotHeight, barSlot]);
  // Bars are memoized on data and geometry only, so per-pointer-move hover
  // state re-renders the overlay and tooltip, never the full bar set. The
  // hovered bar's lit look is an overlay rect drawn above this layer.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- xFor/yFor derive from axis, plotWidth, and barSlot
  // A day bar is blue up to the first level and wears each level's color
  // only for the part above that level, so overage reads as "how far over".
  const barSegments = (value: number) => {
    const edges = activeOrder.map(id => ({ id, value: shown[id] ?? 0 })).filter(edge => edge.value > 0 && edge.value < value);
    const bounds = [0, ...edges.map(edge => edge.value), value];
    return bounds.slice(1).map((top, index) => ({ bottom: bounds[index]!, top, color: index === 0 ? accent : colorById.get(edges[index - 1]!.id) ?? accent }));
  };
  // Bar edges snap to whole pixels so every day is the same width and the
  // separators stay true hairlines instead of smearing across half pixels.
  const barEdges = (index: number) => {
    const left = Math.round(xFor(index) - barSlot / 2);
    const right = Math.round(xFor(index) + barSlot / 2);
    return { left, width: Math.max(1, right - left) };
  };
  const barsLayer = useMemo(() => cycleMode ? null : dense.map((point, index) => {
    const base = PLOT.top + plotHeight;
    const { left, width: barPixels } = barEdges(index);
    const top = yFor(point.value);
    return (
      <g key={point.day} pointerEvents="none" style={{ transition: dragging ? "none" : `opacity 120ms ${EASE}` }}>
        {barSegments(point.value).map((segment, part) => {
          const segmentTop = yFor(segment.top);
          const bottom = part === 0 ? base : yFor(segment.bottom);
          return <rect key={part} data-day-bar={part === 0 ? "" : undefined} x={left} y={Math.min(segmentTop, bottom - 0.5)} width={barPixels} height={Math.max(0.5, bottom - segmentTop)} fill={segment.color} opacity="0.9" shapeRendering="crispEdges" />;
        })}
        {index > 0 && <line x1={left + 0.5} x2={left + 0.5} y1={Math.min(top, base - 0.5)} y2={base} stroke="var(--panel)" strokeWidth="1" opacity=".22" shapeRendering="crispEdges" />}
        {/* Composition: folded parts stack above the meter's own usage, each
            behind a seam and a panel-dot texture so the split reads at a glance. */}
        {partsDense.length > 1 && (() => {
          let stacked = 0;
          return partsDense.map((part, which) => {
            const value = part[index]?.value ?? 0;
            const bottom = stacked;
            stacked += value;
            if (which === 0 || value <= 0) return null;
            const y0 = yFor(stacked);
            const y1 = yFor(bottom);
            return <g key={which}>
              <rect x={left} y={y0} width={barPixels} height={Math.max(0, y1 - y0)} fill={`url(#${patternId}-part)`} shapeRendering="crispEdges" />
              <line x1={left} x2={left + barPixels} y1={y1 + 0.5} y2={y1 + 0.5} stroke="var(--panel)" strokeWidth="1" opacity=".7" shapeRendering="crispEdges" />
            </g>;
          });
        })()}
      </g>
    );
  }), [dense, partsDense, activeOrder, shown, colorById, accent, cycleMode, dragging, axis, plotWidth, plotHeight, barSlot]);

  const belowReference = limitWindow === "cycle" && reference
    ? activeLevels.find(level => (shown[level.id] ?? Number.POSITIVE_INFINITY) < (reference[level.id] ?? Number.NEGATIVE_INFINITY))
    : undefined;

  return (
    <div ref={containerRef} className="@container min-w-0 select-none" data-limits-chart={kind} onKeyDown={historyKeyDown}>
      {(title || headerContent || !readOnly) && (
        <div className="mb-2 flex min-h-[30px] flex-wrap items-center justify-between gap-2">
          {title ? <h4 className="inline-flex items-center gap-2 text-[13px] font-bold" style={titleIndent ? { paddingLeft: PLOT.left } : undefined}>{family && <ProductIcon family={family} size="sm" />}{title}</h4> : <span />}
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            {!readOnly && <HistoryButtons history={history} canReset={Boolean(resetToTolerance) && order.some(id => resetToTolerance![id] !== complete[id])} onReset={reset} onUndo={() => historyStep("undo")} onRedo={() => historyStep("redo")} />}
            {headerContent}
          </div>
        </div>
      )}
      <div className="relative">
      <svg
        ref={svgRef}
        className="block w-full touch-none overflow-visible text-ink"
        style={{ height: PLOT.height }}
        viewBox={`0 0 ${width} ${PLOT.height}`}
        role="group"
        aria-label={chartLabel}
      >
        <defs>
          <clipPath id={`${patternId}-plot`}><rect x={PLOT.left} y={PLOT.top} width={plotWidth} height={plotHeight} /></clipPath>
          <pattern id={`${patternId}-dither`} width="3" height="3" patternUnits="userSpaceOnUse">
            <rect width="3" height="3" fill={INCLUDED_COLOR} opacity=".03" />
            <circle cx=".75" cy=".75" r=".5" fill={INCLUDED_COLOR} opacity=".48" />
            <circle cx="2.25" cy="2.25" r=".5" fill={INCLUDED_COLOR} opacity=".48" />
          </pattern>
          <pattern id={`${patternId}-part`} width="3" height="3" patternUnits="userSpaceOnUse">
            <circle cx=".75" cy=".75" r=".55" fill="var(--panel)" opacity=".55" />
            <circle cx="2.25" cy="2.25" r=".55" fill="var(--panel)" opacity=".55" />
          </pattern>
          {/* Projections use a lighter dither in the color of the band they land in. */}
          {[{ id: "included", color: INCLUDED_COLOR }, ...bands.map(band => ({ id: band.id, color: band.color }))].map(item => (
            <pattern key={item.id} id={`${patternId}-projection-${item.id}`} width="3" height="3" patternUnits="userSpaceOnUse">
              <circle cx=".75" cy=".75" r=".5" fill={item.color} opacity=".3" />
              <circle cx="2.25" cy="2.25" r=".5" fill={item.color} opacity=".3" />
            </pattern>
          ))}
        </defs>
        {/* Y ticks */}
        {axis.ticks.map(tick => (
          <g key={tick}>
            {(freeMarkY === null || Math.abs(yFor(tick) - freeMarkY) > 9) && (
              <text x={PLOT.left - 10} y={yFor(tick) + 3.5} textAnchor="end" className="fill-faint text-[10.5px] tabular-nums" style={{ transition: dragging ? "none" : `y 260ms ${EASE}` }}>{formatTick(tick, unit)}</text>
            )}
          </g>
        ))}
        {freeMark && freeMarkY !== null && (() => {
          const textWidth = freeMark.label.length * 6.4;
          const width = textWidth + 18;
          return (
            <g data-included-pill pointerEvents="none">
              <rect x={PLOT.left - 8 - width} y={freeMarkY - 8} width={width} height={16} rx={4} fill={INCLUDED_COLOR} opacity=".14" />
              <text x={PLOT.left - 13} y={freeMarkY + 3.5} textAnchor="end" fill={INCLUDED_COLOR} className="text-[10.5px] font-[700] tabular-nums">{freeMark.label}</text>
            </g>
          );
        })()}

        {/* Cumulative sawtooth per cycle */}
        {cycleMode ? (
          // Cycle step: the running total is the primary mark. Each horizontal
          // band between two level lines paints the total in that level's
          // color; the band under the lowest line keeps the accent.
          <>
            <defs>
              {bands.map(band => (
                <clipPath key={band.id} id={`${patternId}-band-${band.id}`}>
                  <rect x={PLOT.left} width={plotWidth} y={Number.isFinite(band.top) ? yFor(band.top) : PLOT.top} height={Math.max(0, yFor(band.bottom) - (Number.isFinite(band.top) ? yFor(band.top) : PLOT.top))} style={{ transition: dragging ? "none" : `y 260ms ${EASE}, height 260ms ${EASE}` }} />
                </clipPath>
              ))}
            </defs>
            {bands.map(band => sawtooth.map((points, index) => (
              <polygon key={`${band.id}-${index}`} points={points} fill={band.color} opacity="0.82" clipPath={`url(#${patternId}-band-${band.id})`} />
            )))}
            {/* The panel-colored base also strokes its own outline so the blue band's
                anti-aliased edge cannot peek out along steep slopes. */}
            {includedPolygons.map((points, index) => <polygon key={`included-base-${index}`} points={points} fill="var(--panel)" stroke="var(--panel)" strokeWidth="1.5" strokeLinejoin="round" />)}
            {includedPolygons.map((points, index) => <polygon key={`included-${index}`} data-included-usage points={points} fill={`url(#${patternId}-dither)`} />)}
          </>
        ) : null}
        {/* Free usage left: a faint green area behind the bars, the inverse
            of the cumulative usage. It starts each cycle at the allotment and
            falls to zero once the allotment is spent. */}
        {freeAreas.length > 0 && (
          <g data-free-left pointerEvents="none" clipPath={`url(#${patternId}-plot)`}>
            {freeAreas.map((shape, index) => <polygon key={`area-${index}`} points={shape.area} fill={`url(#${patternId}-dither)`} />)}
            {projectedFree && (
              <g data-free-left-projected>
                <polygon points={projectedFree.area} fill={`url(#${patternId}-projection-included)`} />
              </g>
            )}
          </g>
        )}
        {cycleMode && projection && remainingDays > 0 && (() => {
          const x1 = xFor(dense.length - 1) + barSlot / 2;
          const x2 = xFor(dense.length - 1 + remainingDays) + barSlot / 2;
          const y1 = yFor(projection.toDate);
          const y2 = yFor(projection.projected);
          const base = PLOT.top + plotHeight;
          const points = `${x1},${base} ${x1},${y1} ${x2},${y2} ${x2},${base}`;
          // The remaining room under the allotment at cycle end, for the
          // included part of the projection (a shared pool's ceiling is
          // carried forward from today).
          const includedCap = chartIncluded === undefined ? 0 : ceiling.length ? ceiling.at(-1)! : chartIncluded;
          return <g data-cycle-projection clipPath={`url(#${patternId}-plot)`}>
            {bands.map(band => <polygon key={band.id} points={points} fill={`url(#${patternId}-projection-${band.id})`} clipPath={`url(#${patternId}-band-${band.id})`} />)}
            {includedCap > 0 && (
              <>
                <clipPath id={`${patternId}-projection-included-clip`}><rect x={PLOT.left} width={plotWidth} y={yFor(includedCap)} height={Math.max(0, base - yFor(includedCap))} /></clipPath>
                <polygon points={points} fill="var(--panel)" clipPath={`url(#${patternId}-projection-included-clip)`} />
                <polygon points={points} fill={`url(#${patternId}-projection-included)`} clipPath={`url(#${patternId}-projection-included-clip)`} />
              </>
            )}
          </g>;
        })()}
        {/* The boundary is a faint solid system line, unlike the dashed,
            colored, draggable levels. The axis pill names it; the split tint
            on the sawtooth shows the included region. */}
        {cycleMode && includedBand && includedBand.boundary !== null && includedPerCycle !== undefined && (
          <g data-included-boundary pointerEvents="none" clipPath={ceilingLines.length ? `url(#${patternId}-plot)` : undefined}>
            {ceilingLines.length
              ? ceilingLines.map((points, index) => <polyline key={index} points={points} fill="none" stroke={INCLUDED_COLOR} opacity=".6" strokeWidth="1.25" strokeLinejoin="round" />)
              : <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={yFor(includedPerCycle)} y2={yFor(includedPerCycle)} stroke={INCLUDED_COLOR} opacity=".5" strokeWidth="1" />}
          </g>
        )}
        {cycleMode && projectedCrossing && remainingDays > 0 && (
          <text data-projected-crossing data-day={projectedCrossing} x={PLOT.left + plotWidth - 4} y={PLOT.top + 13} textAnchor="end" paintOrder="stroke" stroke="var(--panel)" strokeWidth="3.5" strokeLinejoin="round" className="fill-ink text-[10.5px] font-[600]" pointerEvents="none">
            projected billable from {dayLabel(projectedCrossing)}
          </text>
        )}

        {/* Cycle boundaries */}
        {cycleStarts.map(cycle => {
          const index = indexForDay.get(new Date(cycle.startsAt).toISOString().slice(0, 10));
          if (index === undefined) return null;
          const x = PLOT.left + index * barSlot;
          return <g key={cycle.startsAt}>
            <line x1={x} x2={x} y1={PLOT.top} y2={PLOT.top + plotHeight} stroke="currentColor" opacity=".25" />
            <text x={x + 4} y={PLOT.top + plotHeight + 16} className="fill-faint text-[10.5px]">{monthLabel(cycle.startsAt)}</text>
          </g>;
        })}
        <text x={PLOT.left} y={PLOT.top + plotHeight + 16} className="fill-faint text-[10.5px]">{dayLabel(window.fromDay)}</text>
        {remainingDays > 2 && <text x={PLOT.left + plotWidth} y={PLOT.top + plotHeight + 16} textAnchor="end" className="fill-faint text-[10.5px]">Cycle end</text>}

        {/* Day hover: a soft column band behind the hovered day. Fainter in
            cycle mode so it never reads as a continuation of the day's bar. */}
        {hovered && (
          <rect data-hover-band x={xFor(hoverDay!.index) - barSlot / 2} y={PLOT.top} width={barSlot} height={plotHeight} fill="currentColor" opacity={cycleMode ? ".045" : ".07"} pointerEvents="none" />
        )}

        {/* Bars (memoized) plus a lit overlay copy of the hovered day's bar. */}
        {barsLayer}
        {hovered && !hovered.projected && !cycleMode && (() => {
          const base = PLOT.top + plotHeight;
          const { left, width: barPixels } = barEdges(hovered.index);
          return <g pointerEvents="none">
            {barSegments(hovered.value).map((segment, part) => {
              const top = yFor(segment.top);
              const bottom = part === 0 ? base : yFor(segment.bottom);
              return <rect key={part} x={left} y={Math.min(top, bottom - 0.5)} width={barPixels} height={Math.max(0.5, bottom - top)} fill={segment.color} opacity={1} shapeRendering="crispEdges" />;
            })}
          </g>;
        })()}


        {/* Day hover tracking: sits above the bars, below the level lines. */}
        <rect data-hover-layer x={PLOT.left} y={PLOT.top} width={plotWidth} height={plotHeight} fill="transparent"
          onPointerMove={trackHover} onPointerLeave={() => setHoverDay(null)} />

        {/* Axes sit above the data layers so fills can never cover them. */}
        <line x1={PLOT.left} x2={PLOT.left} y1={PLOT.top} y2={PLOT.top + plotHeight} className="stroke-line-strong" pointerEvents="none" />
        <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={PLOT.top + plotHeight} y2={PLOT.top + plotHeight} className="stroke-line-strong" pointerEvents="none" />

        {/* Level lines and handles */}
        {activeLevels.map(level => {
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
              // Lines and handles ease to a new position when a value changes
              // without a drag (tolerance change, preset, undo, chip edit).
              style={{ transform: `translateY(${y}px)`, transition: dragging ? "none" : `transform 260ms ${EASE}` }}
              onPointerDown={startDrag(level.id)}
              onPointerMove={moveDrag(level.id)}
              onPointerUp={endDrag(level.id)}
              onPointerCancel={endDrag(level.id)}
              onPointerEnter={() => setHoverLevel(level.id)}
              onPointerLeave={() => setHoverLevel(null)}
              onKeyDown={keyStep(level.id)}
            >
              <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={0} y2={0} stroke="transparent" strokeWidth="14" />
              {/* A panel-colored line under the dashes turns the gaps white, so the
                  line stays legible where it crosses a fill of its own color. */}
              <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={0} y2={0} stroke="var(--panel)" strokeWidth="1.25" opacity=".9" />
              <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={0} y2={0} stroke={level.color} strokeWidth="1.25" strokeDasharray="7 5" opacity=".85" />
              <polygon points={diamond(PLOT.left - 3, 0, 6.5)} fill={level.color} stroke="var(--panel)" strokeWidth="1.5" />

            </g>
          );
        })}
      </svg>
      {highlightLevel && (
        <div data-line-value className={`${FLOAT_CHIP} -translate-y-1/2 font-[740] tabular-nums`}
          style={{ left: PLOT.left - 6, top: yFor(shown[highlightLevel] ?? 0), transform: "translate(-100%, -50%)", color: colorById.get(highlightLevel) }}>
          {formatLimitValue(shown[highlightLevel] ?? 0, unit)}
        </div>
      )}
      {hovered && (
        // Near either edge the tooltip hangs inward from the pointer instead of centering, so it never clips.
        <div data-chart-tooltip role="status" className={`${FLOAT_CHIP} -translate-y-full ${hoverDay!.x > width * 0.7 ? "-translate-x-full" : hoverDay!.x < width * 0.3 ? "" : "-translate-x-1/2"}`}
          // The anchor side eases across when it flips near an edge; the position itself tracks the pointer directly.
          style={{ left: Math.min(Math.max(hoverDay!.x, PLOT.left), width - PLOT.right), top: hoverDay!.y - 10, transition: `translate 220ms ${EASE}` }}>
          <b className="font-[720]">{dayLabel(hovered.day)}</b>{hovered.projected && <span className="ml-1.5 text-[10px] font-[700] uppercase tracking-[.06em] text-faint">Projected</span>}
          <span className="mt-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
            {hoverRows.map(([label, value], index) => <span key={label} className="contents">
              <span className={index === 0 ? "text-ink" : "text-muted"}>{label}</span>
              <span className={`text-right tabular-nums ${index === 0 ? "font-[720] text-ink" : "text-muted"}`}>{value}</span>
            </span>)}
          </span>
        </div>
      )}
      </div>


      {chartIncluded && (
        <div data-included-legend className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 pl-[62px] text-[10.5px] text-muted">
          {cycleMode && <span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-[1px] border" style={{ ...DITHER_SWATCH, borderColor: INCLUDED_COLOR }} aria-hidden="true" />Included usage</span>}
          {cycleMode && <span className="inline-flex items-center gap-1.5"><i className="size-2 rounded-[1px]" style={{ background: CHART_ACCENT }} aria-hidden="true" />Billable usage</span>}
          {!cycleMode && <span className="inline-flex items-center gap-1.5"><i className="size-2 rounded-[1px]" style={{ background: CHART_ACCENT }} aria-hidden="true" />Daily usage</span>}
          {!cycleMode && <span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-[1px] border" style={{ ...DITHER_SWATCH, borderColor: INCLUDED_COLOR }} aria-hidden="true" />Free usage left</span>}
        </div>
      )}
      {!cycleMode && composition && composition.length > 1 && (
        <div data-composition-legend className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 pl-[62px] text-[10.5px] text-muted">
          {composition.map((part, which) => (
            <span key={part.id} className="inline-flex items-center gap-1.5">
              <i className="size-2.5 rounded-[1px]" style={{ background: CHART_ACCENT, backgroundImage: which === 0 ? undefined : "radial-gradient(#ffffffa6 0.6px, transparent 0.7px)", backgroundSize: "3px 3px" }} aria-hidden="true" />{part.label}
            </span>
          ))}
        </div>
      )}
      {!fields ? null : readOnly ? (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] font-bold text-muted">
          {activeLevels.map(level => (
            <li key={level.id} className={`inline-flex items-center gap-1.5 rounded-[5px] px-1.5 py-0.5 transition-colors ${highlightLevel === level.id ? "bg-field" : ""}`}>
              <i className="size-2 flex-none rotate-45 rounded-[1.5px]" style={{ background: level.color }} aria-hidden="true" />
              {level.label} <span className="font-[740] tabular-nums text-ink">{formatLimitValue(shown[level.id] ?? 0, unit)}</span>
            </li>
          ))}
        </ul>
      ) : fields === "inline" ? (
        // Aligned with the plot area, not the axis gutter, so values sit under the lines they set.
        <div className="mt-2 grid grid-cols-3 gap-x-8 gap-y-2 border-t border-line-soft pt-2.5 max-sm:grid-cols-2" style={{ marginLeft: PLOT.left, marginRight: PLOT.right }}>
          {levels.map(level => (
            <LevelValueField key={level.id} variant="bare" level={level} unit={unit} value={shown[level.id] ?? 0} onCommit={next => commit(level.id, next)}
              highlight={highlightLevel === level.id}
              enabled={levelEnabled?.[level.id] ?? true}
              onToggle={onLevelEnabledChange ? next => onLevelEnabledChange({ ...levelEnabled, [level.id]: next }) : undefined} />
          ))}
        </div>
      ) : (
        // Four across when there are four or more levels; fewer levels share the row three-wide so each card gets a third.
        <div className={`mt-2.5 grid grid-cols-2 gap-2 ${levels.length >= 4 ? "@[560px]:grid-cols-4" : "@[560px]:grid-cols-3"}`}>
          {levels.map(level => (
            <LevelValueField key={level.id} variant="boxed" level={level} unit={unit} value={shown[level.id] ?? 0} onCommit={next => commit(level.id, next)}
              highlight={highlightLevel === level.id}
              enabled={levelEnabled?.[level.id] ?? true}
              onToggle={onLevelEnabledChange ? next => onLevelEnabledChange({ ...levelEnabled, [level.id]: next }) : undefined} />
          ))}
        </div>
      )}
      {belowReference && <p className="mt-2 text-[11.5px] leading-5 text-muted">
        {belowReference.label} is below its daily limit ({formatLimitValue(reference![belowReference.id]!, unit)}). A single day can trip this limit.
      </p>}
    </div>
  );
}

function HistoryButtons({ history, canReset, onReset, onUndo, onRedo }: { history: LimitHistory; canReset: boolean; onReset(): void; onUndo(): void; onRedo(): void }) {
  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label="Chart history">
      {canReset && <button
        type="button"
        data-action="reset-tolerance"
        className="h-7 cursor-pointer rounded border border-line bg-panel px-2 text-[10.5px] font-bold text-muted hover:border-[#b7bfc8] hover:text-ink focus-visible:outline-2 focus-visible:outline-orange"
        onClick={onReset}
      >Reset to tolerance</button>}
      <button
        type="button"
        className="grid size-7 cursor-pointer place-items-center rounded border border-line bg-panel text-muted hover:border-[#b7bfc8] hover:text-ink focus-visible:outline-2 focus-visible:outline-orange disabled:cursor-default disabled:opacity-40 disabled:hover:border-line disabled:hover:text-muted"
        data-action="undo"
        aria-label="Undo last limit change"
        title="Undo (Cmd/Ctrl+Z)"
        disabled={!history.canUndo}
        onClick={onUndo}
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 7 4 12l5 5" /><path d="M5 12h8a6 6 0 0 1 6 6" />
        </svg>
      </button>
      <button
        type="button"
        className="grid size-7 cursor-pointer place-items-center rounded border border-line bg-panel text-muted hover:border-[#b7bfc8] hover:text-ink focus-visible:outline-2 focus-visible:outline-orange disabled:cursor-default disabled:opacity-40 disabled:hover:border-line disabled:hover:text-muted"
        data-action="redo"
        aria-label="Redo limit change"
        title="Redo (Cmd/Ctrl+Shift+Z)"
        disabled={!history.canRedo}
        onClick={onRedo}
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m15 7 5 5-5 5" /><path d="M19 12h-8a6 6 0 0 0-6 6" />
        </svg>
      </button>
    </div>
  );
}

function formatTick(value: number, unit: string): string {
  if (value === 0) return unit === "USD" ? "$0" : "0";
  if (unit === "USD") return value >= 10 ? `$${compactValue(value, unit)}` : money(value);
  return compactValue(value, unit);
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

