import { useState, type Dispatch, type SetStateAction } from "react";
import { LimitsChartDual, levelColor } from "../components/limits-chart";
import { useUsageSeries, type UsageSeriesState } from "../components/limits-chart/api";
import { Spinner } from "../components/ui";
import type { AlertLevel, PlanTier, Policy, PolicyLimits, ScopeLimits } from "../types";
import { ENTERPRISE_COST_NOTICE, effectivePlanTier } from "../plan-tier";
import { StepIntro } from "./BudgetSteps";
import { emptyScope, updateScope, type LimitsScope } from "./limits-policy";

type Window = keyof PolicyLimits;
type ScopeOption = LimitsScope & { label: string };

const ACCOUNT_SCOPE: ScopeOption = { key: "account", label: "Whole account", kind: "account" };

/**
 * Whole-account step with cost limits shown in daily and billing-cycle charts
 * side by side.
 */
export function AccountLimitStep({ token, policy, levels, setPolicy, planTier, usage: sharedUsage }: {
  token: string;
  policy: Policy;
  levels: AlertLevel[];
  setPolicy: Dispatch<SetStateAction<Policy>>;
  planTier?: PlanTier;
  usage?: UsageSeriesState;
}) {
  const fetchedUsage = useUsageSeries(token, "account", !sharedUsage);
  const usage = sharedUsage ?? fetchedUsage;
  const chartLevels = levels.map((level, index) => ({ id: level.id, label: level.label, color: levelColor(index, levels.length) }));
  const dayScope = policy.limits?.day?.account ?? emptyScope();
  const cycleScope = policy.limits?.cycle?.account ?? emptyScope();
  const [open, setOpen] = useState<string | null>("cost");
  const update = (window: Window, change: (scope: ScopeLimits) => ScopeLimits) => setPolicy(previous => updateScope(previous, window, ACCOUNT_SCOPE, change));
  const enterprise = effectivePlanTier({ planTier }) === "enterprise";
  return <>
    <StepIntro title="Global account spend limits">One dollar spend limit for the whole Cloudflare account per day and per billing cycle, across every product. Product limits on the next step sit under this account spend limit.</StepIntro>
    {enterprise && <div className="mb-5 rounded-field border border-line bg-panel-soft px-3 py-2.5 text-[12.5px] text-muted">{ENTERPRISE_COST_NOTICE}</div>}
    {usage.loading && <div className="grid h-[200px] place-content-center text-[13px] text-faint"><span className="inline-flex items-center gap-2"><Spinner /> Loading usage history…</span></div>}
    {!usage.loading && !usage.data && <div className="grid h-[200px] place-content-center text-center text-[13px] text-faint">Usage history is unavailable. {usage.error}</div>}
    {usage.data && <LimitsChartDual data={usage.data} levels={chartLevels} day={dayScope} cycle={cycleScope}
      onChange={update} tolerance={policy.riskTolerance?.percentOfTypical} open={open} onOpenChange={setOpen}
      costOnly headerless
      chartHeadings={{ day: "Total spend per day", cycle: "Total spend per billing cycle" }} />}
  </>;
}
