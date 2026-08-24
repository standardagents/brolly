import { money } from "../../format";
import { formatLimitValue } from "./format";

/** Shared shell for chart readouts and live line-value chips. */
export const FLOAT_CHIP = "pointer-events-none absolute z-10 whitespace-nowrap rounded-[6px] border border-line bg-panel px-2 py-1 text-[11px] leading-[1.45] shadow-[0_2px_8px_rgba(0,0,0,.08)]";

interface BillableUsageTooltipProps {
  x: number;
  y: number;
  width: number;
  color: string;
  label: string;
  day: string;
  dayOfCycle: number;
  cycleDays: number;
  total: number;
  included?: number;
  costUsd?: number;
  unit: string;
}

/** Cycle-end usage marker details with the billed meter's list-rate estimate. */
export function BillableUsageTooltip({ x, y, width, color, label, day, dayOfCycle, cycleDays, total, included, costUsd, unit }: BillableUsageTooltipProps) {
  return (
    <div data-billable-tooltip role="status" className={`${FLOAT_CHIP} -translate-y-full ${x > width * 0.7 ? "-translate-x-full" : x < width * 0.3 ? "" : "-translate-x-1/2"}`}
      style={{ left: x, top: y - 12 }}>
      <b className="font-[720]" style={{ color }}>{label} usage</b>
      <span className="mt-0.5 block text-muted">{day} · Cycle: {dayOfCycle} of {cycleDays}</span>
      <span className="mt-1 grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
        <span className="text-muted">Total usage</span>
        <span className="text-right font-[720] tabular-nums text-ink">{formatLimitValue(total, unit)}</span>
        {included !== undefined && <>
          <span className="text-muted">Billable usage</span>
          <span className="text-right font-[720] tabular-nums text-ink">{formatLimitValue(Math.max(0, total - included), unit)}</span>
        </>}
      </span>
      {costUsd !== undefined && (
        <span className="mt-1.5 flex items-baseline justify-between gap-5 border-t border-line-soft pt-1.5">
          <span className="text-muted">Estimated billable cost</span>
          <b data-billable-cost className="text-[12px] font-[760] tabular-nums text-ink">{money(costUsd)}</b>
        </span>
      )}
    </div>
  );
}
