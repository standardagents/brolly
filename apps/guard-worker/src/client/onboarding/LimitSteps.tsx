import type { Dispatch, SetStateAction } from "react";
import { LimitsChartPair, levelColor } from "../components/limits-chart";
import type { AlertLevel, Policy, PolicyLimits, ScopeLimits } from "../types";
import { StepIntro } from "./BudgetSteps";

type Window = keyof PolicyLimits;
type ScopeOption = { key: string; label: string; family?: string; kind: "account" | "family" | "asset"; legacyKey?: string };

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
  const update = (window: Window, change: (scope: ScopeLimits) => ScopeLimits) => setPolicy(previous => updateScope(previous, window, ACCOUNT_SCOPE, change));
  const pair = (window: Window, current: ScopeLimits) => (
    <LimitsChartPair
      key={`${window}:account`}
      token={token}
      scope="account"
      window={window}
      levels={chartLevels}
      costOnly
      cost={current.cost}
      onCostChange={cost => update(window, scope => ({ ...scope, cost }))}
      usage={{}}
      onUsageChange={() => {}}
      costFloor={window === "cycle" ? dayScope.cost : undefined}
      tolerance={policy.riskTolerance?.percentOfTypical}
      costEnabled={current.costEnabled ?? true}
      onCostEnabledChange={costEnabled => update(window, scope => ({ ...scope, costEnabled }))}
      costLevelEnabled={current.costLevelEnabled}
      onCostLevelEnabledChange={costLevelEnabled => update(window, scope => ({ ...scope, costLevelEnabled }))}
    />
  );
  return <>
    <StepIntro title="Global account spend limits">One dollar limit for the whole Cloudflare account per day and per billing cycle, across every product. Product limits on the next step sit under these.</StepIntro>
    <div className="grid grid-cols-2 gap-6 max-lg:grid-cols-1">
      {pair("day", dayScope)}
      {pair("cycle", cycleScope)}
    </div>
  </>;
}

function updateScope(policy: Policy, window: Window, selected: ScopeOption, change: (scope: ScopeLimits) => ScopeLimits): Policy {
  const limits: PolicyLimits = policy.limits
    ? { day: { ...policy.limits.day }, cycle: { ...policy.limits.cycle } }
    : { day: {}, cycle: {} };
  const next = change(limits[window][selected.key] ?? emptyScope());
  limits[window][selected.key] = next;
  const result: Policy = { ...policy, limits };
  if (window === "day") {
    if (selected.kind === "account") result.accountDailySpend = next.cost;
    if (selected.kind === "family" && selected.legacyKey) result.familyDailySpend = { ...result.familyDailySpend, [selected.legacyKey]: next.cost };
    if (selected.kind === "asset" && selected.legacyKey) result.assetDailySpend = { ...result.assetDailySpend, [selected.legacyKey]: next.cost };
  }
  return result;
}

function emptyScope(): ScopeLimits {
  return { cost: {}, usage: {} };
}
