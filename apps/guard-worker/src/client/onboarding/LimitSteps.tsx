import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { LimitsChartPair, levelColor } from "../components/limits-chart";
import type { AlertLevel, OnboardingData, Policy, PolicyLimits, ScopeLimits } from "../types";
import { StepIntro } from "./BudgetSteps";

type Window = keyof PolicyLimits;
type ScopeOption = { key: string; label: string; family?: string; kind: "account" | "family" | "asset"; legacyKey?: string };

export function LimitStep({ window, token, data, policy, levels, setPolicy }: {
  window: Window;
  token: string;
  data: OnboardingData;
  policy: Policy;
  levels: AlertLevel[];
  setPolicy: Dispatch<SetStateAction<Policy>>;
}) {
  const scopes = useMemo<ScopeOption[]>(() => [
    { key: "account", label: "Whole account", kind: "account" },
    ...data.families.map(item => ({ key: `family:${item.family}`, label: item.label, family: item.family, kind: "family" as const, legacyKey: item.family })),
    ...data.scopedAssets.map(item => ({ key: `asset:${item.key}`, label: item.name, family: item.family, kind: "asset" as const, legacyKey: item.key })),
  ], [data.families, data.scopedAssets]);
  const [selectedKey, setSelectedKey] = useState("account");
  const selected = scopes.find(scope => scope.key === selectedKey) ?? scopes[0]!;
  const current = policy.limits?.[window]?.[selected.key] ?? emptyScope();
  const daily = policy.limits?.day?.[selected.key];
  const chartLevels = levels.map((level, index) => ({ id: level.id, label: level.label, color: levelColor(index, levels.length) }));
  const update = (change: (scope: ScopeLimits) => ScopeLimits) => setPolicy(previous => updateScope(previous, window, selected, change));

  return <>
    <StepIntro title={window === "day" ? "Daily limits" : "Billing-cycle limits"}>
      {window === "day"
        ? "Set cost and billable usage limits for one calendar day. Each scope starts from its typical history and your risk tolerance."
        : "Set cost and billable usage limits for one billing cycle. Each scope starts from its daily limits and your risk tolerance."}
    </StepIntro>
    <label className="mb-5 block max-w-[420px] text-[12px] font-bold text-muted">
      Scope
      <select
        className="mt-1.5 h-10 w-full rounded-field border border-field-line bg-field px-3 text-[13px] font-semibold text-ink outline-none focus:border-orange focus:shadow-[0_0_0_3px_#f6821f1c]"
        value={selected.key}
        onChange={event => setSelectedKey(event.target.value)}
      >
        <optgroup label="Account"><option value="account">Whole account</option></optgroup>
        <optgroup label="Products">{scopes.filter(scope => scope.kind === "family").map(scope => <option key={scope.key} value={scope.key}>{scope.label}</option>)}</optgroup>
        {scopes.some(scope => scope.kind === "asset") && <optgroup label="Resources">{scopes.filter(scope => scope.kind === "asset").map(scope => <option key={scope.key} value={scope.key}>{scope.label}</option>)}</optgroup>}
      </select>
    </label>
    <LimitsChartPair
      key={`${window}:${selected.key}`}
      token={token}
      scope={selected.key}
      family={selected.family}
      window={window}
      levels={chartLevels}
      cost={current.cost}
      onCostChange={cost => update(scope => ({ ...scope, cost }))}
      usage={current.usage}
      onUsageChange={usage => update(scope => ({ ...scope, usage }))}
      costFloor={window === "cycle" ? daily?.cost : undefined}
      usageFloor={window === "cycle" ? daily?.usage : undefined}
      tolerance={policy.riskTolerance?.percentOfTypical}
      costEnabled={current.costEnabled ?? true}
      onCostEnabledChange={costEnabled => update(scope => ({ ...scope, costEnabled }))}
      usageEnabled={current.usageEnabled}
      onUsageEnabledChange={usageEnabled => update(scope => ({ ...scope, usageEnabled }))}
      costLevelEnabled={current.costLevelEnabled}
      onCostLevelEnabledChange={costLevelEnabled => update(scope => ({ ...scope, costLevelEnabled }))}
      usageLevelEnabled={current.usageLevelEnabled}
      onUsageLevelEnabledChange={usageLevelEnabled => update(scope => ({ ...scope, usageLevelEnabled }))}
    />
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
