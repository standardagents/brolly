import { dateTime, money } from "../format";
import type { SpendPoint } from "../types";

/**
 * Bounded aggregate spend trend. Points are account-level rolling-24h (or
 * projected-daily) totals written by the monitor — never a per-object rescan.
 */
export function SpendChart({ points }: { points: SpendPoint[] }) {
  if (points.length < 2) {
    return (
      <div className="grid h-[270px] place-content-center text-center text-muted">
        <div className="mb-3.5 flex h-[90px] items-end justify-center gap-2">
          <span className="h-[28px] w-[28px] rounded-t bg-[#e3e7eb] dark:bg-[#343a42]" />
          <span className="h-[58px] w-[28px] rounded-t bg-[#e3e7eb] dark:bg-[#343a42]" />
          <span className="h-[42px] w-[28px] rounded-t bg-[#e3e7eb] dark:bg-[#343a42]" />
          <span className="h-[76px] w-[28px] rounded-t bg-orange-soft" />
        </div>
        <strong>Building today's trend</strong>
        <p className="mt-[5px] mb-0 max-w-[40ch] text-[13px] text-faint">The monitor stores one bounded spend aggregate per pass; the chart appears after a few scans.</p>
      </div>
    );
  }
  const width = 760;
  const height = 220;
  const pad = 16;
  const max = Math.max(...points.map(point => point.totalUsd), 0.01);
  const coordinates = points.map((point, index) => ({
    x: pad + index * ((width - pad * 2) / Math.max(1, points.length - 1)),
    y: height - pad - (point.totalUsd / max) * (height - pad * 2),
    ...point,
  }));
  const line = coordinates.map(point => `${point.x},${point.y}`).join(" ");
  const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;
  return (
    <div className="relative min-w-0 pt-3 pr-0 pb-[22px] pl-[46px]">
      <div className="absolute top-[18px] bottom-10 left-0 flex flex-col justify-between text-[11px] tabular-nums text-faint" aria-hidden="true">
        <span>{money(max)}</span>
        <span>{money(max / 2)}</span>
        <span>$0</span>
      </div>
      <svg className="block h-[230px] w-full overflow-visible" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Estimated daily spend trend">
        <defs>
          <linearGradient id="spend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f6821f" stopOpacity=".22" />
            <stop offset="1" stopColor="#f6821f" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={pad} x2={width - pad} y1={height / 2} y2={height / 2} className="stroke-line-soft [stroke-dasharray:5_7]" />
        <polygon points={area} fill="url(#spend-fill)" />
        <polyline points={line} fill="none" stroke="#f6821f" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {coordinates.map(point => (
          <circle key={point.at} cx={point.x} cy={point.y} r="3.5" fill="#fff" stroke="#f6821f" strokeWidth="2.5">
            <title>{dateTime(point.at)} · {money(point.totalUsd)}</title>
          </circle>
        ))}
      </svg>
      <div className="flex justify-between text-[11px] text-faint" aria-hidden="true">
        <span>{dateTime(points[0]?.at ?? 0)}</span>
        <span>Now</span>
      </div>
    </div>
  );
}

/** Change in the plotted total across roughly the trailing three hours, for the acceleration read-out. */
export function spendDelta(points: SpendPoint[]): { deltaUsd: number; sinceMs: number } | null {
  if (points.length < 2) return null;
  const latest = points[points.length - 1]!;
  const target = latest.at - 3 * 3_600_000;
  const reference = [...points].reverse().find(point => point.at <= target) ?? points[0]!;
  if (reference.at === latest.at) return null;
  return { deltaUsd: latest.totalUsd - reference.totalUsd, sinceMs: latest.at - reference.at };
}
