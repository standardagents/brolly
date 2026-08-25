import { useEffect, useRef, useState } from "react";
import type { Axis } from "./scale";

const AXIS_TWEEN_MS = 320;

export function interpolateAxis(from: Axis, to: Axis, progress: number): Axis {
  const t = Math.min(1, Math.max(0, progress));
  const position = (value: number) => from.position(value) + (to.position(value) - from.position(value)) * t;
  const ceiling = Math.max(from.max, to.max);
  const invert = (fraction: number) => {
    let low = 0;
    let high = ceiling;
    for (let index = 0; index < 32; index += 1) {
      const middle = (low + high) / 2;
      if (position(middle) < fraction) low = middle;
      else high = middle;
    }
    return (low + high) / 2;
  };
  return {
    kind: to.kind,
    max: from.max + (to.max - from.max) * t,
    knee: from.knee + (to.knee - from.knee) * t,
    ticks: to.ticks,
    position,
    invert,
  };
}

export function useAnimatedAxis(target: Axis, transitionKey: string): { axis: Axis; animating: boolean } {
  const current = useRef(target);
  const previousKey = useRef(transitionKey);
  const [axis, setAxis] = useState(target);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    const from = current.current;
    const scaleChanged = previousKey.current !== transitionKey;
    previousKey.current = transitionKey;
    if (!scaleChanged || sameAxis(from, target)) {
      current.current = target;
      setAxis(target);
      setAnimating(false);
      return;
    }
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      current.current = target;
      setAxis(target);
      setAnimating(false);
      return;
    }
    let frame = 0;
    const started = performance.now();
    setAnimating(true);
    const tick = (now: number) => {
      const elapsed = Math.min(1, (now - started) / AXIS_TWEEN_MS);
      const eased = 1 - (1 - elapsed) ** 3;
      const next = interpolateAxis(from, target, eased);
      current.current = next;
      setAxis(next);
      if (elapsed < 1) frame = requestAnimationFrame(tick);
      else {
        current.current = target;
        setAxis(target);
        setAnimating(false);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, transitionKey]);

  return { axis, animating };
}

function sameAxis(left: Axis, right: Axis): boolean {
  return left.kind === right.kind && left.max === right.max && left.knee === right.knee
    && left.ticks.length === right.ticks.length && left.ticks.every((tick, index) => tick === right.ticks[index]);
}
