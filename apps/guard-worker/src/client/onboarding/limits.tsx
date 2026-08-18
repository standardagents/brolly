import { useEffect, useState, type CSSProperties } from "react";
import { ProductIcon } from "../components/ui";
import { normalizeNumericDraft } from "../format";
import type { AlertLevel, SpendLimits, Threshold } from "../types";
import type { LimitRow } from "./model";

const THRESHOLD_KEYS = ["warning", "critical", "emergency"] as const;

/** Shared grid classes for spend limits. The column count comes from the level board. */
const LIMIT_TABLE_GRID = "grid items-center gap-3";

function limitGridStyle(levelCount: number, firstColumn = "minmax(180px,1.5fr)"): CSSProperties {
  return { gridTemplateColumns: `${firstColumn} repeat(${Math.max(levelCount, 1)}, minmax(88px,.65fr))` };
}

/** Money field wrapper used by every limit input. */
const MONEY_BOX = "flex items-center rounded-field border border-field-line bg-field text-ink focus-within:border-orange focus-within:shadow-[0_0_0_3px_#f6821f1c]";

/** Telemetry coverage indicator dot. */
export function CoverageDot({ active, className = "" }: { active: boolean; className?: string }) {
  return <i className={`inline-block size-2 flex-none rounded-full ${active ? "bg-[#1b9e5a]" : "bg-[#e79021]"} ${className}`} aria-hidden="true" />;
}

export function LimitEditor({ title, levels, value, onChange }: {
  title: string;
  levels: AlertLevel[];
  value: SpendLimits;
  onChange: (value: SpendLimits) => void;
}) {
  return (
    <div className="rounded-panel border border-line p-[22px]">
      <h3 className="mb-[18px] text-[15px]">{title}</h3>
      <div className="grid gap-3.5 overflow-x-auto" style={{ gridTemplateColumns: `repeat(${Math.max(levels.length, 1)}, minmax(130px, 1fr))` }}>
        {levels.map(level => (
          <label key={level.id} className="text-[12px] font-bold text-muted">
            <span>{level.label}</span>
            <div className={`${MONEY_BOX} my-[7px] px-3`}>
              <b>$</b>
              <NumericInput
                className="h-11 w-full border-0 bg-transparent pl-[7px] text-[19px] font-[740] outline-none"
                value={value[level.id] ?? 0}
                step="0.01"
                onChange={next => onChange({ ...value, [level.id]: next })}
              />
            </div>
            <small className="font-medium text-faint">per rolling day</small>
          </label>
        ))}
      </div>
    </div>
  );
}

export type LimitTableRow = {
  key: string;
  family: string;
  label: string;
  detail: string;
  connected: boolean;
  value: SpendLimits;
  onChange: (value: SpendLimits) => void;
};

export function LimitTable({ heading, levels, rows }: { heading: string; levels: AlertLevel[]; rows: LimitTableRow[] }) {
  return <div className="overflow-x-auto">
      <div
        className={`${LIMIT_TABLE_GRID} min-w-max px-3.5 pb-[9px] text-[11px] font-extrabold uppercase tracking-[.08em] text-faint max-md:hidden`}
        style={limitGridStyle(levels.length)}
      >
        <span>{heading}</span>{levels.map(level => <span key={level.id}>{level.label}</span>)}
      </div>
    <div className="rounded-panel border border-line">
      <div className="min-w-max">
        {rows.map(({ key, ...row }) => <BudgetLimitRow key={key} levels={levels} {...row} />)}
      </div>
    </div>
  </div>;
}

function BudgetLimitRow({ family, label, detail, connected, levels, value, onChange }: Omit<LimitTableRow, "key"> & { levels: AlertLevel[] }) {
  return (
    <div
      className={`${LIMIT_TABLE_GRID} border-t border-line-soft px-3.5 py-3 first:border-t-0 max-md:gap-1.5 max-md:px-3 max-md:py-[13px]`}
      style={limitGridStyle(levels.length)}
    >
      <div className="flex min-w-0 items-center gap-2.5 max-md:col-span-full max-md:mb-[5px]">
        <ProductIcon family={family} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <strong className="truncate text-[13.5px]">{label}</strong>
          <small className="inline-flex items-center gap-[5px] text-[11.5px] text-faint"><CoverageDot active={connected} />{detail}</small>
        </span>
      </div>
      {levels.map(level => (
        <label key={level.id} className={`${MONEY_BOX} h-[38px] px-[9px] text-faint`}>
          <span>$</span>
          <NumericInput
            className="w-full border-0 bg-transparent pl-1 font-bold outline-none"
            ariaLabel={`${label} ${level.label}`}
            value={value[level.id] ?? 0}
            step="0.01"
            onChange={next => onChange({ ...value, [level.id]: next })}
          />
        </label>
      ))}
    </div>
  );
}

export function TelemetryLegend() {
  return (
    <div className="mb-4 flex flex-wrap gap-[22px] rounded-field border border-line-soft bg-panel-soft px-3.5 py-3" aria-label="Usage data status legend">
      <span className="flex items-start gap-[9px]">
        <CoverageDot active className="mt-[5px]" />
        <span><strong className="block text-[12.5px]">Usage connected</strong><small className="text-[12px] text-muted">Brolly can read every known billing signal for this product</small></span>
      </span>
      <span className="flex items-start gap-[9px]">
        <CoverageDot active={false} className="mt-[5px]" />
        <span><strong className="block text-[12.5px]">Limited usage data</strong><small className="text-[12px] text-muted">Cloudflare currently exposes only some signals to this installation</small></span>
      </span>
    </div>
  );
}

export function ObjectLimitRow({ row, threshold, onChange }: { row: LimitRow; threshold: Threshold; onChange: (threshold: Threshold) => void }) {
  return (
    <div className="grid grid-cols-[minmax(220px,1.4fr)_repeat(3,minmax(100px,.7fr))] items-center gap-3.5 border-t border-line-soft p-[15px] first:border-t-0 max-md:grid-cols-3 max-md:gap-[7px]">
      <div className="flex flex-col gap-[3px] max-md:col-span-full">
        <strong className="text-[13.5px]">{row.label}</strong>
        <small className="text-[12px] text-muted">{row.unit}</small>
      </div>
      {THRESHOLD_KEYS.map(key => (
        <label key={key} className="text-[10px] font-extrabold uppercase text-muted">
          <span>{key}</span>
          <NumericInput
            className="mt-[5px] block h-[37px] w-full rounded-field border border-field-line bg-field px-[9px] font-bold text-ink focus:border-orange focus:shadow-[0_0_0_3px_#f6821f1c] focus:outline-none"
            value={threshold[key] ?? 0}
            step={row.metric.includes("cost") ? "0.01" : "1"}
            onChange={next => onChange({ ...threshold, [key]: next })}
          />
        </label>
      ))}
    </div>
  );
}

function NumericInput({ value, step, ariaLabel, className, onChange }: { value: number; step: string; ariaLabel?: string; className?: string; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => { setDraft(String(value)); }, [value]);

  function update(raw: string) {
    const normalized = normalizeNumericDraft(raw);
    setDraft(normalized);
    if (normalized === "") return;
    const next = Number(normalized);
    if (Number.isFinite(next) && next >= 0) onChange(next);
  }

  function commit() {
    if (draft === "") {
      setDraft(String(value));
      return;
    }
    const next = Number(draft);
    if (Number.isFinite(next) && next >= 0) {
      setDraft(String(next));
      onChange(next);
    } else {
      setDraft(String(value));
    }
  }

  return <input className={className} aria-label={ariaLabel} type="number" min="0" step={step} value={draft} onChange={event => update(event.target.value)} onBlur={commit} />;
}
