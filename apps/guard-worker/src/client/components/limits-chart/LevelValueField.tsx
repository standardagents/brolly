import { useRef, useState, type KeyboardEvent } from "react";
import { Switch } from "../ui";
import { compactValue, editableValue, parseCompact, selectNumber, unitLabel } from "./format";
import type { LimitsChartLevel } from "./LimitsChart";
import { snapStep } from "./scale";

export interface LevelValueFieldProps {
  level: LimitsChartLevel;
  unit: string;
  value: number | undefined;
  enabled: boolean;
  onCommit?(next: number): void;
  onToggle?(next: boolean): void;
  variant?: "boxed" | "bare" | "chip";
  step?(value: number): number;
}

/** One alert-level value editor shared by chart fields, tracks, rows, and risk tolerance. */
export function LevelValueField({ level, unit, value, enabled, onCommit, onToggle, variant = "boxed", step }: LevelValueFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelBlur = useRef(false);
  const display = value === undefined ? "–" : compactValue(value, unit);
  const shown = draft ?? display;
  const title = `${level.label} limit${enabled ? "" : " (off)"}${onCommit ? " · click to edit" : ""}`;
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
  const toggle = onToggle ? <Switch label={`Use ${level.label} level`} on={enabled} onChange={onToggle} title={enabled ? `${level.label} is active. Switch off to skip it.` : `${level.label} is off.`} /> : null;
  const input = onCommit ? (
    <input
      className={`min-w-[2ch] max-w-full border-0 bg-transparent p-0 font-[740] tabular-nums outline-none disabled:cursor-default ${variant === "chip" ? "text-[10.5px] text-muted" : "text-[15px] text-ink"}`}
      style={{ width: `calc(${Math.max(variant === "chip" ? 3 : 2, shown.length)}ch + 2px)` }}
      inputMode="decimal"
      disabled={!enabled}
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
  ) : <span className={variant === "chip" ? "text-[10.5px] text-muted" : "text-[15px] font-[740] text-ink"}>{shown}</span>;
  const valueEditor = (
    <span className={`flex w-max items-baseline gap-[3px] text-ink ${variant === "chip" ? "rounded-[3px] border border-transparent px-0.5 hover:border-line focus-within:border-orange focus-within:bg-field" : "-ml-1 rounded-[4px] border border-transparent px-1 hover:border-line focus-within:border-orange focus-within:bg-field"}`}>
      {unit === "USD" && <b className={variant === "chip" ? "text-[10.5px] text-faint" : "text-[13px] text-faint"}>$</b>}
      {input}
      {unit !== "USD" && <small className="flex-none text-[10.5px] font-medium text-faint">{unitLabel(unit)}</small>}
    </span>
  );

  if (variant === "chip") {
    return (
      <span data-level-field data-variant="chip" className={`inline-flex min-w-0 items-center gap-1 text-[10.5px] tabular-nums text-muted transition-opacity ${enabled ? "" : "opacity-55 line-through"}`} title={title}>
        {swatch}
        <span data-level-label className="truncate font-bold">{level.label}</span>
        {valueEditor}
        {toggle}
      </span>
    );
  }

  return (
    <div
      data-level-field
      data-variant={variant}
      className={`flex min-w-0 flex-col transition-opacity ${variant === "boxed" ? "gap-1 rounded-field border border-field-line bg-field px-2 py-1.5 focus-within:border-orange focus-within:shadow-[0_0_0_3px_#f6821f1c]" : "w-full"} ${enabled ? "" : "opacity-55"}`}
    >
      <span data-level-label className={`${variant === "boxed" ? "text-[11.5px]" : "text-[11px]"} flex min-w-0 items-center gap-1.5 font-bold text-muted`}>
        {swatch}
        <span className="truncate">{level.label}</span>
        {toggle && <span className={variant === "boxed" ? "ml-auto flex-none" : "ml-3 flex-none"}>{toggle}</span>}
      </span>
      {valueEditor}
    </div>
  );
}
