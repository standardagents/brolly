import { memo, useMemo } from "react";
import { type AggregationKind, type CycleBounds, type DayPoint, freeRemainingSeries, includedTops } from "./cycles";
import { deriveSeries } from "./defaults";
import { type LevelValues, crossedLevel } from "./levels";
import { chooseAxis } from "./scale";
import { INCLUDED_COLOR, type LimitsChartLevel } from "./LimitsChart";

/**
 * Miniature of the main chart: one thin bar per day, colored like the main
 * chart's bars (accent under every active line, the highest crossed level's
 * color above). In cycle mode the bars are the running total per billing
 * cycle, so the sawtooth and its level colors show at row scale.
 */
export const MiniChart = memo(function MiniChart({ series, cycles, today, window, levels, values, accent, includedPerCycle, poolSeries, aggregationKind = "sum", className }: {
  series: DayPoint[];
  cycles?: CycleBounds[];
  today?: string;
  window: "day" | "cycle";
  levels: LimitsChartLevel[];
  values: LevelValues;
  accent: string;
  /** Included allotment: the cycle band under the boundary renders green like the main chart. */
  includedPerCycle?: number;
  /** Shared-pool usage in this metric's units, when the allotment is shared. */
  poolSeries?: DayPoint[];
  aggregationKind?: AggregationKind;
  className?: string;
}) {
  const { bars, freeAreas } = useMemo(() => {
    const derived = deriveSeries(series, cycles, today, aggregationKind);
    const included = typeof includedPerCycle === "number" && Number.isFinite(includedPerCycle) && includedPerCycle > 0 ? includedPerCycle : undefined;
    let points = window === "cycle" ? derived.cumulative.map(point => point.cumulative) : derived.dense.map(point => point.value);
    const poolCumulative = window === "cycle" && included && poolSeries ? deriveSeries(poolSeries, cycles, today, aggregationKind).cumulative.map(point => point.cumulative) : undefined;
    let tops = window === "cycle" && included ? includedTops(points, poolCumulative, included) : [];
    // One bar per day fits the 120-unit viewBox for the usual three-cycle
    // window; only longer histories bucket to the peak per bucket.
    const MAX_BARS = 120;
    if (points.length > MAX_BARS) {
      const size = points.length / MAX_BARS;
      const buckets = Array.from({ length: MAX_BARS }, (_, bucket) => {
        const from = Math.floor(bucket * size);
        const to = Math.max(from + 1, Math.floor((bucket + 1) * size));
        let peak = from;
        for (let index = from + 1; index < to; index += 1) if (points[index]! > points[peak]!) peak = index;
        return peak;
      });
      points = buckets.map(peak => points[peak]!);
      if (tops.length) tops = buckets.map(peak => tops[peak]!);
    }
    const levelValues = levels.map(level => values[level.id] ?? 0);
    // Sparklines normalize to their own peak: the tallest day or cycle total
    // touches the top, and levels only color the bars, never the scale.
    const axis = chooseAxis(points);
    const order = levels.map(level => level.id);
    const colorById = new Map(levels.map(level => [level.id, level.color]));
    const width = 120;
    const height = 28;
    const slot = width / Math.max(1, points.length);
    const yFor = (value: number) => height - axis.position(value) * (height - 1);
    // Day sparklines carry the free burn-down behind the bars, one polygon per
    // cycle, clipped by the sparkline's own scale like the full chart.
    const freeAreas: string[] = [];
    if (window === "day" && included && points.length === derived.dense.length) {
      const poolDense = poolSeries ? deriveSeries(poolSeries, cycles, today, aggregationKind).dense : derived.dense;
      const groups = new Map<number, { points: string[]; left: number; right: number }>();
      freeRemainingSeries(poolDense, derived.cycles, included, aggregationKind).forEach((point, index) => {
        const left = index * slot;
        const right = left + slot;
        const group = groups.get(point.cycle) ?? { points: [], left, right };
        group.points.push(`${left},${yFor(point.before)}`, `${right},${yFor(point.after)}`);
        group.right = right;
        groups.set(point.cycle, group);
      });
      for (const group of groups.values()) freeAreas.push([`${group.left},${height}`, ...group.points, `${group.right},${height}`].join(" "));
    }
    const bars = points.flatMap((point, index) => {
      const x = index * slot;
      // Adjacent bars overlap by a hair so the downscaled SVG shows no seams between days.
      const barWidth = slot + 0.8;
      if (window === "day") {
        // Blue up to the first level, each level's color only above it.
        const edges = [0, ...levelValues.filter(value => value > 0 && value < point), point];
        const bounds = [...new Set(edges)].sort((left, right) => left - right);
        return bounds.slice(1).map((top, segment) => {
          const bottom = bounds[segment]!;
          const crossed = crossedLevel(order, values, bottom + (top - bottom) / 2 + 1e-9);
          return { key: `${index}-${segment}`, x, width: barWidth, y: yFor(top), height: Math.max(0.4, yFor(bottom) - yFor(top)), color: (crossed && colorById.get(crossed)) || accent };
        });
      }
      // Cycle mode: stack the running total into value bands, like the full
      // chart; the included part of the total is green.
      const includedTop = tops[index] ?? 0;
      const edges = [0, ...[...levelValues, includedTop].map(value => Math.min(value, point)).filter(value => value > 0 && value < point), point];
      const bounds = [...new Set(edges)].sort((left, right) => left - right);
      return bounds.slice(1).map((top, segment) => {
        const bottom = bounds[segment]!;
        const middle = bottom + (top - bottom) / 2 + 1e-9;
        const crossed = crossedLevel(order, values, middle);
        const color = top <= includedTop ? INCLUDED_COLOR : (crossed && colorById.get(crossed)) || accent;
        return { key: `${index}-${segment}`, x, width: barWidth, y: yFor(top), height: Math.max(0.4, yFor(bottom) - yFor(top)), color };
      });
    });
    return { bars, freeAreas };
  }, [series, cycles, today, window, levels, values, accent, includedPerCycle, poolSeries, aggregationKind]);
  return (
    <svg viewBox="0 0 120 28" className={className} aria-hidden="true" preserveAspectRatio="none">
      {freeAreas.map((points, index) => <polygon key={`free-${index}`} points={points} fill={INCLUDED_COLOR} opacity=".2" />)}
      {bars.map(bar => <rect key={bar.key} x={bar.x} y={bar.y} width={bar.width} height={bar.height} fill={bar.color} shapeRendering="geometricPrecision" />)}
    </svg>
  );
});

