import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Switch } from "../ui";
import { compactValue, editableValue, formatLimitValue, parseCompact, selectNumber, unitLabel, type LimitsChartLevel } from "./LimitsChart";
import { type LevelValues, pushLevels } from "./levels";
import { chooseAxis, niceCeil, snapStep, snapToNice } from "./scale";
import { useElementWidth } from "./use-element-width";

/**
 * A single horizontal track with one diamond per level, for scopes with no
 * usage history to plot against (the same idea as the risk tolerance bar,
 * in absolute units). Diamonds push each other and never cross; each
 * level's name and editable value sit under its diamond.
 */
export function LevelTrack({ levels, value, unit, onChange, readOnly = false, levelEnabled, onLevelEnabledChange }: {
  levels: LimitsChartLevel[];
  value: LevelValues;
  unit: string;
  onChange(next: LevelValues): void;
  readOnly?: boolean;
  levelEnabled?: Record<string, boolean>;
  onLevelEnabledChange?(next: Record<string, boolean>): void;
}) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const order = useMemo(() => levels.map(level => level.id), [levels]);
  const active = levels.filter(level => levelEnabled?.[level.id] ?? true);
  const highest = Math.max(1, ...order.map(id => value[id] ?? 0));
  const [dragValues, setDragValues] = useState<LevelValues | null>(null);
  const shown = dragValues ?? value;
  const [dragging, setDragging] = useState<string | null>(null);
  const draggingRef = useRef<string | null>(null);
  const dragBase = useRef<LevelValues | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const rect = useRef<DOMRect | null>(null);
  // Axis frozen while dragging so the track does not rescale under the pointer.
  const [frozenMax, setFrozenMax] = useState<number | null>(null);
  const max = frozenMax ?? niceCeil(highest * 2);
  const axis = useMemo(() => chooseAxis([], [max]), [max]);
  const pad = 14;
  const trackWidth = Math.max(120, width - pad * 2);
  const xFor = (item: number) => pad + axis.position(item) * trackWidth;
  const valueAt = (clientX: number, snap: boolean) => {
    const box = rect.current ?? svgRef.current?.getBoundingClientRect();
    if (!box) return 0;
    const x = ((clientX - box.left) / box.width) * width;
    const raw = axis.invert((x - pad) / trackWidth);
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
    setFrozenMax(max);
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
    draggingRef.current = null;
    dragBase.current = null;
    rect.current = null;
    setDragging(null);
    setDragValues(null);
    setFrozenMax(null);
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
        <div className="grid grid-cols-3 gap-x-8 gap-y-2 border-t border-line-soft pt-2.5 max-sm:grid-cols-2">
          {levels.map(level => (
            <TrackField key={level.id} level={level} unit={unit} value={shown[level.id] ?? 0} enabled={levelEnabled?.[level.id] ?? true}
              onCommit={next => onChange(push(value, level.id, next))}
              onToggle={onLevelEnabledChange ? next => onLevelEnabledChange({ ...levelEnabled, [level.id]: next }) : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}

function TrackField({ level, unit, value, enabled, onCommit, onToggle }: { level: LimitsChartLevel; unit: string; value: number; enabled: boolean; onCommit(next: number): void; onToggle?(next: boolean): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? compactValue(value, unit);
  const commit = () => {
    if (draft === null) return;
    const parsed = parseCompact(draft);
    setDraft(null);
    if (parsed !== null && parsed >= 0) onCommit(parsed);
  };
  return (
    <label className={`flex w-full min-w-0 flex-col transition-opacity ${enabled ? "" : "opacity-55"}`}>
      <span className="flex items-center gap-1.5 text-[11px] font-bold text-muted">
        <i className="size-2 flex-none rotate-45 rounded-[1.5px]" style={{ background: level.color }} aria-hidden="true" />
        <span className="truncate">{level.label}</span>
        {onToggle && (
          <span className="ml-3 flex-none"><Switch label={`Use ${level.label} level`} on={enabled} onChange={onToggle} title={enabled ? `${level.label} is active. Switch off to skip it.` : `${level.label} is off.`} /></span>
        )}
      </span>
      <span className="-ml-1 flex w-max items-baseline gap-[3px] rounded-[4px] border border-transparent px-1 text-ink hover:border-line focus-within:border-orange focus-within:bg-field">
        {unit === "USD" && <b className="text-[13px] text-faint">$</b>}
        <input className="min-w-[2ch] border-0 bg-transparent p-0 text-[15px] font-[740] tabular-nums outline-none disabled:cursor-default" style={{ width: `calc(${Math.max(2, shown.length)}ch + 2px)` }} inputMode="decimal" disabled={!enabled} value={shown}
          aria-label={`${level.label} limit${unit === "USD" ? " in dollars" : ` in ${unit}`}`}
          onFocus={event => { const text = editableValue(value, unit); setDraft(text); selectNumber(event.target, text); }}
          onChange={event => setDraft(event.target.value)} onBlur={commit}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur(); } if (event.key === "Escape") { setDraft(null); event.currentTarget.blur(); } }} />
        {unit !== "USD" && <small className="flex-none text-[10.5px] font-medium text-faint">{unitLabel(unit)}</small>}
      </span>
    </label>
  );
}
