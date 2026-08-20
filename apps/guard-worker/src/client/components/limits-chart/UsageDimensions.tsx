import { useMemo } from "react";
import { type CycleBounds, type DayPoint } from "./cycles";
import { deriveSeries } from "./defaults";
import { type LevelValues, crossedLevel } from "./levels";
import { chooseAxis } from "./scale";
import type { LimitsChartLevel } from "./LimitsChart";

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
    let points = window === "cycle" ? derived.cumulative.map(point => point.cumulative) : derived.dense.map(point => point.value);
    // Sub-pixel bars are invisible and expensive across dozens of rows;
    // bucket long histories to ~60 bars, keeping each bucket's peak.
    const MAX_BARS = 60;
    if (points.length > MAX_BARS) {
      const size = points.length / MAX_BARS;
      points = Array.from({ length: MAX_BARS }, (_, bucket) => {
        const from = Math.floor(bucket * size);
        const to = Math.max(from + 1, Math.floor((bucket + 1) * size));
        return Math.max(...points.slice(from, to));
      });
    }
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
