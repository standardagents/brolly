import { money, number as formatNumber } from "../../format";

/** Short unit labels for tight cells; anything not listed shows as-is. */
const UNIT_ABBREVIATIONS: Record<string, string> = { requests: "reqs", messages: "msgs", operations: "ops", transformations: "xforms" };

export function unitLabel(unit: string): string {
  return UNIT_ABBREVIATIONS[unit] ?? unit;
}

export function formatLimitValue(value: number, unit: string): string {
  if (unit === "USD") return money(value);
  return `${formatNumber(value)} ${unitLabel(unit)}`;
}

/** Short display form: values from 1,000 up carry a K/M/B/T suffix. */
export function compactValue(value: number, _unit: string): string {
  return value >= 1_000
    ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(roundForField(value));
}

/** Select the digits of an edit value while leaving a K/M/B/T suffix unselected. */
export function selectNumber(input: HTMLInputElement, text: string): void {
  const digits = text.match(/^[0-9.]*/)?.[0].length ?? text.length;
  requestAnimationFrame(() => { try { input.setSelectionRange(0, digits); } catch { /* unsupported input type */ } });
}

/** Editable form with extra precision and a retained K/M/B/T suffix for large values. */
export function editableValue(value: number, _unit: string): string {
  if (!(value >= 1_000)) return String(roundForField(value));
  const units: Array<[number, string]> = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  const [scale, suffix] = units.find(([limit]) => value >= limit)!;
  return `${roundFloatText(value / scale)}${suffix}`;
}

/** Accepts values such as "5.8B", "12k", "$2,000", and "1.5 M". */
export function parseCompact(text: string): number | null {
  const match = text.trim().replace(/,/g, "").match(/^\$?\s*([0-9]*\.?[0-9]+)\s*([kKmMbBtT])?/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const scale: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  return base * (match[2] ? scale[match[2].toLowerCase()]! : 1);
}

function roundFloatText(value: number): string {
  return String(Number(value.toPrecision(4)));
}

function roundForField(value: number): number {
  return Number(value.toFixed(value >= 100 ? 0 : 2));
}
