import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { cycleCumulative, freeRemainingSeries, monthlyCycles, type CycleBounds, type DayPoint } from "../components/limits-chart/cycles";
import { windowDefaults } from "../components/limits-chart/defaults";
import type { LevelValues } from "../components/limits-chart/levels";
import { LimitsChart, PLOT, levelColor } from "../components/limits-chart/LimitsChart";
import { Button, Eyebrow, StepMarker } from "../components/ui";
import type { AlertLevel, Policy } from "../types";
import { normalizeRiskTolerance } from "./risk-tolerance";

/**
 * The chart guide: an unnumbered card between the risk-tolerance step and the
 * limit steps that teaches the limit charts one layer at a time. Both charts
 * (daily and billing cycle) are visible from the first stage, over one fixed
 * sample meter series built to hold every layer the story needs (level
 * crossings, an included allotment, an exhausted cycle, a projection), so the
 * data never changes mid-story. Each stage presents one pointer card at a
 * time, with pagination dots under its footer label. Next and Back traverse
 * those cards before crossing a stage boundary. The level values come from
 * the viewer's own risk-tolerance percentages. The chart itself is inert;
 * the final stage demonstrates movement with an animated pointer. The card
 * stays in the flow after it finishes, so every position remains replayable.
 */

type StageKey = "charts" | "levels" | "alerts" | "free" | "motion";

/** Included allotment for the sample meter: 10M requests per billing cycle. */
const SAMPLE_INCLUDED = 10_000_000;

/** Deterministic wobble in [0.85, 1.15); the tour must replay identically. */
function wobble(seed: number): number {
  return 0.85 + 0.3 * (((Math.sin(seed * 12.9898) * 43758.5453) % 1 + 1) % 1);
}

/**
 * Two full billing cycles plus the current partial one. The first cycle stays
 * under the allotment (a free-usage-remaining marker), the second carries a
 * mid-cycle spike that crosses every tolerance level and exhausts the
 * allotment (bells, an exhaustion diamond, a billable edge), and the current
 * cycle runs at the normal pace so the projection wedge has room.
 */
function sampleSeries(today: string, cycles: CycleBounds[]): DayPoint[] {
  const DAY = 86_400_000;
  const from = cycles[0]!.startsAt;
  const to = Date.parse(`${today}T00:00:00Z`);
  const series: DayPoint[] = [];
  for (let at = from, index = 0; at <= to; at += DAY, index += 1) {
    const cycle = cycles.findIndex(bounds => at >= bounds.startsAt && at < bounds.endsAt);
    const dayOfCycle = Math.round((at - (cycles[cycle]?.startsAt ?? from)) / DAY) + 1;
    const weekday = new Date(at).getUTCDay();
    let value = 250_000 * (weekday === 0 || weekday === 6 ? 0.62 : 1) * wobble(index);
    // The teaching spike: cycle 2, days 10-22, ramping to 5.5x on day 16.
    if (cycle === 1 && dayOfCycle >= 10 && dayOfCycle <= 22) value *= 1 + 4.5 * (1 - Math.abs(dayOfCycle - 16) / 7);
    series.push({ day: new Date(at).toISOString().slice(0, 10), value: Math.round(value), sealed: at < to });
  }
  return series;
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * One pointer label: a chip anchored at a fraction of its chart's box, with a
 * curved connector down to a rendered chart feature found by selector. `nth`
 * picks among multiple matches as a 0..1 fraction of the list; `tx`/`ty`
 * choose the anchor point inside the target's box. A missing target (a layer
 * the current data does not produce) renders nothing.
 */
interface CalloutSpec { chart: "day" | "cycle"; selector?: string; nth?: number; tx?: number; ty?: number; x: number; y: number; center?: boolean; text: string; target?(wrapper: HTMLElement): Element | null }
type CalloutPhase = "hidden" | "exiting" | "retracting" | "moving" | "appearing" | "drawing" | "shown";
const CALLOUT_RETRACT_MS = 160;
const CALLOUT_MOVE_MS = 520;
const CALLOUT_FADE_MS = 180;
const CALLOUT_DRAW_MS = 320;

/**
 * One persistent card shared by both charts. Pagination retracts its arm,
 * moves and resizes the card, then draws the next arm. Section changes fade
 * the old card before chart motion and reveal the next card after it settles.
 */
function Callout({ host, dayHost, cycleHost, spec, number, group, delay }: {
  host: RefObject<HTMLDivElement | null>;
  dayHost: RefObject<HTMLDivElement | null>;
  cycleHost: RefObject<HTMLDivElement | null>;
  spec: CalloutSpec;
  number: number;
  group: StageKey;
  delay: number;
}) {
  const [displayed, setDisplayed] = useState(spec);
  const [displayedNumber, setDisplayedNumber] = useState(number);
  const [phase, setPhase] = useState<CalloutPhase>("hidden");
  const settledGroup = useRef<StageKey | null>(null);
  const requested = useRef<{ spec: CalloutSpec; number: number; group: StageKey } | null>(null);
  useEffect(() => {
    const requestChanged = requested.current?.spec !== spec || requested.current?.number !== number || requested.current?.group !== group;
    requested.current = { spec, number, group };
    const groupChanged = settledGroup.current !== group;
    // A settle-delay update can restart an unfinished section transition. It
    // must not replay a card after that section has finished appearing.
    if (!requestChanged && !groupChanged) return;
    if (reducedMotion()) {
      settledGroup.current = group;
      setDisplayed(spec);
      setDisplayedNumber(number);
      setPhase("shown");
      return;
    }
    if (groupChanged) {
      const first = settledGroup.current === null;
      setPhase(first ? "hidden" : "exiting");
      const switchAt = Math.max(first ? 0 : CALLOUT_RETRACT_MS, delay);
      const revealAt = switchAt + 50;
      const switchTimer = window.setTimeout(() => {
        setDisplayed(spec);
        setDisplayedNumber(number);
        setPhase("hidden");
      }, switchAt);
      const revealTimer = window.setTimeout(() => {
        settledGroup.current = group;
        setPhase("appearing");
      }, revealAt);
      const drawTimer = window.setTimeout(() => setPhase("drawing"), revealAt + CALLOUT_FADE_MS);
      const shownTimer = window.setTimeout(() => setPhase("shown"), revealAt + CALLOUT_FADE_MS + CALLOUT_DRAW_MS);
      return () => [switchTimer, revealTimer, drawTimer, shownTimer].forEach(window.clearTimeout);
    }
    setPhase("retracting");
    const switchAt = CALLOUT_RETRACT_MS;
    const drawAt = switchAt + CALLOUT_MOVE_MS;
    const switchTimer = window.setTimeout(() => {
      setDisplayed(spec);
      setDisplayedNumber(number);
      setPhase("moving");
    }, switchAt);
    const drawTimer = window.setTimeout(() => setPhase("drawing"), drawAt);
    const shownTimer = window.setTimeout(() => setPhase("shown"), drawAt + CALLOUT_DRAW_MS);
    return () => [switchTimer, drawTimer, shownTimer].forEach(window.clearTimeout);
  }, [spec, number, group, delay]);

  const measureRef = useRef<HTMLSpanElement>(null);
  const [chip, setChip] = useState<{ w: number; h: number } | null>(null);
  const [layout, setLayout] = useState<{ w: number; h: number; labelX: number; labelY: number; targetX?: number; targetY?: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const wrapper = host.current;
      const chart = displayed.chart === "day" ? dayHost.current : cycleHost.current;
      if (!wrapper || !chart) return;
      const box = wrapper.getBoundingClientRect();
      const chartBox = chart.getBoundingClientRect();
      const next = {
        w: box.width,
        h: box.height,
        labelX: chartBox.left - box.left + displayed.x * chartBox.width,
        labelY: chartBox.top - box.top + displayed.y * chartBox.height,
      } as { w: number; h: number; labelX: number; labelY: number; targetX?: number; targetY?: number };
      const matches = displayed.selector ? [...chart.querySelectorAll(displayed.selector)] : [];
      const target = displayed.target
        ? displayed.target(chart)
        : matches[Math.max(0, Math.min(matches.length - 1, Math.round((displayed.nth ?? 0.5) * (matches.length - 1))))];
      if (target) {
        const rect = target.getBoundingClientRect();
        next.targetX = rect.left - box.left + rect.width * (displayed.tx ?? 0.5);
        next.targetY = rect.top - box.top + rect.height * (displayed.ty ?? 0.5);
      }
      setLayout(next);
      const card = measureRef.current;
      if (card?.offsetWidth && card.offsetHeight) setChip({ w: card.offsetWidth, h: card.offsetHeight });
    };
    measure();
    const frame = requestAnimationFrame(() => requestAnimationFrame(measure));
    const timers = [250, 600, Math.max(700, delay), delay + 250].map(at => window.setTimeout(measure, at));
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (host.current) observer?.observe(host.current);
    window.addEventListener("resize", measure);
    return () => { cancelAnimationFrame(frame); timers.forEach(window.clearTimeout); observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [displayed, host, dayHost, cycleHost, delay]);
  if (!layout) return null;

  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  const cardWidth = chip?.w ?? 250;
  const cardHeight = chip?.h ?? 48;
  const cardLeft = clamp(layout.labelX - cardWidth / 2, 4, Math.max(4, layout.w - cardWidth - 4));
  const cardTop = clamp(layout.labelY - (displayed.center ? cardHeight / 2 : cardHeight + 3), 4, Math.max(4, layout.h - cardHeight - 4));
  const arm = (() => {
    if (layout.targetX === undefined || layout.targetY === undefined) return null;
    const box = { left: cardLeft, right: cardLeft + cardWidth, top: cardTop, bottom: cardTop + cardHeight };
    const start = layout.targetY > box.bottom
      ? { x: clamp(layout.targetX, box.left + 10, box.right - 10), y: box.bottom }
      : layout.targetY < box.top
        ? { x: clamp(layout.targetX, box.left + 10, box.right - 10), y: box.top }
        : { x: layout.targetX < layout.labelX ? box.left : box.right, y: clamp(layout.targetY, box.top + 8, box.bottom - 8) };
    const vertical = start.y === box.bottom || start.y === box.top;
    const midX = (start.x + layout.targetX) / 2;
    const midY = (start.y + layout.targetY) / 2;
    const curve = vertical
      ? `C ${start.x} ${midY}, ${layout.targetX} ${midY}, ${layout.targetX} ${layout.targetY}`
      : `C ${midX} ${start.y}, ${midX} ${layout.targetY}, ${layout.targetX} ${layout.targetY}`;
    return `M ${start.x} ${start.y} ${curve}`;
  })();
  const indicatorShown = phase === "drawing" || phase === "shown";
  const cardVisible = phase !== "hidden" && phase !== "exiting";
  const positionDuration = phase === "moving" ? CALLOUT_MOVE_MS : 0;
  return (
    <div data-tour-callout data-tour-card-index={displayedNumber - 1} data-tour-phase={phase} className="pointer-events-none absolute inset-0 z-10">
      {arm && <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
        <path data-tour-indicator d={arm} pathLength={1} fill="none" stroke="var(--ink)" strokeWidth="1.25" opacity=".4"
          style={{ strokeDasharray: 1, strokeDashoffset: indicatorShown ? 0 : 1, transition: `stroke-dashoffset ${phase === "retracting" || phase === "exiting" ? CALLOUT_RETRACT_MS : CALLOUT_DRAW_MS}ms cubic-bezier(.2,.7,.2,1)` }} />
        <circle cx={layout.targetX} cy={layout.targetY} r="3" fill="var(--ink)" opacity={indicatorShown ? ".65" : "0"} style={{ transition: `opacity ${CALLOUT_DRAW_MS}ms` }} />
      </svg>}
      <span ref={measureRef} aria-hidden="true" className="invisible absolute -left-[10000px] top-0 flex w-max max-w-[250px] items-start gap-1.5 rounded-[6px] border py-1.5 pl-1.5 pr-2.5">
        <i className="grid size-[17px] flex-none place-items-center rounded-full text-[10.5px] font-bold not-italic">{displayedNumber}</i>
        <span className="text-balance text-[11.5px] font-[560] leading-[1.45]">{displayed.text}</span>
      </span>
      <span data-tour-card className="absolute flex max-w-[250px] items-start gap-1.5 overflow-hidden rounded-[6px] border border-line bg-panel py-1.5 pl-1.5 pr-2.5 shadow-[0_2px_8px_rgba(0,0,0,.1)]"
        style={{ left: cardLeft, top: cardTop, width: chip?.w, height: chip?.h, opacity: cardVisible ? 1 : 0, transition: `left ${positionDuration}ms cubic-bezier(.2,.7,.2,1), top ${positionDuration}ms cubic-bezier(.2,.7,.2,1), width ${positionDuration}ms cubic-bezier(.2,.7,.2,1), height ${positionDuration}ms cubic-bezier(.2,.7,.2,1), opacity ${phase === "exiting" ? CALLOUT_RETRACT_MS : CALLOUT_FADE_MS}ms` }}>
        <i className="grid size-[17px] flex-none place-items-center rounded-full bg-orange text-[10.5px] font-bold not-italic text-white">{displayedNumber}</i>
        <span className="text-balance text-[11.5px] font-[560] leading-[1.45] text-ink">{displayed.text}</span>
      </span>
    </div>
  );
}

/**
 * The pointer demonstration: an animated cursor approaches the lowest level's
 * handle, drags it down through the bars, holds, and returns, on a loop. The
 * cursor tracks the rendered diamond each frame, so it follows the chart's
 * own easing exactly. Skipped entirely under reduced motion.
 */
function useCursorDemo(active: boolean, host: RefObject<HTMLDivElement | null>, defaults: LevelValues, targetId: string | undefined, apply: (values: LevelValues | null) => void) {
  useEffect(() => {
    if (!active || !targetId || !((defaults[targetId] ?? 0) > 0) || reducedMotion()) return;
    const wrapper = host.current;
    const cursor = wrapper?.querySelector<SVGSVGElement>("[data-tour-cursor]");
    if (!wrapper || !cursor) return;
    const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
    // One pass only: approach quickly, drag down, hold, return, then rest.
    const APPROACH = 600, PRESS = 250, DRAG = 1500, HOLD = 700, RISE = 1500;
    const dragStart = APPROACH + PRESS;
    const total = dragStart + DRAG + HOLD + RISE;
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const at = now - started;
      if (at >= total) {
        cursor.style.visibility = "hidden";
        apply(null);
        return;
      }
      let factor = 1;
      if (at >= dragStart && at < dragStart + DRAG) factor = 1 - 0.55 * ease((at - dragStart) / DRAG);
      else if (at >= dragStart + DRAG && at < dragStart + DRAG + HOLD) factor = 0.45;
      else if (at >= dragStart + DRAG + HOLD && at < dragStart + DRAG + HOLD + RISE) factor = 0.45 + 0.55 * ease((at - (dragStart + DRAG + HOLD)) / RISE);
      apply(factor === 1 ? null : { ...defaults, [targetId]: defaults[targetId]! * factor });
      const diamond = wrapper.querySelector(`[data-level-line="${targetId}"] polygon`);
      if (diamond) {
        const wrapperRect = wrapper.getBoundingClientRect();
        const rect = diamond.getBoundingClientRect();
        const targetX = rect.left + rect.width / 2 - wrapperRect.left;
        const targetY = rect.top + rect.height / 2 - wrapperRect.top;
        let x = targetX;
        let y = targetY;
        if (at < APPROACH) {
          const t = ease(at / APPROACH);
          x = wrapperRect.width * 0.6 + (targetX - wrapperRect.width * 0.6) * t;
          y = wrapperRect.height * 0.72 + (targetY - wrapperRect.height * 0.72) * t;
        }
        const pressed = at >= APPROACH + PRESS / 2 && at < dragStart + DRAG + HOLD + RISE;
        cursor.style.visibility = "visible";
        cursor.style.transform = `translate(${x - 3}px, ${y - 2}px) scale(${pressed ? 0.88 : 1})`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      cursor.style.visibility = "hidden";
      apply(null);
    };
  }, [active, host, defaults, targetId, apply]);
}

/** Every green or billable overlay the free-usage sweep reveals. */
const FREE_SWEEP_GROUPS = "[data-free-left], [data-free-left-edge], [data-included-base], [data-included-usage], [data-included-boundary], [data-billable-edge], [data-projection-included]";
const FREE_SWEEP_IN_MS = 2200;

/**
 * The free-usage reveal: one shared date front crosses both charts, so the
 * two charts correspond day for day at every moment. The front's day rate is
 * adaptive: a day's share of the timeline grows with its usage, so the steep
 * burndown drop takes visible time instead of flashing past, while quiet days
 * move quickly. Within the spike cycle the green edge draws first, its
 * diamond pops the moment the front reaches it, and the billable edge
 * continues from there because it sits later on the date axis. The front is a
 * clip on the plot area, driven per frame. Skipped under reduced motion.
 */
function useFreeSweep(mode: "in" | "out" | null, hosts: Array<RefObject<HTMLDivElement | null>>, weights: number[]) {
  // Layout effect: the first painted frame of the stage must already be clipped.
  useLayoutEffect(() => {
    if (!mode || reducedMotion() || !weights.length) return;
    // Stepping back plays the same sweep in reverse, at a brisker pace.
    const total = mode === "in" ? FREE_SWEEP_IN_MS : 1100;
    const cumulative: number[] = [0];
    for (const weight of weights) cumulative.push(cumulative[cumulative.length - 1]! + weight);
    const weightTotal = cumulative[cumulative.length - 1]!;
    const charts = hosts.flatMap(host => {
      const wrapper = host.current;
      const svg = wrapper?.querySelector("svg");
      if (!wrapper || !svg) return [];
      const width = svg.viewBox.baseVal.width || svg.getBoundingClientRect().width;
      const markers = [...wrapper.querySelectorAll<SVGGElement>("[data-free-exhausted], [data-free-remaining], [data-billable-marker]")].map(marker => {
        const box = marker.getBBox();
        marker.style.transformBox = "fill-box";
        marker.style.transformOrigin = "center";
        marker.style.opacity = mode === "in" ? "0" : "1";
        marker.style.transform = mode === "in" ? "scale(.4)" : "";
        return { marker, x: box.x + box.width / 2, shown: mode === "out" };
      });
      return [{ width, groups: [...wrapper.querySelectorAll<SVGElement>(FREE_SWEEP_GROUPS)], markers }];
    });
    if (!charts.length) return;
    // Date fraction reached at `at` ms: spend the elapsed share of the total
    // weight, then convert the day it lands in back to a plot fraction.
    const fractionAt = (at: number) => {
      const progress = Math.min(1, Math.max(0, at / total));
      const spent = (mode === "in" ? progress : 1 - progress) * weightTotal;
      let day = cumulative.length - 2;
      for (let index = 0; index < weights.length; index += 1) {
        if (spent <= cumulative[index + 1]!) { day = index; break; }
      }
      const within = weights[day]! > 0 ? (spent - cumulative[day]!) / weights[day]! : 1;
      return (day + within) / weights.length;
    };
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const at = now - started;
      const fraction = fractionAt(at);
      for (const chart of charts) {
        const frontX = PLOT.left + (chart.width - PLOT.left - PLOT.right) * fraction;
        const clip = `inset(${PLOT.top}px ${Math.max(0, chart.width - frontX)}px ${PLOT.bottom}px ${PLOT.left}px) view-box`;
        for (const group of chart.groups) group.style.clipPath = mode === "out" || at < total ? clip : "";
        for (const item of chart.markers) {
          if (item.shown !== frontX >= item.x - 1) {
            item.shown = !item.shown;
            item.marker.style.transition = "opacity 250ms, transform 250ms";
            item.marker.style.opacity = item.shown ? "1" : "0";
            item.marker.style.transform = item.shown ? "" : "scale(.4)";
          }
        }
      }
      if (at < total + 400) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      for (const chart of charts) {
        for (const group of chart.groups) group.style.clipPath = "";
        for (const item of chart.markers) {
          for (const property of ["opacity", "transform", "transition", "transformBox", "transformOrigin"] as const) item.marker.style[property] = "";
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hosts is a stable pair of refs
  }, [mode, weights]);
}

const noop = () => {};

/**
 * The topmost color segment of the tallest day bar: each day's base segment
 * carries data-day-bar, its sibling rects stack the level colors above it,
 * and the last rect in the tallest day's group is the highest-level slice.
 */
function tallestBarTopSegment(wrapper: HTMLElement): Element | null {
  let best: Element | null = null;
  let bestHeight = 0;
  for (const base of wrapper.querySelectorAll("[data-day-bar]")) {
    const group = base.parentElement;
    if (!group) continue;
    const height = group.getBoundingClientRect().height;
    if (height > bestHeight) { bestHeight = height; best = group; }
  }
  const rects = best?.querySelectorAll("rect");
  return rects?.length ? rects[rects.length - 1]! : null;
}

/** Pointer cards hold back until each stage's chart animation has settled. */
// motion covers the pointer demo's full single pass (600+250+1500+700+1500ms).
const CALLOUT_SETTLE_MS: Record<StageKey, number> = { charts: 450, levels: 1000, alerts: 1000, free: FREE_SWEEP_IN_MS + 200, motion: 4700 };

/**
 * Which chart layers each stage shows. Stepping in either direction diffs
 * these targets: a layer turning on mounts and plays its entrance; a layer
 * turning off holds through an exit phase (its entrance in reverse) before it
 * unmounts, so walking backward unwinds the story. Pointer cards never
 * reverse; a stage reached without a big layer change shows them promptly.
 */
type LayerKey = "levels" | "alarms" | "quota";
const LAYER_TARGETS: Record<StageKey, Record<LayerKey, boolean>> = {
  charts: { levels: false, alarms: false, quota: false },
  levels: { levels: true, alarms: false, quota: false },
  alerts: { levels: true, alarms: true, quota: false },
  free: { levels: true, alarms: false, quota: true },
  motion: { levels: true, alarms: false, quota: true },
};
const LAYER_EXIT_MS: Record<LayerKey, number> = { levels: 950, alarms: 750, quota: 1150 };

function useStageLayers(stageKey: StageKey) {
  const [layers, setLayers] = useState(() => LAYER_TARGETS[stageKey]);
  const [exiting, setExiting] = useState<LayerKey[]>([]);
  const [sweepMode, setSweepMode] = useState<"in" | "out" | null>(null);
  const [settle, setSettle] = useState(CALLOUT_SETTLE_MS[stageKey]);
  // Counts entrances of the level lines; the intro glide keys off it.
  const [levelsEntrance, setLevelsEntrance] = useState(0);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const exitingRef = useRef(exiting);
  exitingRef.current = exiting;
  const stageRef = useRef(stageKey);
  stageRef.current = stageKey;

  useLayoutEffect(() => {
    const target = LAYER_TARGETS[stageKey];
    const current = layersRef.current;
    const keys = Object.keys(target) as LayerKey[];
    const entering = keys.filter(key => target[key] && !current[key]);
    const leaving = keys.filter(key => !target[key] && current[key] && !exitingRef.current.includes(key));
    // A layer wanted again cancels its running exit and stays mounted.
    setExiting(previous => previous.filter(key => !target[key]));
    // Outros finish before intros start: entering layers hold until the
    // longest exit completes, so the two motions never overlap.
    const hold = leaving.length && !reducedMotion() ? Math.max(...leaving.map(key => LAYER_EXIT_MS[key])) : 0;
    const mountEntering = () => {
      const wanted = entering.filter(key => LAYER_TARGETS[stageRef.current][key] && !layersRef.current[key]);
      if (!wanted.length) return;
      setLayers(previous => ({ ...previous, ...Object.fromEntries(wanted.map(key => [key, true])) }));
      if (wanted.includes("quota")) setSweepMode("in");
      if (wanted.includes("levels")) setLevelsEntrance(count => count + 1);
    };
    if (entering.length) {
      if (hold) setTimeout(mountEntering, hold);
      else mountEntering();
    }
    const quickArrival = (stageKey === "free" && !entering.includes("quota")) || (stageKey === "levels" && !entering.includes("levels"));
    setSettle(hold + (quickArrival ? 350 : CALLOUT_SETTLE_MS[stageKey]));
    for (const key of leaving) {
      if (key === "quota") setSweepMode("out");
      setExiting(previous => [...previous, key]);
      // The timer outlives stage changes on purpose: it re-checks the current
      // stage's targets before unmounting, so rapid stepping cannot strand a
      // layer mid-exit.
      setTimeout(() => {
        setExiting(previous => previous.filter(item => item !== key));
        if (LAYER_TARGETS[stageRef.current][key]) return;
        setLayers(previous => ({ ...previous, [key]: false }));
        if (key === "quota") setSweepMode(null);
      }, reducedMotion() ? 0 : LAYER_EXIT_MS[key]);
    }
  }, [stageKey]);

  return { layers, exiting, sweepMode, settle, levelsEntrance };
}

const STAGES: Array<{ key: StageKey; title: string; short: string; pages: number }> = [
  { key: "charts", title: "Your days and your billing cycle", short: "Charts", pages: 4 },
  { key: "levels", title: "Your alert levels", short: "Levels", pages: 2 },
  { key: "alerts", title: "Where alerts fire", short: "Alerts", pages: 2 },
  { key: "free", title: "Free usage", short: "Free usage", pages: 3 },
  { key: "motion", title: "Levels move", short: "Adjust", pages: 2 },
];

export function ChartTour({ levels, policy, done, onDone }: {
  levels: AlertLevel[];
  policy: Policy;
  /** The tour was finished or skipped earlier; the card stays for replay without wizard side effects. */
  done: boolean;
  onDone: () => void;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const tourHostRef = useRef<HTMLDivElement>(null);
  const dayHostRef = useRef<HTMLDivElement>(null);
  const cycleHostRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState(0);
  const [demoValues, setDemoValues] = useState<LevelValues | null>(null);

  const order = useMemo(() => levels.map(level => level.id), [levels]);
  const chartLevels = useMemo(() => levels.map((level, position) => ({ id: level.id, label: level.label, color: levelColor(position, levels.length) })), [levels]);
  const tolerance = useMemo(() => normalizeRiskTolerance(policy.riskTolerance, order).percentOfTypical, [policy.riskTolerance, order]);

  // One sample dataset for the whole story, built once per mount.
  const sample = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - 2);
    const cycles = monthlyCycles(start.toISOString().slice(0, 10), today);
    return { today, cycles, series: sampleSeries(today, cycles) };
  }, []);
  const dayValues = useMemo(
    () => windowDefaults(sample.series, sample.cycles, sample.today, order, "day", tolerance, undefined, SAMPLE_INCLUDED) ?? {},
    [sample, order, tolerance],
  );
  const cycleValues = useMemo(
    () => windowDefaults(sample.series, sample.cycles, sample.today, order, "cycle", tolerance, undefined, SAMPLE_INCLUDED) ?? {},
    [sample, order, tolerance],
  );

  const stage = STAGES[Math.min(index, STAGES.length - 1)]!;
  // Orchestrated layers: entrances on mount, reversed exits when stepping
  // back. A stage with disabled levels still passes them, so they shape the
  // axis from the start and the scale holds across stages.
  const { layers, exiting, sweepMode, settle, levelsEntrance } = useStageLayers(stage.key);
  const levelsOff = useMemo(() => Object.fromEntries(chartLevels.map(level => [level.id, false])), [chartLevels]);
  const levelEnabled = layers.levels ? undefined : levelsOff;
  const quotaOn = layers.quota;

  const callouts = useMemo<CalloutSpec[]>(() => {
    const lowest = chartLevels[0]?.id ?? "";
    const highest = chartLevels.at(-1)?.id ?? "";
    switch (stage.key) {
      case "charts": return [
        { chart: "day", x: 0.3, y: 0.5, text: "The Limit Chart is the primary interface for adjusting alert levels in Brolly. Learn to use it, and you'll know how to use Brolly." },
        { chart: "day", selector: "[data-day-bar]", nth: 0.82, tx: 0.5, ty: 0, x: 0.68, y: 0.32, text: "Each bar is one day of usage. Taller bars are busier days." },
        { chart: "cycle", selector: "[data-cycle-total]", nth: 0, tx: 0.85, ty: 0.1, x: 0.42, y: 0.32, text: "This chart adds the same days into a running total, which starts over when a new billing cycle begins." },
        { chart: "cycle", selector: "[data-cycle-projection]", tx: 0.55, ty: 0.35, x: 0.82, y: 0.46, text: "The dotted area shows where this cycle is headed at its current pace." },
      ];
      case "levels": return [
        { chart: "day", selector: `[data-level-line="${highest}"]`, tx: 0.88, ty: 0.5, x: 0.8, y: 0.34, text: "The dashed lines are your alert levels. They start where your risk tolerance put them, and you can move any of them later." },
        { chart: "cycle", selector: `[data-level-line="${highest}"]`, tx: 0.62, ty: 0.5, x: 0.55, y: 0.26, text: "The cycle chart gets its own levels. They catch steady growth that no single day would reveal." },
      ];
      case "alerts": return [
        { chart: "day", selector: "[data-alarm-badge]", nth: 0, x: 0.3, y: 0.26, text: "Brolly alerts you the moment usage reaches a threshold, even in the middle of a day." },
        { chart: "day", target: tallestBarTopSegment, tx: 0.5, ty: 0.4, x: 0.78, y: 0.24, text: "The part of a bar above a line takes that threshold's color, so you can see how far over the day went." },
      ];
      case "free": return [
        { chart: "day", selector: "[data-free-left]", tx: 0.18, ty: 0.3, x: 0.32, y: 0.26, text: "The green area is your remaining free usage quota included in your Cloudflare plan. It reduces over time in relation to each day's usage." },
        { chart: "cycle", selector: "[data-free-exhausted]", x: 0.4, y: 0.28, text: "This diamond marks the day that your free usage quota was exhausted. Usage after this point is billable for the remainder of your billing cycle." },
        { chart: "cycle", selector: "[data-included-usage]", nth: 1, tx: 0.7, ty: 0.75, x: 0.84, y: 0.5, text: "Usage below the green line is included in your Cloudflare plan's free quota." },
      ];
      case "motion": return [
        { chart: "day", selector: `[data-level-line="${lowest}"] polygon`, x: 0.4, y: 0.28, text: "The initial placement of your levels is determined by your defined risk tolerance, but you can freely adjust them at will." },
        { chart: "cycle", selector: `[data-level-line="${lowest}"]`, tx: 0.6, ty: 0.5, x: 0.5, y: 0.5, center: true, text: "Tune your limits between daily and cycle usage to fit your needs. In the next steps you'll define global spend thresholds and then (optionally) per product spend and usage limits across every billable metric." },
      ];
    }
  }, [stage.key, chartLevels]);
  const activeCallout = callouts[Math.min(page, callouts.length - 1)]!;
  const selectPosition = (nextIndex: number, nextPage = 0) => {
    setIndex(nextIndex);
    setPage(Math.max(0, Math.min(STAGES[nextIndex]!.pages - 1, nextPage)));
  };
  const next = () => {
    if (page < stage.pages - 1) { setPage(page + 1); return; }
    if (index < STAGES.length - 1) { selectPosition(index + 1); return; }
    if (done) sectionRef.current?.nextElementSibling?.scrollIntoView({ behavior: "smooth", block: "start" });
    else onDone();
  };
  const back = () => {
    if (page > 0) { setPage(page - 1); return; }
    if (index > 0) selectPosition(index - 1, STAGES[index - 1]!.pages - 1);
  };

  useCursorDemo(stage.key === "motion" && page === 0, dayHostRef, dayValues, chartLevels[0]?.id, setDemoValues);
  // One weight per plotted day (the window runs to the current cycle's end).
  // A day's weight follows how far the free-usage line VISIBLY falls that
  // day. The day chart's axis tops out around its bars and levels, so the
  // remaining-quota line sits off the top of the plot until it descends into
  // range; drops above that ceiling are invisible and get no extra time. The
  // front slows only where the line is on screen and steep.
  const sweepWeights = useMemo(() => {
    const DAY = 86_400_000;
    const start = sample.cycles[0]?.startsAt ?? 0;
    const end = sample.cycles.at(-1)?.endsAt ?? start + DAY;
    const visibleTop = Math.max(...sample.series.map(point => point.value), ...order.map(id => dayValues[id] ?? 0));
    const drops = new Map(freeRemainingSeries(sample.series, sample.cycles, SAMPLE_INCLUDED)
      .map(point => [point.day, Math.max(0, Math.min(point.before, visibleTop) - Math.min(point.after, visibleTop))]));
    const steepest = Math.max(1, ...drops.values());
    return Array.from({ length: Math.max(1, Math.round((end - start) / DAY)) }, (_, index) => {
      const drop = drops.get(new Date(start + index * DAY).toISOString().slice(0, 10)) ?? 0;
      return 1 + 7 * (drop / steepest) ** 0.8;
    });
  }, [sample, order, dayValues]);
  useFreeSweep(sweepMode, [dayHostRef, cycleHostRef], sweepWeights);

  // Levels enter as a tight group at the top of each chart, then glide down
  // together to their resting values on the chart's own (slowed) transition.
  // On exit the same grouped values pull them back up while they fade out.
  const [levelIntro, setLevelIntro] = useState<{ day: LevelValues; cycle: LevelValues } | null>(null);
  const grouped = useMemo(() => {
    const groupedAt = (top: number): LevelValues => Object.fromEntries(order.map((id, position) => [id, top * (0.99 - 0.028 * (order.length - 1 - position))]));
    return {
      day: groupedAt(Math.max(...sample.series.map(point => point.value), ...order.map(id => dayValues[id] ?? 0))),
      cycle: groupedAt(Math.max(...cycleCumulative(sample.series, sample.cycles).map(point => point.cumulative), ...order.map(id => cycleValues[id] ?? 0))),
    };
  }, [sample, order, dayValues, cycleValues]);
  const levelsExiting = exiting.includes("levels");
  // The glide is a value tween, so the lines AND the bar fills they color
  // move together frame by frame; a CSS transition would move only the lines
  // while the fills snapped. Layout effect: the first frame must already sit
  // at the tween's start. Fade in and out stay CSS-driven.
  useLayoutEffect(() => {
    if (reducedMotion()) { setLevelIntro(null); return; }
    const resting = { day: dayValues, cycle: cycleValues };
    const lerp = (from: LevelValues, to: LevelValues, t: number): LevelValues =>
      Object.fromEntries(order.map(id => [id, (from[id] ?? 0) + ((to[id] ?? 0) - (from[id] ?? 0)) * t]));
    const run = (from: typeof grouped, to: typeof grouped, clearAfter: boolean) => {
      const ease = (t: number) => t * t * (3 - 2 * t);
      const started = performance.now();
      let frame = 0;
      const tick = (now: number) => {
        const t = Math.min(1, (now - started) / 900);
        setLevelIntro({ day: lerp(from.day, to.day, ease(t)), cycle: lerp(from.cycle, to.cycle, ease(t)) });
        if (t < 1) frame = requestAnimationFrame(tick);
        else if (clearAfter) setLevelIntro(null);
      };
      setLevelIntro(from);
      frame = requestAnimationFrame(tick);
      return () => { cancelAnimationFrame(frame); setLevelIntro(null); };
    };
    if (levelsExiting) return run(resting, grouped, false);
    if (levelsEntrance && stage.key === "levels") return run(grouped, resting, true);
    setLevelIntro(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on entrance and exit transitions
  }, [levelsEntrance, levelsExiting]);

  // Opening scroll happens only when the card appears mid-onboarding, never
  // when a finished card mounts with the rest of the wizard.
  useEffect(() => {
    if (!done) requestAnimationFrame(() => sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);

  return (
    <section ref={sectionRef} data-chart-tour className="min-w-0 scroll-mt-[76px] rounded-[12px] border border-line bg-panel p-[clamp(26px,4vw,48px)] shadow-panel max-md:scroll-mt-[116px] max-md:px-4 max-md:py-[22px]" aria-label="How to read the limit charts">
      <Eyebrow tone="orange">Chart guide</Eyebrow>
      <h2 className="text-[27px] tracking-[-.025em]">How to read the limit charts</h2>
      <p className="mb-6 mt-1 text-[12.5px] text-faint">This guide uses sample data. The steps after it use your account's real usage.</p>
      <div ref={tourHostRef} data-tour-stage={stage.key} data-tour-page={page} data-tour-exit={exiting.join(" ") || undefined} className="relative grid grid-cols-2 gap-5 max-xl:grid-cols-1">
        {/* Fixed cell height keeps the footer controls stationary. */}
        <div ref={dayHostRef} className="relative min-h-[300px] min-w-0">
          <LimitsChart kind="usage" unit="requests" window="day" series={sample.series} cycles={sample.cycles} today={sample.today}
            title="Daily chart" titleIndent levels={chartLevels} levelEnabled={levelEnabled}
            value={stage.key === "motion" && demoValues ? demoValues : levelIntro?.day ?? dayValues}
            includedPerCycle={quotaOn ? SAMPLE_INCLUDED : undefined}
            crossingAlarms={layers.alarms} fields={false}
            onChange={noop} readOnly pointerInteractions={false} label="Tour: daily chart" />
          {stage.key === "motion" && (
            <svg data-tour-cursor width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 z-10" style={{ visibility: "hidden" }}>
              <path d="M5 2.2 5 17.4 9 13.7 11.6 19.6 14.2 18.4 11.6 12.6 17 12.6 Z" fill="var(--ink)" stroke="var(--panel)" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          )}
        </div>
        <div ref={cycleHostRef} className="relative min-h-[300px] min-w-0">
          <LimitsChart kind="usage" unit="requests" window="cycle" series={sample.series} cycles={sample.cycles} today={sample.today}
            title="Billing cycle chart" titleIndent levels={chartLevels} levelEnabled={levelEnabled} value={levelIntro?.cycle ?? cycleValues} reference={dayValues}
            includedPerCycle={quotaOn ? SAMPLE_INCLUDED : undefined} fields={false}
            crossingAlarms={layers.alarms}
            onChange={noop} readOnly pointerInteractions={false} label="Tour: billing cycle chart" />
        </div>
        {activeCallout && <Callout host={tourHostRef} dayHost={dayHostRef} cycleHost={cycleHostRef} spec={activeCallout} number={page + 1} group={stage.key} delay={settle} />}
      </div>
      <footer className="mt-7 grid grid-cols-[1fr_auto_1fr] items-start gap-3 max-md:flex max-md:flex-wrap max-md:justify-between">
        <span aria-hidden="true" className="max-md:hidden" />
        <ol className="flex list-none items-center justify-self-center gap-1" aria-label="Tour progress">
          {STAGES.map((item, position) => (
            <li key={item.key} data-tour-section={item.key} className={`flex items-start text-[13px] font-[640] ${position === index ? "text-ink" : position < index ? "text-good" : "text-faint"}`}>
              {position > 0 && <span className="mx-1 mt-[17px] h-px w-3 bg-line max-lg:hidden" aria-hidden="true" />}
              <span className="flex flex-col items-center">
                <button type="button" className="group/tour-step flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-field border-0 bg-transparent px-1.5 py-1 text-left text-inherit hover:bg-panel-soft"
                  aria-current={position === index ? "step" : undefined} title={item.title} onClick={() => selectPosition(position)}>
                  <StepMarker className="max-lg:size-[22px] max-lg:text-[11px]" state={position === index ? "active" : position < index ? "done" : "todo"}>{position < index ? "✓" : position + 1}</StepMarker>
                  <span className="max-lg:sr-only group-hover/tour-step:text-ink">{item.short}</span>
                </button>
                <span className="-mt-0.5 flex w-full items-center justify-center gap-0.5 pl-9 max-lg:pl-0" aria-label={`${item.short} cards`}>
                  {Array.from({ length: item.pages }, (_, dot) => {
                    const active = position === index && dot === page;
                    const visited = position < index || (position === index && dot < page);
                    return <button key={dot} type="button" data-tour-page-dot={dot} aria-label={`${item.title}, card ${dot + 1} of ${item.pages}`} aria-current={active ? "true" : undefined}
                      className="grid size-2 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-orange"
                      onClick={() => selectPosition(position, dot)}><i className={`size-1 rounded-full ${active ? "bg-orange" : visited ? "bg-good" : "bg-line-strong"}`} /></button>;
                  })}
                </span>
              </span>
            </li>
          ))}
        </ol>
        <span className="flex flex-col items-end justify-self-end gap-1">
          <span className="flex items-center gap-2">
            <Button data-action="tour-back" disabled={index === 0 && page === 0} onClick={back}>Back</Button>
            {index < STAGES.length - 1 || page < stage.pages - 1
              ? <Button variant="primary" data-action="tour-next" onClick={next}>Next</Button>
              : <Button variant="primary" data-action="tour-next" onClick={next}>Set global spend limits</Button>}
          </span>
          {!done && <button type="button" data-action="tour-skip" className="border-0 bg-transparent p-1 text-[10.5px] font-[560] text-faint underline-offset-2 hover:text-muted hover:underline" onClick={onDone}>Skip tutorial</button>}
        </span>
      </footer>
    </section>
  );
}
