import { useMemo, useState } from "react";
import { ProductIcon, Spinner } from "../ui";
import { useUsageSeries, type UsageSeriesResponse } from "./api";
import type { LevelValues } from "./levels";
import type { LimitsChartLevel } from "./LimitsChart";
import { DimensionRows, summarizeCost, summarizeDimensions } from "./UsageDimensions";
import { useScopeWindow, type UsageLimitValues } from "./use-scope-window";

export type { UsageLimitValues } from "./use-scope-window";

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
  /** Cost column only (the whole-account scope: usage units do not sum across products). */
  costOnly?: boolean;
  /** Preloaded series for `scope`; when given, the pair does not fetch. */
  data?: UsageSeriesResponse;
  /**
   * Controlled open state, so two pairs (per day, per cycle) can open and
   * close together. `usage` is the open metric id, null for none,
   * undefined for "first". Omit for local state.
   */
  open?: { cost: boolean; usage: string | null | undefined };
  onOpenChange?(next: { cost: boolean; usage: string | null | undefined }): void;
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
export function LimitsChartPair({ token, scope, family, window, levels, cost, onCostChange, usage, onUsageChange, costFloor, usageFloor, tolerance, readOnly, usageEnabled, onUsageEnabledChange, costEnabled = true, onCostEnabledChange, costLevelEnabled, onCostLevelEnabledChange, usageLevelEnabled, onUsageLevelEnabledChange, costOnly = false, data: dataProp, open, onOpenChange }: LimitsChartPairProps) {
  const fetched = useUsageSeries(token, dataProp ? "" : scope);
  const data = dataProp ?? fetched.data;
  const loading = dataProp ? false : fetched.loading;
  const error = dataProp ? "" : fetched.error;
  const scopeWindow = useScopeWindow({ data, window, levels, cost, onCostChange, usage, onUsageChange, costFloor, usageFloor, tolerance, readOnly, costLevelEnabled, onCostLevelEnabledChange, usageLevelEnabled, onUsageLevelEnabledChange });
  const { metricIds } = scopeWindow;
  // `undefined` = nothing chosen yet (first row opens); `null` = user collapsed everything.
  const [localOpen, setLocalOpen] = useState<{ cost: boolean; usage: string | null | undefined }>({ cost: true, usage: undefined });
  const openState = open ?? localOpen;
  const setOpen = (next: { cost: boolean; usage: string | null | undefined }) => { if (onOpenChange) onOpenChange(next); else setLocalOpen(next); };
  const firstMetric = metricIds[0] ?? null;
  const metricId = openState.usage === undefined ? firstMetric : openState.usage && metricIds.includes(openState.usage) ? openState.usage : null;
  const toggleMetric = (id: string) => setOpen({ ...openState, usage: (openState.usage === undefined ? firstMetric : openState.usage) === id ? null : id });
  const dimensions = useMemo(() => (data ? summarizeDimensions(data, metricIds) : []), [data, metricIds]);
  const costDimension = useMemo(() => (data ? [summarizeCost(data)] : []), [data]);

  if (loading) {
    return <div className="grid h-[290px] place-content-center text-[13px] text-faint"><span className="inline-flex items-center gap-2"><Spinner /> Loading usage history…</span></div>;
  }
  if (error || !data) {
    return <div className="grid h-[290px] place-content-center text-center text-[13px] text-faint">Usage history is unavailable. {error}</div>;
  }

  return (
    <div className="grid gap-6">
      <section className="min-w-0">
        <ColumnHead family={family}>{window === "day" ? "Cost per day" : "Cost per billing cycle"}</ColumnHead>
        <DimensionRows dimensions={costDimension} levels={levels} values={{ cost }} selected={openState.cost ? "cost" : null} onSelect={() => setOpen({ ...openState, cost: !openState.cost })} renderChart={() => scopeWindow.costChart} accent="#2f6fd6" label="Cost"
          enabled={{ cost: costEnabled }} onToggle={onCostEnabledChange && !readOnly ? (_, next) => onCostEnabledChange(next) : undefined}
          levelEnabled={{ cost: costLevelEnabled ?? {} }} window={window} cycles={data.cycles} today={data.today}
          onToggleLevel={scopeWindow.toggleCostLevel ? (_, levelId, next) => scopeWindow.toggleCostLevel!(levelId, next) : undefined}
          onValueChange={readOnly ? undefined : (_, levelId, next) => scopeWindow.commitCost(levelId, next)} />
      </section>
      {!costOnly && (
      <section className="min-w-0">
        <ColumnHead family={family}>{window === "day" ? "Usage per day" : "Usage per billing cycle"}</ColumnHead>
        {metricIds.length ? (
          <DimensionRows dimensions={dimensions} levels={levels} values={usage} selected={metricId} onSelect={toggleMetric} renderChart={scopeWindow.usageChart}
            enabled={usageEnabled} onToggle={onUsageEnabledChange && !readOnly ? (id, next) => onUsageEnabledChange({ ...usageEnabled, [id]: next }) : undefined}
            levelEnabled={usageLevelEnabled} window={window} cycles={data.cycles} today={data.today}
            onToggleLevel={scopeWindow.toggleUsageLevel}
            onValueChange={readOnly ? undefined : scopeWindow.commitUsage} />
        ) : (
          <div className="grid h-[250px] place-content-center text-[13px] text-faint">No billable usage recorded for this scope yet.</div>
        )}
      </section>
      )}
    </div>
  );
}

function ColumnHead({ family, children }: { family?: string; children: React.ReactNode }) {
  return <h4 className="mb-2 inline-flex min-h-[30px] items-center gap-2 text-[13px] font-bold">{family && <ProductIcon family={family} size="sm" />}{children}</h4>;
}
