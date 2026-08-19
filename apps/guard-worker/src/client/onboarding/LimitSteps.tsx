import { useState, type Dispatch, type SetStateAction } from "react";
import { LimitsChartDual, levelColor } from "../components/limits-chart";
import type { AlertLevel, Policy, PolicyLimits, ScopeLimits } from "../types";
import { StepIntro } from "./BudgetSteps";
import { emptyScope, updateScope, type LimitsScope } from "./limits-policy";

type Window = keyof PolicyLimits;
type ScopeOption = LimitsScope & { label: string };

const ACCOUNT_SCOPE: ScopeOption = { key: "account", label: "Whole account", kind: "account" };

/**
 * Whole-account step: cost only (usage units do not sum across products),
 * with the daily and billing-cycle charts side by side.
 */
export function AccountLimitStep({ token, policy, levels, setPolicy }: {
  token: string;
  policy: Policy;
  levels: AlertLevel[];
  setPolicy: Dispatch<SetStateAction<Policy>>;
}) {
  const chartLevels = levels.map((level, index) => ({ id: level.id, label: level.label, color: levelColor(index, levels.length) }));
  const dayScope = policy.limits?.day?.account ?? emptyScope();
  const cycleScope = policy.limits?.cycle?.account ?? emptyScope();
  const [open, setOpen] = useState<string | null>("cost");
  const update = (window: Window, change: (scope: ScopeLimits) => ScopeLimits) => setPolicy(previous => updateScope(previous, window, ACCOUNT_SCOPE, change));
  return <>
    <StepIntro title="Global account spend limits">One dollar limit for the whole Cloudflare account per day and per billing cycle, across every product. Product limits on the next step sit under these.</StepIntro>
    <LimitsChartDual token={token} scope="account" costOnly levels={chartLevels} day={dayScope} cycle={cycleScope}
      onChange={update} tolerance={policy.riskTolerance?.percentOfTypical} open={open} onOpenChange={setOpen} />
  </>;
}
