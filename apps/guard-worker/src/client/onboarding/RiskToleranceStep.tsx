import { useEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type PointerEvent, type SetStateAction } from "react";
import { costSeries, useUsageSeries } from "../components/limits-chart/api";
import { cycleIndexFor, daysBetween } from "../components/limits-chart/cycles";
import { levelColor } from "../components/limits-chart/LimitsChart";
import { snapStep, snapToNice } from "../components/limits-chart/scale";
import { Spinner } from "../components/ui";
import type { AlertLevel, Policy, RiskTolerancePreset } from "../types";
import { StepIntro } from "./BudgetSteps";
import {
  changeToleranceValue,
  MAX_TOLERANCE_PERCENT,
  MIN_TOLERANCE_PERCENT,
  normalizeRiskTolerance,
  percentile95,
  RISK_TOLERANCE_WINDOW_DAYS,
  toleranceAxis,
  tolerancePresetValues,
  typicalDay,
} from "./risk-tolerance";

const PRESETS: Array<{ id: Exclude<RiskTolerancePreset, "custom">; label: string }> = [
  { id: "conservative", label: "Conservative" },
  { id: "balanced", label: "Balanced" },
  { id: "growth", label: "Growth" },
];

export function RiskToleranceStep({ token, policy, levels, setPolicy }: {
  token: string;
  policy: Policy;
  levels: AlertLevel[];
  setPolicy: Dispatch<SetStateAction<Policy>>;
}) {
  const usage = useUsageSeries(token, "account");
  const order = useMemo(() => levels.map(level => level.id), [levels]);
  const tolerance = normalizeRiskTolerance(policy.riskTolerance, order);
  const series = usage.data ? costSeries(usage.data) : [];
  const typical = usage.data ? typicalDay(series, usage.data.today, tolerance.baseline.windowDays) : 0;
  const p95 = usage.data ? percentile95(series, usage.data.today, tolerance.baseline.windowDays) : 0;
  const cycleDays = useMemo(() => {
    if (!usage.data) return 30;
    const current = cycleIndexFor(usage.data.cycles, usage.data.today);
    const cycle = usage.data.cycles[current] ?? usage.data.cycles.at(-1);
    return cycle ? daysBetween(cycle.startsAt, cycle.endsAt) : 30;
  }, [usage.data]);
  const chartLevels = levels.map((level, index) => ({ ...level, color: levelColor(index, levels.length) }));

  const commit = (preset: RiskTolerancePreset, percentOfTypical: Record<string, number>) => {
    setPolicy(current => ({
      ...current,
      riskTolerance: {
        preset,
        percentOfTypical,
        baseline: { computedAt: Date.now(), windowDays: RISK_TOLERANCE_WINDOW_DAYS },
      },
    }));
  };

  return <>
    <StepIntro title="Risk tolerance">
      How far above your normal usage each alert level should sit. This sets every starting limit. You can fine-tune each limit on the next steps.
    </StepIntro>
    <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label="Risk tolerance preset">
      {PRESETS.map(preset => (
        <button
          key={preset.id}
          type="button"
          aria-pressed={tolerance.preset === preset.id}
          className={`rounded-field border px-3.5 py-2 text-[12.5px] font-bold transition-colors ${tolerance.preset === preset.id ? "border-orange bg-orange-soft text-orange-deep" : "border-line bg-panel-soft text-muted hover:border-orange hover:text-ink"}`}
          onClick={() => commit(preset.id, tolerancePresetValues(preset.id, order))}
        >{preset.label}</button>
      ))}
      {tolerance.preset === "custom" && <span className="ml-1 text-[12px] font-semibold text-faint">Custom</span>}
    </div>
    {usage.loading && <div className="mb-4 inline-flex items-center gap-2 text-[12.5px] text-muted"><Spinner /> Loading account history…</div>}
    {usage.error && <p className="mb-4 text-[12.5px] text-muted">Account history is unavailable. Percentages can still be configured.</p>}
    <ToleranceScale
      levels={chartLevels}
      value={tolerance.percentOfTypical}
      typical={typical}
      p95={p95}
      onChange={next => commit("custom", next)}
    />
    <div className="mt-5 grid gap-2.5" aria-label="Risk tolerance estimates">
      {chartLevels.map(level => {
        const percent = tolerance.percentOfTypical[level.id] ?? 0;
        const daily = typical * percent / 100;
        return (
          <p key={level.id} className="text-[12.5px] leading-5 text-muted">
            <span className="mr-2 inline-block size-2 rotate-45 rounded-[1px]" style={{ background: level.color }} aria-hidden="true" />
            <strong className="text-ink">{level.label} at {formatPercent(percent)}</strong>
            {typical > 0 ? ` · about ${money(daily)}/day and ${money(daily * cycleDays)}/cycle at your current account spend` : " · account history has no nonzero daily spend"}
          </p>
        );
      })}
    </div>
  </>;
}

export function ToleranceScale({ levels, value, typical, p95, onChange }: {
  levels: Array<{ id: string; label: string; color: string }>;
  value: Record<string, number>;
  typical: number;
  p95: number;
  onChange: (next: Record<string, number>) => void;
}) {
  const order = useMemo(() => levels.map(level => level.id), [levels]);
  const liveAxis = useMemo(() => toleranceAxis(Math.max(10_000, ...Object.values(value))), [value]);
  const [frozenAxis, setFrozenAxis] = useState<ReturnType<typeof toleranceAxis> | null>(null);
  const axis = frozenAxis ?? liveAxis;
  const [dragging, setDragging] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const top = 24;
  const height = 300;
  const left = 86;
  const right = 612;
  const yFor = (percent: number) => top + (1 - axis.position(percent)) * height;
  const percentAt = (clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const fraction = rect?.height ? (clientY - rect.top) / rect.height : 0;
    const y = fraction * 350;
    return snapToNice(axis.invert(1 - (y - top) / height), 1);
  };
  const change = (id: string, next: number) => onChange(changeToleranceValue(value, order, id, next));
  const p95Percent = typical > 0 ? p95 / typical * 100 : 100;

  const pointerDown = (id: string) => (event: PointerEvent<SVGElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setFrozenAxis(axis);
    setDragging(id);
    change(id, percentAt(event.clientY));
  };
  const pointerMove = (id: string) => (event: PointerEvent<SVGElement>) => {
    if (dragging === id) change(id, percentAt(event.clientY));
  };
  const pointerUp = (event: PointerEvent<SVGElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(null);
    setFrozenAxis(null);
  };
  const keyDown = (id: string) => (event: KeyboardEvent<SVGElement>) => {
    if (!["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft", "PageUp", "PageDown"].includes(event.key)) return;
    event.preventDefault();
    const current = value[id] ?? MIN_TOLERANCE_PERCENT;
    const step = snapStep(current, 1) * (event.shiftKey || event.key === "PageUp" || event.key === "PageDown" ? 10 : 1);
    const increase = event.key === "ArrowUp" || event.key === "ArrowRight" || event.key === "PageUp";
    change(id, current + (increase ? step : -step));
  };

  return (
    <div className="rounded-panel border border-line bg-panel-soft p-4 max-md:px-2">
      <svg ref={svgRef} viewBox="0 0 640 350" className="block h-auto w-full touch-none" role="group" aria-label="Percent of typical usage by alert level">
        <rect x={left} y={yFor(105)} width={right - left} height={Math.max(4, yFor(100) - yFor(105))} className="fill-line-soft" />
        <text x={left + 5} y={yFor(100) - 7} className="fill-faint text-[11px]">typical day</text>
        {typical > 0 && p95 > 0 && <>
          <line x1={left} x2={right} y1={yFor(p95Percent)} y2={yFor(p95Percent)} className="stroke-faint" strokeDasharray="3 4" opacity=".55" />
          <text x={right - 4} y={yFor(p95Percent) - 7} textAnchor="end" className="fill-faint text-[11px]">busiest normal day</text>
        </>}
        {axis.ticks.map(tick => <g key={tick}>
          <line x1={left} x2={right} y1={yFor(tick)} y2={yFor(tick)} className="stroke-line-soft" />
          <text x={left - 10} y={yFor(tick) + 4} textAnchor="end" className="fill-faint text-[10.5px]">{formatPercent(tick)}</text>
        </g>)}
        {levels.map(level => {
          const percent = value[level.id] ?? MIN_TOLERANCE_PERCENT;
          const y = yFor(percent);
          return <g key={level.id}>
            <line x1={left} x2={right} y1={y} y2={y} stroke={level.color} strokeWidth="2" strokeDasharray="6 4" />
            <text x={left + 8} y={y - 8} fill={level.color} className="text-[11px] font-bold">{level.label} · {formatPercent(percent)}</text>
            <rect
              x={right - 8}
              y={y - 8}
              width="16"
              height="16"
              rx="2"
              transform={`rotate(45 ${right} ${y})`}
              fill={level.color}
              className="cursor-ns-resize outline-none focus:stroke-ink focus:stroke-[3px]"
              role="slider"
              tabIndex={0}
              aria-label={`${level.label} risk tolerance`}
              aria-valuemin={MIN_TOLERANCE_PERCENT}
              aria-valuemax={MAX_TOLERANCE_PERCENT}
              aria-valuenow={percent}
              aria-valuetext={formatPercent(percent)}
              aria-orientation="vertical"
              onPointerDown={pointerDown(level.id)}
              onPointerMove={pointerMove(level.id)}
              onPointerUp={pointerUp}
              onPointerCancel={pointerUp}
              onKeyDown={keyDown(level.id)}
            />
          </g>;
        })}
      </svg>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {levels.map(level => <ToleranceField key={level.id} level={level} value={value[level.id] ?? MIN_TOLERANCE_PERCENT} onCommit={next => change(level.id, next)} />)}
      </div>
    </div>
  );
}

function ToleranceField({ level, value, onCommit }: { level: { label: string; color: string }; value: number; onCommit: (next: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const next = Number(draft.replace(/[% ,]/g, ""));
    if (Number.isFinite(next)) onCommit(next);
    setDraft(String(value));
  };
  return (
    <label className="rounded-field border border-line bg-panel px-3 py-2.5 text-[11.5px] font-bold text-muted focus-within:border-orange">
      <span className="mb-1.5 flex items-center gap-2"><i className="size-2 rotate-45 rounded-[1px]" style={{ background: level.color }} aria-hidden="true" />{level.label}</span>
      <span className="flex items-baseline gap-1">
        <input
          className="min-w-0 flex-1 border-0 bg-transparent text-[19px] font-bold text-ink outline-none"
          aria-label={`${level.label} percent of typical`}
          inputMode="decimal"
          value={draft}
          onFocus={() => setDraft(String(value))}
          onChange={event => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur(); }
            if (event.key === "Escape") { setDraft(String(value)); event.currentTarget.blur(); }
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              const step = snapStep(value, 1) * (event.shiftKey ? 10 : 1);
              onCommit(value + (event.key === "ArrowUp" ? step : -step));
            }
          }}
        />
        <span className="text-[12px] text-faint">%</span>
      </span>
    </label>
  );
}

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)}%`;
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value < 10 ? 2 : 0 }).format(value);
}
