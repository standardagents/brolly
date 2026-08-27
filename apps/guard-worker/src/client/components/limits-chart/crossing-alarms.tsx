import type { DayPoint } from "./cycles";
import type { LevelValues } from "./levels";
import type { LimitsChartLevel } from "./LevelValueField";

/**
 * Teaching spotlight used by the onboarding chart tour: days that stay under
 * every active level are washed toward the panel color, and every point where
 * the chart's mark reaches an alert line gets an alarm-bell badge in that
 * level's color. Alerts fire the moment a threshold is reached, so each
 * badge sits on an intersection.
 */

export interface CrossingGeometry {
  xFor(index: number): number;
  yFor(value: number): number;
  barSlot: number;
  /** y of the x axis (the bars' base). */
  baseline: number;
}

/** Wash over the bars of days that reach no active level. Drawn above the bars, below the level lines. */
export function CrossingDim({ levels, values, dense, geometry }: { levels: LimitsChartLevel[]; values: LevelValues; dense: DayPoint[]; geometry: CrossingGeometry }) {
  const lowest = Math.min(...levels.map(level => values[level.id] ?? Number.POSITIVE_INFINITY));
  if (!Number.isFinite(lowest) || lowest <= 0) return null;
  return (
    <g data-crossing-dim pointerEvents="none">
      {dense.map((point, index) => {
        if (point.missing || !(point.value > 0) || point.value >= lowest) return null;
        const left = Math.round(geometry.xFor(index) - geometry.barSlot / 2);
        const right = Math.round(geometry.xFor(index) + geometry.barSlot / 2);
        const top = geometry.yFor(point.value);
        return <rect key={point.day} x={left} y={top} width={Math.max(1, right - left)} height={Math.max(0, geometry.baseline - top)} fill="var(--panel)" opacity=".62" shapeRendering="crispEdges" />;
      })}
    </g>
  );
}

/** Bell path from the shared icon set, scaled to sit inside a 6.5px-radius badge. */
const BELL = <g transform="translate(-5.05, -5.5) scale(.42)" fill="none" stroke="var(--panel)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
  <path d="M6 9.5a6 6 0 1 1 12 0c0 4.6 1.8 5.8 1.8 5.8H4.2S6 14.1 6 9.5Z" />
  <path d="M10 19.5a2.3 2.3 0 0 0 4 0" />
</g>;

/** One point of the chart's primary mark: a day's value, or the running total with its cycle as the group. */
export interface CrossingPoint { day: string; value: number; group: number; missing?: boolean }

/**
 * Alarm badges on the intersections with each active level's line. On a day
 * chart every day at or over a level is an intersection. On a cycle chart the
 * running total crosses each line at most once per cycle, so the badge sits
 * on the day the total reached the level.
 */
export function CrossingAlarms({ levels, values, points, mode, geometry }: { levels: LimitsChartLevel[]; values: LevelValues; points: CrossingPoint[]; mode: "day" | "cycle"; geometry: CrossingGeometry }) {
  return (
    <g data-crossing-alarms pointerEvents="none">
      {levels.flatMap((level, position) => {
        const threshold = values[level.id] ?? 0;
        if (!(threshold > 0)) return [];
        let ordinal = -1;
        return points.map((point, index) => {
          if (point.missing || point.value < threshold) return null;
          const previous = points[index - 1];
          const previousCrossed = !!previous && previous.group === point.group && previous.value >= threshold;
          if (mode === "cycle" && previousCrossed) return null;
          ordinal += 1;
          return (
            <g key={`${level.id}:${point.day}`} transform={`translate(${geometry.xFor(index)}, ${geometry.yFor(threshold)})`}>
              <g data-alarm-badge className="animate-alarm-badge" style={{ transformBox: "fill-box", transformOrigin: "center", animationDelay: `${position * 180 + ordinal * 28}ms` }}>
                <circle r="7" fill={level.color} stroke="var(--panel)" strokeWidth="1.5" />
                {BELL}
              </g>
            </g>
          );
        });
      })}
    </g>
  );
}
