import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { compactValue, formatLimitValue, unitLabel } from "./format";
import { LevelValueField } from "./LevelValueField";
import type { LimitsChartLevel } from "./LimitsChart";
import { type LevelValues, pushLevels } from "./levels";
import { type Axis, niceFloor, roundFloat, snapStep, snapToNice } from "./scale";
import { useElementWidth } from "./use-element-width";

/**
 * A single horizontal track with one diamond per level, for scopes with no
 * usage history to plot against (the same idea as the risk tolerance bar,
 * in absolute units). Diamonds push each other and never cross; each
 * level's name and editable value sit under its diamond.
 */
export function LevelTrack({ levels, value, unit, onChange, readOnly = false }: {
  levels: LimitsChartLevel[];
  value: LevelValues;
  unit: string;
  onChange(next: LevelValues): void;
  readOnly?: boolean;
}) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const order = useMemo(() => levels.map(level => level.id), [levels]);
  const active = levels;
  const highest = Math.max(1, ...order.map(id => value[id] ?? 0));
  const [dragValues, setDragValues] = useState<LevelValues | null>(null);
  const shown = dragValues ?? value;
  const [dragging, setDragging] = useState<string | null>(null);
  const draggingRef = useRef<string | null>(null);
  const dragBase = useRef<LevelValues | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const rect = useRef<DOMRect | null>(null);
  // While a drag pushes past the right end the track extends under the
  // pointer. On release the scale settles so the highest level sits near the
  // right end (about 90%) when it was pushed there, stays put otherwise, and
  // contracts only once every level sits in the left tenth.
  const [trackMax, setTrackMax] = useState(() => settleMax(highest));
  // Values that arrive from outside a drag (seeding, a typed edit, undo)
  // settle the scale when they leave the track or sink into its left tenth.
  useEffect(() => {
    if (dragging) return;
    setTrackMax(current => (highest > current * 0.9 || highest < current * 0.1 ? settleMax(highest) : current));
  }, [highest, dragging]);
  const max = trackMax;
  // The track's scale is exactly `max`: no padding, so the right end of the
  // track is the value the ticks say it is.
  const axis = useMemo((): Axis => {
    const step = niceFloor(max / 4) || max / 4;
    const ticks: number[] = [];
    for (let tick = 0; tick < max - step / 2; tick += step) ticks.push(roundFloat(tick));
    ticks.push(max);
    const clamp = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
    return { kind: "linear", max, knee: 0, ticks, position: value => clamp(value / max), invert: fraction => clamp(fraction) * max };
  }, [max]);
  const pad = 16;
  const trackWidth = Math.max(120, width - pad * 2);
  const xFor = (item: number) => pad + axis.position(item) * trackWidth;
  const valueAt = (clientX: number, snap: boolean) => {
    const box = rect.current ?? svgRef.current?.getBoundingClientRect();
    if (!box) return 0;
    const x = ((clientX - box.left) / box.width) * width;
    const fraction = (x - pad) / trackWidth;
    // Past the right end the track grows a little at a time, so the drag can keep going.
    if (fraction > 0.97) setTrackMax(current => current * 1.12);
    const raw = axis.invert(Math.min(1, fraction));
    return Math.max(0, snap ? snapToNice(raw) : raw);
  };
  const push = (base: LevelValues, id: string, next: number) => pushLevels(axis, order, base, id, next);

  const pointerDown = (id: string) => (event: PointerEvent<SVGElement>) => {
    if (readOnly) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    rect.current = svgRef.current?.getBoundingClientRect() ?? null;
    dragBase.current = value;
    draggingRef.current = id;
    setDragging(id);
    setDragValues(push(value, id, valueAt(event.clientX, false)));
  };
  const pointerMove = (id: string) => (event: PointerEvent<SVGElement>) => {
    if (draggingRef.current !== id) return;
    setDragValues(push(dragBase.current ?? value, id, valueAt(event.clientX, false)));
  };
  const pointerUp = (event: PointerEvent<SVGElement>) => {
    const id = draggingRef.current;
    if (!id) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const final = push(dragBase.current ?? value, id, valueAt(event.clientX, true));
    // Settle the scale on release so a level pushed past the end lands near
    // it and the end label is a round number.
    setTrackMax(settleMax(Math.max(1, ...order.map(level => final[level] ?? 0))));
    draggingRef.current = null;
    dragBase.current = null;
    rect.current = null;
    setDragging(null);
    setDragValues(null);
    onChange(final);
  };
  const keyDown = (id: string) => (event: KeyboardEvent<SVGElement>) => {
    if (readOnly) return;
    const current = value[id] ?? 0;
    const step = snapStep(current) * (event.shiftKey ? 10 : 1);
    const jumps: Record<string, number> = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: step * 10, PageDown: -step * 10 };
    const delta = jumps[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    onChange(push(value, id, Math.max(0, current + delta)));
  };

  const trackY = 26;
  const height = 60;
  return (
    <div className="min-w-0 select-none">
      <div ref={containerRef} className="relative" style={{ height }}>
        <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 block h-full w-full touch-none overflow-visible" role="group" aria-label={`Limits by alert level in ${unitLabel(unit)}`}>
          {axis.ticks.map(tick => (
            <text key={tick} x={xFor(tick)} y={trackY - 10} textAnchor={tick === 0 ? "start" : tick >= max ? "end" : "middle"} className="fill-faint text-[10px] tabular-nums">{tick === 0 ? "0" : compactValue(tick, unit)}</text>
          ))}
          <rect x={pad} y={trackY} width={trackWidth} height={6} rx={3} className="fill-line-soft" />
          {active.map((level, index) => {
            const start = xFor(shown[level.id] ?? 0);
            const next = active[index + 1];
            const end = next ? xFor(shown[next.id] ?? 0) : pad + trackWidth;
            return <rect key={level.id} x={start} y={trackY} width={Math.max(0, end - start)} height={6} fill={level.color} opacity=".85" style={{ transition: dragging ? "none" : "x 240ms cubic-bezier(.2,.7,.2,1), width 240ms cubic-bezier(.2,.7,.2,1)" }} />;
          })}
          {active.map(level => {
            const current = shown[level.id] ?? 0;
            const x = xFor(current);
            const y = trackY + 3;
            return (
              <g key={level.id} role={readOnly ? undefined : "slider"} tabIndex={readOnly ? undefined : 0} aria-label={`${level.label} limit`} aria-valuemin={0} aria-valuemax={max} aria-valuenow={current} aria-valuetext={formatLimitValue(current, unit)} aria-orientation="horizontal"
                className={readOnly ? undefined : "cursor-ew-resize outline-none focus-visible:[&_polygon]:stroke-ink focus-visible:[&_polygon]:stroke-[2.5]"}
                onPointerDown={pointerDown(level.id)} onPointerMove={pointerMove(level.id)} onPointerUp={pointerUp} onPointerCancel={pointerUp} onKeyDown={keyDown(level.id)}>
                <title>{`${level.label} · ${formatLimitValue(current, unit)}`}</title>
                <g style={{ transform: `translate(${x}px, ${y}px)`, transition: dragging === level.id ? "none" : "transform 240ms cubic-bezier(.2,.7,.2,1)" }}>
                  <circle r="14" fill="transparent" />
                  <polygon points="0,-8 8,0 0,8 -8,0" fill={level.color} stroke="var(--panel)" strokeWidth="2" />
                </g>
              </g>
            );
          })}
        </svg>
      </div>
      {!readOnly && (
        <div className="flex flex-wrap justify-center gap-x-12 gap-y-2 border-t border-line-soft pt-2.5">
          {levels.map(level => (
            <LevelValueField key={level.id} variant="bare" level={level} unit={unit} value={shown[level.id] ?? 0}
              onCommit={next => onChange(push(value, level.id, next))} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A settled track end for a highest level: 10% of headroom, rounded up to
 * the tick step so the end label is a round number and the level sits
 * close to the right end.
 */
function settleMax(highest: number): number {
  const target = Math.max(1, highest) * 1.1;
  const step = niceFloor(target / 5) || target / 5;
  return roundFloat(Math.ceil(target / step - 1e-9) * step);
}
