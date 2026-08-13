import { useEffect, useState } from "react";
import { ProductIcon } from "../components/ui";
import { normalizeNumericDraft } from "../format";
import type { SpendLimits, Threshold } from "../types";
import type { LimitRow } from "./model";

const LIMIT_KEYS = ["warning", "critical", "emergency"] as const;

export function LimitEditor({ title, value, onChange }: { title: string; value: SpendLimits; onChange: (value: SpendLimits) => void }) {
  return (
    <div className="limit-editor">
      <h3>{title}</h3>
      <div className="limit-grid">
        {LIMIT_KEYS.map(key => (
          <label key={key}>
            <span>{key}</span>
            <div className="money-input"><b>$</b><NumericInput value={value[key]} step="0.01" onChange={next => onChange({ ...value, [key]: next })} /></div>
            <small>per rolling day</small>
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

export function LimitTable({ heading, rows }: { heading: string; rows: LimitTableRow[] }) {
  return <>
    <div className="limit-table-head"><span>{heading}</span><span>Warn</span><span>Critical</span><span>Emergency</span></div>
    <div className="limit-table">
      {rows.map(({ key, ...row }) => <BudgetLimitRow key={key} {...row} />)}
    </div>
  </>;
}

function BudgetLimitRow({ family, label, detail, connected, value, onChange }: Omit<LimitTableRow, "key">) {
  return (
    <div className="limit-table-row">
      <div className="resource-label">
        <ProductIcon family={family} />
        <span className="resource-label-copy">
          <strong>{label}</strong>
          <small><i className={`coverage-dot ${connected ? "active" : "gap"}`} aria-hidden="true" />{detail}</small>
        </span>
      </div>
      {LIMIT_KEYS.map(key => (
        <label key={key}>
          <span>$</span>
          <NumericInput ariaLabel={`${label} ${key}`} value={value[key]} step="0.01" onChange={next => onChange({ ...value, [key]: next })} />
        </label>
      ))}
    </div>
  );
}

export function TelemetryLegend() {
  return (
    <div className="telemetry-legend" aria-label="Usage data status legend">
      <span><i className="coverage-dot active" aria-hidden="true" /><span><strong>Usage connected</strong><small>Brolly can read every known billing signal for this product</small></span></span>
      <span><i className="coverage-dot gap" aria-hidden="true" /><span><strong>Limited usage data</strong><small>Cloudflare currently exposes only some signals to this installation</small></span></span>
    </div>
  );
}

export function ObjectLimitRow({ row, threshold, onChange }: { row: LimitRow; threshold: Threshold; onChange: (threshold: Threshold) => void }) {
  return (
    <div className="object-limit-row">
      <div><strong>{row.label}</strong><small>{row.unit}</small></div>
      {LIMIT_KEYS.map(key => (
        <label key={key}>
          <span>{key}</span>
          <NumericInput value={threshold[key] ?? 0} step={row.metric.includes("cost") ? "0.01" : "1"} onChange={next => onChange({ ...threshold, [key]: next })} />
        </label>
      ))}
    </div>
  );
}

function NumericInput({ value, step, ariaLabel, onChange }: { value: number; step: string; ariaLabel?: string; onChange: (value: number) => void }) {
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

  return <input aria-label={ariaLabel} type="number" min="0" step={step} value={draft} onChange={event => update(event.target.value)} onBlur={commit} />;
}
