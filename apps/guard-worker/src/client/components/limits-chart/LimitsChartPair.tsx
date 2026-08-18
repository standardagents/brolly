import { useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "../ui";
import { billableMetricIds, costSeries, metricSeries, useUsageSeries } from "./api";
import type { LevelValues } from "./levels";
import { LimitsChart, type LimitsChartLevel } from "./LimitsChart";
import { DimensionRows, summarizeCost, summarizeDimensions } from "./UsageDimensions";
import { defaultLevelValues, pushLevelValue, toleranceDefaults } from "./defaults";
import { useLimitHistories } from "./use-limit-history";
import { ProductIcon } from "../ui";

export interface UsageLimitValues { [metricId: string]: LevelValues }

export interface LimitsChartPairProps {
  token: string;
  /** Policy scope key: `account`, `family:<family>`, or `asset:<key>`. */
  scope: string;
  /** Product family shown beside each chart heading when the pair is family-scoped. */
  family?: string;
  window: "day" | "cycle";
  levels: LimitsChartLevel[];
  cost: LevelValues;
  onCostChange(next: LevelValues): void;
  usage: UsageLimitValues;
  onUsageChange(next: UsageLimitValues): void;
  /** Daily values used to seed and annotate the cycle cost chart. */
  costFloor?: LevelValues;
  /** Daily values used to seed and annotate cycle usage charts. */
  usageFloor?: UsageLimitValues;
  /** levelId → percent of typical usage. */
  tolerance?: LevelValues;
  readOnly?: boolean;
  /** metricId → monitored. Missing ids are monitored. Omit both to hide the switches. */
  usageEnabled?: Record<string, boolean>;
  onUsageEnabledChange?(next: Record<string, boolean>): void;
  costEnabled?: boolean;
  onCostEnabledChange?(next: boolean): void;
  /** Per-chart level switches: levelId → active. Missing ids are active. */
  costLevelEnabled?: Record<string, boolean>;
  onCostLevelEnabledChange?(next: Record<string, boolean>): void;
  usageLevelEnabled?: Record<string, Record<string, boolean>>;
  onUsageLevelEnabledChange?(next: Record<string, Record<string, boolean>>): void;
}

/**
 * Cost column on the left, usage column on the right, both bound to the same
 * scope's history. Each column is a list of dimension rows (cost has one);
 * the selected row expands into its chart, and each usage dimension has its
 * own limit map and an on/off switch. Below `md` the pair stacks.
 */
export function LimitsChartPair({ token, scope, family, window, levels, cost, onCostChange, usage, onUsageChange, costFloor, usageFloor, tolerance, readOnly, usageEnabled, onUsageEnabledChange, costEnabled = true, onCostEnabledChange, costLevelEnabled, onCostLevelEnabledChange, usageLevelEnabled, onUsageLevelEnabledChange }: LimitsChartPairProps) {
  const { data, loading, error } = useUsageSeries(token, scope);
  const metricIds = useMemo(() => (data ? billableMetricIds(data) : []), [data]);
  // `undefined` = nothing chosen yet (first row opens); `null` = user collapsed everything.
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [costOpen, setCostOpen] = useState(true);
  const firstMetric = metricIds[0] ?? null;
  const metricId = selected === undefined ? firstMetric : selected && metricIds.includes(selected) ? selected : null;
  const toggleMetric = (id: string) => setSelected(current => ((current === undefined ? firstMetric : current) === id ? null : id));
  const dimensions = useMemo(() => (data ? summarizeDimensions(data, metricIds) : []), [data, metricIds]);
  const costDimension = useMemo(() => (data ? [summarizeCost(data)] : []), [data]);
  const order = useMemo(() => levels.map(level => level.id), [levels]);
  // Undo history per chart lives here so it survives a row collapsing and
  // records chip edits made while the chart is closed.
  const histories = useLimitHistories();
  // Charts and the defaults effect all merge into the latest usage map, not
  // the one captured when their callbacks were created; otherwise a chart's
  // first onChange can overwrite defaults written for the other dimensions.
  const usageRef = useRef(usage);
  usageRef.current = usage;
  const publishUsage = (next: UsageLimitValues) => { usageRef.current = next; onUsageChange(next); };
  const changeUsage = (id: string, next: LevelValues) => publishUsage({ ...usageRef.current, [id]: next });

  // Cycle limits are seeded from the daily limits × days in the current cycle.
  const cycleDays = useMemo(() => {
    if (!data) return 30;
    const todayAt = Date.parse(`${data.today}T00:00:00Z`);
    const current = data.cycles.find(cycle => todayAt >= cycle.startsAt && todayAt < cycle.endsAt);
    return current ? Math.max(1, Math.round((current.endsAt - current.startsAt) / 86_400_000)) : 30;
  }, [data]);
  const scaleFloor = (floor?: LevelValues) => (window === "cycle" && floor ? Object.fromEntries(Object.entries(floor).map(([id, item]) => [id, item * cycleDays])) : undefined);

  // Collapsed rows show the same defaults the chart would compute, so no
  // dimension sits at "–" until it is opened.
  useEffect(() => {
    if (!data) return;
    const missing = metricIds.filter(id => order.some(levelId => !(Number.isFinite(usageRef.current[id]?.[levelId]))))
      .filter(id => window !== "cycle" || (!!usageFloor?.[id] && order.every(levelId => Number.isFinite(usageFloor[id]?.[levelId]))));
    if (!missing.length) return;
    const next = { ...usageRef.current };
    for (const id of missing) {
      const series = metricSeries(data, id);
      const fromTolerance = tolerance ? toleranceDefaults(series, data.cycles, data.today, order, tolerance, window) : undefined;
      next[id] = defaultLevelValues(series, data.cycles, data.today, order, usageRef.current[id] ?? {}, undefined, scaleFloor(usageFloor?.[id]), fromTolerance);
    }
    publishUsage(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when data or the level order changes
  }, [data, metricIds, order, usageFloor, tolerance, window]);

  if (loading) {
    return <div className="grid h-[290px] place-content-center text-[13px] text-faint"><span className="inline-flex items-center gap-2"><Spinner /> Loading usage history…</span></div>;
  }
  if (error || !data) {
    return <div className="grid h-[290px] place-content-center text-center text-[13px] text-faint">Usage history is unavailable. {error}</div>;
  }

  // Cycle limits derive from daily limits (floor and seed). Until every level
  // has a daily value, a cycle chart would default from the ladder instead
  // and then ignore the real seed, so hold the chart until the floor is whole.
  const floorReady = (floor?: LevelValues) => window !== "cycle" || (!!floor && order.every(id => Number.isFinite(floor[id])));
  const waitingNote = <div className="grid h-[120px] place-content-center text-center text-[13px] text-faint">Set the daily limits first. Billing-cycle limits start from them.</div>;
  const costHistory = costSeries(data);
  const costTolerance = tolerance ? toleranceDefaults(costHistory, data.cycles, data.today, order, tolerance, window) : undefined;
  const costReset = costTolerance ? defaultLevelValues(costHistory, data.cycles, data.today, order, {}, undefined, scaleFloor(costFloor), costTolerance) : undefined;
  const costChart = !floorReady(costFloor) ? waitingNote : (
    <LimitsChart kind="cost" unit="USD" window={window} series={costHistory} cycles={data.cycles} today={data.today}
      levels={levels} value={cost} seed={scaleFloor(costFloor)} tolerance={costTolerance} resetToTolerance={costReset}
      reference={window === "cycle" ? costFloor : undefined} onChange={onCostChange} readOnly={readOnly}
      levelEnabled={costLevelEnabled} onLevelEnabledChange={onCostLevelEnabledChange} history={histories("cost")} />
  );
  const usageChart = (id: string) => {
    if (!floorReady(usageFloor?.[id])) return waitingNote;
    const series = metricSeries(data, id);
    const fromTolerance = tolerance ? toleranceDefaults(series, data.cycles, data.today, order, tolerance, window) : undefined;
    const reset = fromTolerance ? defaultLevelValues(series, data.cycles, data.today, order, {}, undefined, scaleFloor(usageFloor?.[id]), fromTolerance) : undefined;
    return <LimitsChart key={id} kind="usage" unit={data.metrics[id]?.unit ?? ""} window={window} series={series}
      cycles={data.cycles} today={data.today} levels={levels} value={usage[id] ?? {}} seed={scaleFloor(usageFloor?.[id])}
      tolerance={fromTolerance} resetToTolerance={reset} reference={window === "cycle" ? usageFloor?.[id] : undefined}
      onChange={next => changeUsage(id, next)} readOnly={readOnly}
      levelEnabled={usageLevelEnabled?.[id]} onLevelEnabledChange={onUsageLevelEnabledChange ? next => onUsageLevelEnabledChange({ ...usageLevelEnabled, [id]: next }) : undefined}
      history={histories(id)} />;
  };
  return (
    <div className="grid gap-6">
      <section className="min-w-0">
        <ColumnHead family={family}>{window === "day" ? "Cost per day" : "Cost per billing cycle"}</ColumnHead>
        <DimensionRows dimensions={costDimension} levels={levels} values={{ cost }} selected={costOpen ? "cost" : null} onSelect={() => setCostOpen(open => !open)} renderChart={() => costChart} accent="#2f6fd6" label="Cost"
          enabled={{ cost: costEnabled }} onToggle={onCostEnabledChange && !readOnly ? (_, next) => onCostEnabledChange(next) : undefined}
          levelEnabled={{ cost: costLevelEnabled ?? {} }} window={window} cycles={data.cycles} today={data.today}
          onToggleLevel={onCostLevelEnabledChange && !readOnly ? (_, levelId, next) => onCostLevelEnabledChange({ ...costLevelEnabled, [levelId]: next }) : undefined}
          onValueChange={readOnly ? undefined : (_, levelId, next) => {
            const pushed = pushLevelValue(costHistory, data.cycles, data.today, order, cost, levelId, next, window === "cycle" ? undefined : costFloor);
            histories("cost").seed(cost);
            histories("cost").record(pushed);
            onCostChange(pushed);
          }} />
      </section>
      <section className="min-w-0">
        <ColumnHead family={family}>{window === "day" ? "Usage per day" : "Usage per billing cycle"}</ColumnHead>
        {metricIds.length ? (
          <DimensionRows dimensions={dimensions} levels={levels} values={usage} selected={metricId} onSelect={toggleMetric} renderChart={usageChart}
            enabled={usageEnabled} onToggle={onUsageEnabledChange && !readOnly ? (id, next) => onUsageEnabledChange({ ...usageEnabled, [id]: next }) : undefined}
            levelEnabled={usageLevelEnabled} window={window} cycles={data.cycles} today={data.today}
            onToggleLevel={onUsageLevelEnabledChange && !readOnly ? (id, levelId, next) => onUsageLevelEnabledChange({ ...usageLevelEnabled, [id]: { ...usageLevelEnabled?.[id], [levelId]: next } }) : undefined}
            onValueChange={readOnly ? undefined : (id, levelId, next) => {
              const current = usageRef.current[id] ?? {};
              const pushed = pushLevelValue(metricSeries(data, id), data.cycles, data.today, order, current, levelId, next, window === "cycle" ? undefined : usageFloor?.[id]);
              histories(id).seed(current);
              histories(id).record(pushed);
              changeUsage(id, pushed);
            }} />
        ) : (
          <div className="grid h-[250px] place-content-center text-[13px] text-faint">No billable usage recorded for this scope yet.</div>
        )}
      </section>
    </div>
  );
}

function ColumnHead({ family, children }: { family?: string; children: React.ReactNode }) {
  return <h4 className="mb-2 inline-flex min-h-[30px] items-center gap-2 text-[13px] font-bold">{family && <ProductIcon family={family} size="sm" />}{children}</h4>;
}
