/**
 * Y-axis math for the limits chart. Pure functions, no DOM.
 *
 * The axis is linear until outliers appear (max > OUTLIER_RATIO × median of
 * the nonzero values); then it becomes symlog: linear from 0 to the knee and
 * logarithmic above it, so zero days sit on the baseline and a single spike
 * does not flatten the rest of the history.
 */

export const OUTLIER_RATIO = 10;

export interface Axis {
  kind: "linear" | "symlog";
  /** Top of the visible domain (data value). Always > 0. */
  max: number;
  /** Symlog knee (data value). Unused for linear axes. */
  knee: number;
  /** Tick values, ascending, first is 0 and last is `max`. */
  ticks: number[];
  /** Data value → normalized position in [0, 1] (0 = baseline). */
  position(value: number): number;
  /** Normalized position in [0, 1] → data value. */
  invert(position: number): number;
}

export function median(values: number[]): number {
  const sorted = values.filter(value => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Largest 1/2/5 × 10^n that is ≤ value. Returns 0 for non-positive input. */
export function niceFloor(value: number): number {
  if (!(value > 0)) return 0;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const mantissa = value / base;
  const step = mantissa >= 5 ? 5 : mantissa >= 2 ? 2 : 1;
  return step * base;
}

/** Smallest 1/2/5 × 10^n that is ≥ value. Returns 0 for non-positive input. */
export function niceCeil(value: number): number {
  if (!(value > 0)) return 0;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const mantissa = value / base;
  const step = mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 5 ? 5 : 10;
  return roundFloat(step * base);
}

/**
 * Snap step for a value: a nice number about one twentieth of the value, so
 * $47 snaps in $2 steps and $470 in $20 steps. Never smaller than `minimum`.
 */
export function snapStep(value: number, minimum = 0.01): number {
  return Math.max(minimum, niceFloor(Math.abs(value) / 20));
}

/** Round to the nearest snap step at the value's own scale. */
export function snapToNice(value: number, minimum = 0.01): number {
  if (!(value > 0)) return 0;
  const step = snapStep(value, minimum);
  return roundFloat(Math.round(value / step) * step);
}

/** Round up to the next snap step at the value's own scale. */
export function snapUpToNice(value: number, minimum = 0.01): number {
  if (!(value > 0)) return 0;
  const step = snapStep(value, minimum);
  return roundFloat(Math.ceil(value / step - 1e-9) * step);
}

/** Round down to the previous snap step at the value's own scale. */
export function snapDownToNice(value: number, minimum = 0.01): number {
  if (!(value > 0)) return 0;
  const step = snapStep(value, minimum);
  return roundFloat(Math.floor(value / step + 1e-9) * step);
}

/**
 * Nice-number ladder for default thresholds: `count` ascending values above
 * `max`, spread by position (2×, 5×, 10×, 20× … the observed max). An
 * all-zero history starts at 1, 5, 10 units.
 */
export function niceLadder(max: number, count: number): number[] {
  const multipliers = max > 0 ? [2, 5, 10, 20, 50, 100, 200, 500] : [1, 5, 10, 20, 50, 100, 200, 500];
  const base = max > 0 ? max : 1;
  const ladder: number[] = [];
  for (let index = 0; index < Math.max(0, count); index += 1) {
    const multiplier = index < multipliers.length ? multipliers[index]! : 500 * 10 ** (index - multipliers.length + 1);
    let next = niceCeil(base * multiplier);
    // The 1/2/5 ceiling can collapse neighbors (2× and 5× of 211 both round
    // to 500 and 2000 → 5000); keep the ladder strictly increasing.
    const previous = ladder.at(-1);
    if (previous !== undefined && next <= previous) next = niceCeil(previous * 1.5);
    ladder.push(next);
  }
  return ladder;
}

/**
 * Choose the axis for a series plus any values that must stay visible
 * (threshold levels). Linear when the data is tame; symlog when the max is
 * more than OUTLIER_RATIO × the median nonzero value.
 */
export function chooseAxis(series: number[], extra: number[] = []): Axis {
  const data = series.filter(value => Number.isFinite(value) && value >= 0);
  const nonzero = data.filter(value => value > 0);
  const dataMax = Math.max(0, ...data);
  const top = Math.max(dataMax, ...extra.filter(value => Number.isFinite(value) && value > 0));
  const middle = median(nonzero);
  const outlier = nonzero.length >= 3 && middle > 0 && dataMax > OUTLIER_RATIO * middle;
  if (!outlier) return linearAxis(top);
  // A knee under the median keeps the median region at roughly a quarter of
  // the axis height instead of hugging the baseline.
  return symlogAxis(top, middle / 4);
}

export function linearAxis(top: number): Axis {
  const max = niceCeil(top > 0 ? top * 1.05 : 1) || 1;
  const step = niceFloor(max / 4) || max / 4;
  const ticks: number[] = [];
  for (let tick = 0; tick < max - step / 2; tick += step) ticks.push(roundFloat(tick));
  ticks.push(max);
  return {
    kind: "linear", max, knee: 0, ticks,
    position: value => clamp01(value / max),
    invert: position => clamp01(position) * max,
  };
}

export function symlogAxis(top: number, knee: number): Axis {
  const max = niceCeil(top * 1.05);
  const safeKnee = knee > 0 ? knee : max / 100;
  const scale = Math.log10(1 + max / safeKnee);
  const position = (value: number) => clamp01(Math.log10(1 + Math.max(0, value) / safeKnee) / scale);
  const invert = (fraction: number) => safeKnee * (10 ** (clamp01(fraction) * scale) - 1);
  const ticks = [0];
  let decade = 10 ** Math.floor(Math.log10(safeKnee));
  while (decade < max) {
    for (const mantissa of [1, 2, 5]) {
      const tick = roundFloat(mantissa * decade);
      if (tick >= safeKnee / 2 && tick < max && position(tick) - position(ticks.at(-1)!) >= 0.09) ticks.push(tick);
    }
    decade *= 10;
  }
  if (position(max) - position(ticks.at(-1)!) < 0.05) ticks.pop();
  ticks.push(max);
  return { kind: "symlog", max, knee: safeKnee, ticks, position, invert };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function roundFloat(value: number): number {
  return Number(value.toPrecision(12));
}
