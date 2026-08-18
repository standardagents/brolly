import { useMemo, useState } from "react";
import { Segmented, Spinner } from "../ui";
import { billableMetricIds, costSeries, metricSeries, useUsageSeries } from "./api";
import type { LevelValues } from "./levels";
import { LimitsChart, type LimitsChartLevel } from "./LimitsChart";

export interface UsageLimitValues { [metricId: string]: LevelValues }

export interface LimitsChartPairProps {
  token: string;
  /** Policy scope key: `account`, `family:<family>`, or `asset:<key>`. */
  scope: string;
  window: "day" | "cycle";
  levels: LimitsChartLevel[];
  cost: LevelValues;
  onCostChange(next: LevelValues): void;
  usage: UsageLimitValues;
  onUsageChange(next: UsageLimitValues): void;
  /** Minimums per level for the cost chart (cycle ≥ daily). */
  costFloor?: LevelValues;
  /** Minimums per level and metric for the usage chart. */
  usageFloor?: UsageLimitValues;
  readOnly?: boolean;
}

/**
 * Cost chart on the left, usage chart on the right, both bound to the same
 * scope's history. Usage gets one tab per billable metric; each tab has its
 * own limit map. Below `md` the pair stacks.
 */
export function LimitsChartPair({ token, scope, window, levels, cost, onCostChange, usage, onUsageChange, costFloor, usageFloor, readOnly }: LimitsChartPairProps) {
  const { data, loading, error } = useUsageSeries(token, scope);
  const metricIds = useMemo(() => (data ? billableMetricIds(data) : []), [data]);
  const [selected, setSelected] = useState<string | null>(null);
  const metricId = selected && metricIds.includes(selected) ? selected : metricIds[0] ?? null;
  // Cycle limits are seeded from the daily limits × days in the current cycle.
  const cycleDays = useMemo(() => {
    if (!data) return 30;
    const todayAt = Date.parse(`${data.today}T00:00:00Z`);
    const current = data.cycles.find(cycle => todayAt >= cycle.startsAt && todayAt < cycle.endsAt);
    return current ? Math.max(1, Math.round((current.endsAt - current.startsAt) / 86_400_000)) : 30;
  }, [data]);
  const scaleFloor = (floor?: LevelValues) => (window === "cycle" && floor ? Object.fromEntries(Object.entries(floor).map(([id, item]) => [id, item * cycleDays])) : undefined);

  if (loading) {
    return <div className="grid h-[290px] place-content-center text-[13px] text-faint"><span className="inline-flex items-center gap-2"><Spinner /> Loading usage history…</span></div>;
  }
  if (error || !data) {
    return <div className="grid h-[290px] place-content-center text-center text-[13px] text-faint">Usage history is unavailable. {error}</div>;
  }

  return (
    <div className="grid grid-cols-2 gap-5 max-md:grid-cols-1">
      <section className="min-w-0">
        <ChartHead title={window === "day" ? "Cost per day" : "Cost per billing cycle"} />
        <LimitsChart kind="cost" unit="USD" window={window} series={costSeries(data)} cycles={data.cycles} today={data.today}
          levels={levels} value={cost} floor={costFloor} seed={scaleFloor(costFloor)} onChange={onCostChange} readOnly={readOnly} />
      </section>
      <section className="min-w-0">
        <ChartHead title={window === "day" ? "Usage per day" : "Usage per billing cycle"}>
          {metricIds.length > 1 && metricId && (
            <Segmented value={metricId} ariaLabel="Usage dimension" onChange={setSelected}
              options={metricIds.map(id => ({ value: id, label: data.metrics[id]?.label ?? id }))} />
          )}
        </ChartHead>
        {metricId ? (
          <LimitsChart kind="usage" unit={data.metrics[metricId]?.unit ?? ""} window={window} series={metricSeries(data, metricId)}
            cycles={data.cycles} today={data.today} levels={levels} value={usage[metricId] ?? {}} floor={usageFloor?.[metricId]} seed={scaleFloor(usageFloor?.[metricId])}
            onChange={next => onUsageChange({ ...usage, [metricId]: next })} readOnly={readOnly} />
        ) : (
          <div className="grid h-[250px] place-content-center text-[13px] text-faint">No billable usage recorded for this scope yet.</div>
        )}
      </section>
    </div>
  );
}

function ChartHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-2 flex min-h-[30px] flex-wrap items-center justify-between gap-2">
      <h4 className="text-[13px] font-bold">{title}</h4>
      {children}
    </div>
  );
}
