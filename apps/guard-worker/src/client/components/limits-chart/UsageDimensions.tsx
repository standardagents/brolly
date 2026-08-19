import { useEffect, useMemo, useState } from "react";
import { type CycleBounds, type DayPoint } from "./cycles";
import { deriveSeries } from "./defaults";
import { type LevelValues, crossedLevel } from "./levels";
import { chooseAxis } from "./scale";
import type { LimitsChartLevel } from "./LimitsChart";

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
