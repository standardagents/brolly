import { useState, type Dispatch, type SetStateAction } from "react";
import { LimitsChartDual, levelColor } from "../components/limits-chart";
import type { AlertLevel, PlanTier, Policy, PolicyLimits, ScopeLimits } from "../types";
import { ENTERPRISE_COST_NOTICE, ENTERPRISE_QUOTA_NOTICE, effectivePlanTier } from "../plan-tier";
import { StepIntro } from "./BudgetSteps";
import { emptyScope, updateScope, type LimitsScope } from "./limits-policy";

type Window = keyof PolicyLimits;
type ScopeOption = LimitsScope & { label: string };

const ACCOUNT_SCOPE: ScopeOption = { key: "account", label: "Whole account", kind: "account" };

/**
 * Whole-account step with cost and account-wide billable usage, shown in
 * daily and billing-cycle charts side by side.
 */
export function AccountLimitStep({ token, policy, levels, setPolicy, planTier }: {
  token: string;
  policy: Policy;
  levels: AlertLevel[];
  setPolicy: Dispatch<SetStateAction<Policy>>;
  planTier?: PlanTier;
}) {
  const chartLevels = levels.map((level, index) => ({ id: level.id, label: level.label, color: levelColor(index, levels.length) }));
  const dayScope = policy.limits?.day?.account ?? emptyScope();
  const cycleScope = policy.limits?.cycle?.account ?? emptyScope();
  const [open, setOpen] = useState<string | null>("cost");
  const update = (window: Window, change: (scope: ScopeLimits) => ScopeLimits) => setPolicy(previous => updateScope(previous, window, ACCOUNT_SCOPE, change));
  const enterprise = effectivePlanTier({ planTier }) === "enterprise";
  return <>
    <StepIntro title="Global account spend limits">One dollar limit for the whole Cloudflare account per day and per billing cycle, across every product. Product limits on the next step sit under these. The shaded included-usage band marks the paid-plan allotment. Alerts placed inside it fire before billable usage begins.</StepIntro>
    {enterprise && <div className="mb-5 rounded-field border border-line bg-panel-soft px-3 py-2.5 text-[12.5px] text-muted">{ENTERPRISE_QUOTA_NOTICE} {ENTERPRISE_COST_NOTICE}</div>}
    <LimitsChartDual token={token} scope="account" levels={chartLevels} day={dayScope} cycle={cycleScope}
      onChange={update} tolerance={policy.riskTolerance?.percentOfTypical} open={open} onOpenChange={setOpen}
      chartHeadings={{ day: "Total spend per day", cycle: "Total spend per billing cycle" }} />
  </>;
}
