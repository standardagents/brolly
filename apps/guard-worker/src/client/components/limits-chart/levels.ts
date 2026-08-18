/**
 * Threshold-line ordering for the limits chart. Pure functions, no DOM.
 *
 * Levels are ordered lowest severity first. Adjacent lines keep a minimum
 * gap of GAP_FRACTION of the axis height; a dragged line pushes its
 * neighbors so order and gap always hold.
 */
import { type Axis, niceLadder, snapDownToNice, snapUpToNice } from "./scale";

export const GAP_FRACTION = 0.05;

export type LevelValues = Record<string, number>;

/**
 * Smallest value strictly above `value` that satisfies the gap, converted
 * through the axis and rounded up to the next nice snap step.
 */
export function minGapAbove(axis: Axis, value: number, fraction = GAP_FRACTION): number {
  const raw = axis.invert(Math.min(1, axis.position(value) + fraction));
  const next = raw <= value ? value + axis.invert(fraction) : raw;
  return Math.max(snapUpToNice(next), snapUpToNice(value + 1e-9));
}

/** Largest value below `value` that satisfies the gap; never below 0. */
export function maxGapBelow(axis: Axis, value: number, fraction = GAP_FRACTION): number {
  const position = axis.position(value) - fraction;
  if (position <= 0) return 0;
  return Math.max(0, snapDownToNice(axis.invert(position)));
}

/**
 * Apply `next` to `changedId`, then push neighbors so that ordering and the
 * minimum gap hold. `order` is level ids lowest-first. `floor` values are
 * per-level minimums (cycle limits ≥ daily limits); a floor that a downward
 * push would violate stops the push and pushes the changed line back up.
 */
export function pushLevels(
  axis: Axis,
  order: readonly string[],
  values: LevelValues,
  changedId: string,
  next: number,
  floor: LevelValues = {},
  fraction = GAP_FRACTION,
): LevelValues {
  const index = order.indexOf(changedId);
  if (index < 0) return values;
  const result = order.map(id => Math.max(0, values[id] ?? 0));
  const floors = order.map(id => Math.max(0, floor[id] ?? 0));
  result[index] = Math.max(floors[index]!, Number.isFinite(next) ? Math.max(0, next) : 0);

  // Push everything above upward.
  for (let i = index + 1; i < result.length; i += 1) {
    const minimum = Math.max(minGapAbove(axis, result[i - 1]!, fraction), floors[i]!);
    if (result[i]! < minimum) result[i] = minimum;
  }
  // Push everything below downward, but never under its floor.
  for (let i = index - 1; i >= 0; i -= 1) {
    const maximum = maxGapBelow(axis, result[i + 1]!, fraction);
    if (result[i]! > maximum) result[i] = Math.max(maximum, floors[i]!);
  }
  // A floor below may have blocked the downward push; re-run the upward
  // pass from the bottom so the changed line and everything above respect it.
  for (let i = 1; i < result.length; i += 1) {
    const minimum = minGapAbove(axis, result[i - 1]!, fraction);
    if (result[i]! < minimum) result[i] = minimum;
  }
  return Object.fromEntries(order.map((id, i) => [id, result[i]!]));
}

/**
 * Default thresholds for a scope with no saved values: a nice ladder above
 * the observed max, spread by level position, then pushed for the gap rule.
 */
export function defaultLevels(axis: Axis, order: readonly string[], observedMax: number, floor: LevelValues = {}): LevelValues {
  const ladder = niceLadder(observedMax, order.length);
  let values: LevelValues = Object.fromEntries(order.map((id, i) => [id, Math.max(ladder[i]!, floor[id] ?? 0)]));
  for (const id of order) values = pushLevels(axis, order, values, id, values[id]!, floor);
  return values;
}

/**
 * Fill in missing level values without moving the ones already set. A
 * `seed` value wins over the computed ladder for a missing level (the cycle
 * step seeds from daily × days in cycle).
 */
export function completeLevels(axis: Axis, order: readonly string[], values: LevelValues, observedMax: number, floor: LevelValues = {}, seed: LevelValues = {}): LevelValues {
  const missing = order.filter(id => !(Number.isFinite(values[id]) && values[id]! >= 0));
  if (!missing.length) return values;
  const defaults = defaultLevels(axis, order, observedMax, floor);
  const fallback = (id: string) => (Number.isFinite(seed[id]) && seed[id]! > 0 ? Math.max(seed[id]!, floor[id] ?? 0) : defaults[id]!);
  let merged: LevelValues = Object.fromEntries(order.map(id => [id, missing.includes(id) ? fallback(id) : values[id]!]));
  for (const id of order) merged = pushLevels(axis, order, merged, id, merged[id]!, floor);
  return merged;
}

/**
 * The color of a bar: the highest level whose threshold the value reaches,
 * or null when the bar stays under every line.
 */
export function crossedLevel(order: readonly string[], values: LevelValues, value: number): string | null {
  let crossed: string | null = null;
  for (const id of order) if (value >= (values[id] ?? Number.POSITIVE_INFINITY)) crossed = id;
  return crossed;
}
