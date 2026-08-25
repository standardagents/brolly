import { useRef, useState, type KeyboardEvent } from "react";
import { editableValue, fieldValue, parseCompact, selectNumber, unitLabel } from "./format";
import { snapStep } from "./scale";

export interface LimitsChartLevel { id: string; label: string; color: string }

export interface LevelValueFieldProps {
  level: LimitsChartLevel;
  unit: string;
  value: number | undefined;
  onCommit?(next: number): void;
  variant?: "boxed" | "bare" | "chip";
  /** Emphasize this field while its chart line is hovered or dragged. */
  highlight?: boolean;
  step?(value: number): number;
  /** This value as a percent of the scope's typical historical usage. Hidden when absent. */
  percent?: number;
  /** Accent the percent in orange: the value has left its tolerance default. */
  percentAccent?: boolean;
}

// Chip inputs hug their text exactly where field-sizing is supported; the
// ch-based width below is the approximate fallback for other engines.
const CHIP_AUTO_SIZE = typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content");

/** One alert-level value editor shared by chart fields, tracks, rows, and risk tolerance. */
export function LevelValueField({ level, unit, value, onCommit, variant = "boxed", highlight = false, step, percent, percentAccent = false }: LevelValueFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelBlur = useRef(false);
  const display = value === undefined ? "–" : fieldValue(value, unit);
  const shown = draft ?? display;
  const title = `${level.label} limit${onCommit ? " · click to edit" : ""}`;
  const ariaLabel = unit === "%" ? `${level.label} percent of typical` : `${level.label} limit${unit === "USD" ? " in dollars" : ` in ${unit}`}`;

  const commitDraft = () => {
    if (cancelBlur.current) { cancelBlur.current = false; return; }
    if (draft === null) return;
    const parsed = parseCompact(draft);
    setDraft(null);
    if (parsed !== null && parsed >= 0) onCommit?.(parsed);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); return; }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelBlur.current = true;
      setDraft(null);
      event.currentTarget.blur();
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const current = parseCompact(draft ?? editableValue(value ?? 0, unit)) ?? value ?? 0;
    const amount = (step?.(current) ?? snapStep(current)) * (event.shiftKey ? 10 : 1);
    const next = Math.max(0, current + (event.key === "ArrowUp" ? amount : -amount));
    setDraft(editableValue(next, unit));
    onCommit?.(next);
  };
  const swatch = <i className="size-2 flex-none rotate-45 rounded-[1.5px]" style={{ background: level.color }} aria-hidden="true" />;
  const input = onCommit ? (
    <input
      className={`min-w-[2ch] max-w-full border-0 bg-transparent p-0 font-[740] tabular-nums outline-none ${percentAccent ? "text-orange-deep" : "text-ink"} ${variant === "chip" ? "[field-sizing:content] text-[13.5px]" : "text-[15px]"}`}
      style={variant === "chip" && CHIP_AUTO_SIZE ? undefined : { width: `calc(${Math.max(variant === "chip" ? 1 : 2, shown.length)}ch + 2px)` }}
      inputMode="decimal"
      value={shown}
      aria-label={ariaLabel}
      onFocus={event => {
        const text = editableValue(value ?? 0, unit);
        setDraft(text);
        selectNumber(event.target, text);
      }}
      onChange={event => setDraft(event.target.value)}
      onBlur={commitDraft}
      onKeyDown={keyDown}
    />
  ) : <span className={`font-[740] tabular-nums ${percentAccent ? "text-orange-deep" : "text-ink"} ${variant === "chip" ? "text-[13.5px]" : "text-[15px]"}`}>{shown}</span>;
  const shownPercent = percent !== undefined && Number.isFinite(percent) && percent > 0 ? Math.round(percent) : undefined;
  const percentBadge = shownPercent !== undefined
    ? <small data-level-percent data-accent={percentAccent || undefined} className={`flex-none text-[10.5px] tabular-nums ${percentAccent ? "rounded-[3px] bg-orange-soft px-1 font-bold text-orange-deep" : "font-semibold text-faint"}`} title={`${shownPercent.toLocaleString("en-US")}% of typical ${unit === "USD" ? "spend" : "usage"}`}>{shownPercent.toLocaleString("en-US")}%</small>
    : null;
  const valueEditor = (
    <span className={`flex w-max items-baseline text-ink ${variant === "chip" ? "gap-[2px] rounded-[3px] border border-transparent px-0.5 hover:border-line focus-within:border-orange focus-within:bg-field" : "gap-[3px] -ml-1 rounded-[4px] border border-transparent px-1 hover:border-line focus-within:border-orange focus-within:bg-field"}`}>
      {unit === "USD" && <b className={variant === "chip" ? "text-[10.5px] font-semibold text-faint" : "text-[13px] text-faint"}>$</b>}
      {input}
      {unit !== "USD" && <small className="flex-none text-[10px] font-medium text-faint">{unitLabel(unit)}</small>}
    </span>
  );

  if (variant === "chip") {
    // Only an editable value catches the pointer; every other pixel falls
    // through to the row's expand button.
    return (
      <span data-level-field data-variant="chip" className="pointer-events-none inline-flex min-w-0 flex-col gap-0.5 tabular-nums" title={title}>
        {/* A deviated chip trades its level name for the percent badge; the
            diamonds and neighboring rows carry the level identity. */}
        {/* The rotated diamond's tip overhangs its box ~1.7px; the nudge puts
            the tip on the value's left edge below. */}
        <span data-level-label className="flex min-w-0 items-baseline gap-1 text-[10.5px] font-bold text-faint">
          <span className="ml-[3.5px] flex self-center">{swatch}</span>
          {percentBadge ?? <span className="truncate">{level.label}</span>}
        </span>
        <span className={onCommit ? "pointer-events-auto min-w-0" : "min-w-0"}>{valueEditor}</span>
      </span>
    );
  }

  return (
    <div
      data-level-field
      data-variant={variant}
      className={`flex min-w-0 flex-col transition-[background-color,border-color] ${variant === "boxed" ? `gap-1 rounded-field border bg-field px-2 py-1.5 focus-within:border-orange focus-within:shadow-[0_0_0_3px_#f6821f1c] ${highlight ? "border-line-strong" : "border-field-line"}` : `-mx-1.5 -my-1 w-max rounded-[6px] px-1.5 py-1 ${highlight ? "bg-field" : ""}`}`}
    >
      <span data-level-label className={`${variant === "boxed" ? "text-[11px]" : "text-[10.5px]"} flex min-w-0 items-baseline gap-1.5 font-bold text-muted`}>
        <span className="ml-[1.5px] flex self-center">{swatch}</span>
        <span className="truncate">{level.label}</span>
        {percentBadge}
      </span>
      {valueEditor}
    </div>
  );
}
