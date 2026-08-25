import { niceFloor } from "./scale";

/**
 * A second dollar reading of the unit axis for a directly billed meter: cost
 * above the free allotment is linear in units, so $ ticks sit on the unit
 * axis with $0 anchored where the allotment is exhausted (the baseline when
 * the meter has no allotment).
 */
export function CostAxis({ anchor, rate, axisMax, x, yFor, format }: {
  /** Units at which billing starts: the included allotment, or 0 without one. */
  anchor: number;
  /** List-rate price per unit. */
  rate: number;
  /** Top of the unit axis. */
  axisMax: number;
  /** The plot's right edge: labels start just right of it. */
  x: number;
  yFor(units: number): number;
  format(costUsd: number): string;
}) {
  const maxCost = (axisMax - anchor) * rate;
  if (!(maxCost > 0)) return null;
  // Even dollar steps where the mapping above the anchor is linear; the 1/2/5
  // ladder (one tick per decade or so) where it is logarithmic. Both keep a
  // minimum on-screen gap.
  const MIN_GAP_PX = 16;
  const yAt = (cost: number) => yFor(anchor + cost / rate);
  const linearish = Math.abs(yAt(maxCost / 2) - (yAt(0) + yAt(maxCost)) / 2) < 1;
  const ticks: number[] = [0];
  let lastY = yAt(0);
  if (linearish) {
    const step = niceFloor(maxCost / 4) || maxCost / 4;
    for (let cost = step; cost <= maxCost + step / 1000; cost += step) {
      const y = yAt(cost);
      if (lastY - y >= MIN_GAP_PX) { ticks.push(cost); lastY = y; }
    }
  } else {
    let decade = 10 ** Math.floor(Math.log10(Math.max(maxCost / 20_000, Number.MIN_VALUE)));
    outer: while (decade <= maxCost) {
      for (const mantissa of [1, 2, 5]) {
        const cost = mantissa * decade;
        if (cost > maxCost) break outer;
        const y = yAt(cost);
        if (lastY - y >= MIN_GAP_PX) { ticks.push(cost); lastY = y; }
      }
      decade *= 10;
    }
  }
  return (
    <g data-cost-axis pointerEvents="none">
      {ticks.map(cost => (
        <text key={cost} x={x + 8} y={yFor(anchor + cost / rate) + 3.5} textAnchor="start"
          stroke="var(--panel)" strokeWidth="3" paintOrder="stroke"
          className="fill-faint text-[10px] font-[650] tabular-nums">{format(cost)}</text>
      ))}
    </g>
  );
}
