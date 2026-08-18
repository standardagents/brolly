import type { Dispatch, ReactNode, SetStateAction } from "react";
import { ProtectionExplainer, RuntimeAgentHandoff, RuntimeInstallGuide } from "../components/protection";
import { Icon, Notice } from "../components/ui";
import type { AlertLevel, OnboardingBudgetEstimates, OnboardingData, Policy, SpendLimits, Threshold } from "../types";
import { AccessActions, RecentUsageEstimator } from "./access";
import { LimitEditor, LimitTable, ObjectLimitRow, TelemetryLegend } from "./limits";
import { RuntimeIntegrationMap } from "./runtime";
import { findThreshold, LIMIT_ROWS, replaceThreshold, type RuntimeIntegration } from "./model";

type SharedStepProps = {
  data: OnboardingData;
  estimates: OnboardingBudgetEstimates | null;
  policy: Policy;
  levels: AlertLevel[];
  setPolicy: Dispatch<SetStateAction<Policy>>;
};

/** Every step opens with the same heading and lead paragraph. */
export function StepIntro({ title, children }: { title: string; children?: ReactNode }) {
  return <>
    <h2 className={`text-[27px] tracking-[-.025em] ${children ? "mb-2.5" : "mb-7"}`}>{title}</h2>
    {children && <p className="mb-7 text-[14px] leading-[1.6] text-muted">{children}</p>}
  </>;
}

/** Rule + action row that closes every step. */
export function StepActions({ children }: { children: ReactNode }) {
  return <footer className="mt-6 flex justify-between max-md:flex-wrap max-md:gap-2.5">{children}</footer>;
}

export function AccessStep({ data, token, busy, result, notice, error, billingDialogOpen, onCloseBilling, onOpenBilling, onVerify, onVerified }: {
  data: OnboardingData;
  token: string;
  busy: boolean;
  result: OnboardingBudgetEstimates | null;
  notice: string;
  error: string;
  billingDialogOpen: boolean;
  onCloseBilling: () => void;
  onOpenBilling: () => void;
  onVerify: () => void;
  onVerified: (result: OnboardingBudgetEstimates) => void;
}) {
  return <>
    <StepIntro title="Confirm account access" />
    <AccessActions accountId={data.accountId} families={data.families} busy={busy} result={result} notice={notice} error={error} token={token} billingDialogOpen={billingDialogOpen} onCloseBilling={onCloseBilling} onOpenBilling={onOpenBilling} onVerify={onVerify} onVerified={onVerified} />
  </>;
}

export function AccountBudgetStep({ busy, estimates, notice, policy, levels, setPolicy, onSuggest }: SharedStepProps & {
  busy: boolean;
  notice: string;
  onSuggest: () => void;
}) {
  return <>
    <StepIntro title="Account spend">One dollar limit for the whole Cloudflare account, across every product. Product and resource limits below must stay at or under this amount.</StepIntro>
    <RecentUsageEstimator busy={busy} result={estimates} notice={notice} onSuggest={onSuggest} />
    <LimitEditor title="Total account spend" levels={levels} value={policy.accountDailySpend} onChange={value => setPolicy(current => ({ ...current, accountDailySpend: value }))} />
  </>;
}

export function ProductBudgetStep({ data, estimates, policy, levels, setPolicy }: SharedStepProps) {
  const overLimit = data.families.filter(family => exceeds(policy.familyDailySpend[family.family]!, policy.accountDailySpend, levels)).map(family => family.label);
  return <>
    <StepIntro title="Product spend and usage">Set a spend limit for each Cloudflare product. Usage limits in raw units (requests, rows, GB-s) arrive with the next configuration input. No product limit may exceed the account limit.</StepIntro>
    {overLimit.length > 0 && <Notice tone="error">These products exceed the account limit: {overLimit.join(", ")}. Lower them or raise the account limit.</Notice>}
    <TelemetryLegend />
    <LimitTable
      heading="Product"
      levels={levels}
      rows={data.families.map(family => ({
        key: family.family,
        family: family.family,
        label: family.label,
        detail: usageDetail(family.protection, estimates?.families[family.family]),
        connected: family.protection === "active",
        value: policy.familyDailySpend[family.family]!,
        onChange: value => setPolicy(current => ({ ...current, familyDailySpend: { ...current.familyDailySpend, [family.family]: value } })),
      }))}
    />
  </>;
}

export function ResourceBudgetStep({ data, estimates, policy, levels, setPolicy }: SharedStepProps) {
  const rows = data.scopedAssets.map(asset => ({
    key: asset.key,
    family: asset.family,
    label: asset.name,
    detail: `${asset.family === "workers" ? "Worker script" : "Durable Object namespace"} · ${usageDetail(asset.protection, estimates?.assets[asset.key])}`,
    connected: asset.protection === "active",
    value: policy.assetDailySpend[asset.key]!,
    onChange: (value: SpendLimits) => setPolicy(current => ({ ...current, assetDailySpend: { ...current.assetDailySpend, [asset.key]: value } })),
  }));
  const overLimit = data.scopedAssets.filter(asset => exceeds(policy.assetDailySpend[asset.key]!, policy.familyDailySpend[asset.family]!, levels)).map(asset => asset.name);
  return <>
    <StepIntro title="Resource spend and usage">Limits for any single instance of a product: no one Durable Object or Worker may spend or use more than this. Brolly evaluates each object independently, so one runaway object can be isolated without taking a product offline. No resource limit may exceed its product limit.</StepIntro>
    <div className="overflow-hidden rounded-panel border border-line">
      {LIMIT_ROWS.map(row => <ObjectLimitRow key={`${row.metric}:${row.windowMs}`} row={row} threshold={findThreshold(policy, row.metric, row.windowMs, row.defaults)} onChange={(threshold: Threshold) => setPolicy(current => ({ ...current, thresholds: replaceThreshold(current.thresholds, threshold) }))} />)}
    </div>
    <ProtectionExplainer />
    <details className="group mt-3.5 rounded-panel border border-line bg-panel">
      <summary className="cursor-pointer px-[15px] py-[13px] text-[13px] font-bold group-open:border-b group-open:border-line-soft">Override the limit for a specific Worker or namespace</summary>
      <div className="p-4">
        {overLimit.length > 0 && <Notice tone="error">These resources exceed their product limit: {overLimit.join(", ")}.</Notice>}
        <TelemetryLegend />
        {rows.length
          ? <LimitTable heading="Resource" levels={levels} rows={rows} />
          : <div className="px-4 py-6 text-[13px] leading-[1.5] text-faint">No Worker scripts or Durable Object namespaces have been discovered yet. Run a scan, then reopen Budgets to assign them.</div>}
      </div>
    </details>
  </>;
}

export function RuntimeStep({ assets, integrations, onChange }: {
  assets: OnboardingData["scopedAssets"];
  integrations: Record<string, RuntimeIntegration>;
  onChange: (values: Record<string, RuntimeIntegration>) => void;
}) {
  return <>
    <StepIntro title="Make quarantine available">Brolly can monitor and alert as soon as you finish setup. To let it quarantine a runaway Worker or one Durable Object, your application needs a tiny local runtime guard.</StepIntro>
    <div className="mb-[18px] grid grid-cols-2 gap-3 max-md:grid-cols-1">
      <article className="flex items-start gap-[11px] rounded-panel border border-good-line bg-good-bg p-3.5">
        <Icon name="check" className="mt-px size-5 flex-none text-good" />
        <div>
          <strong className="block text-[13.5px]">Monitoring and alerts are ready</strong>
          <p className="mt-[3px] text-[12.5px] leading-[1.5] text-muted">No application changes are required. You can safely finish onboarding now.</p>
        </div>
      </article>
      <article className="flex items-start gap-[11px] rounded-panel border border-line bg-panel-soft p-3.5">
        <Icon name="shield" className="mt-px size-5 flex-none text-orange-deep" />
        <div>
          <strong className="block text-[13.5px]">Quarantine needs a few code lines</strong>
          <p className="mt-[3px] text-[12.5px] leading-[1.5] text-muted">Install the runtime in each Worker you want Brolly to stop, then verify its deployment.</p>
        </div>
      </article>
    </div>
    <RuntimeAgentHandoff assets={assets} />
    <details className="group mt-3.5 rounded-panel border border-line bg-panel">
      <summary className="cursor-pointer px-[15px] py-[13px] text-[13px] font-bold group-open:border-b group-open:border-line-soft">Prefer to install it yourself?</summary>
      <p className="mx-[15px] mt-[-4px] mb-4 text-[12.5px] text-muted">Use the manual package, secret, constructor, and Worker-ingress instructions.</p>
      {/* Inside this disclosure the install guide needs its own 16px inset. */}
      <div className="p-4"><RuntimeInstallGuide /></div>
    </details>
    <RuntimeIntegrationMap assets={assets} values={integrations} onChange={onChange} />
  </>;
}

function usageDetail(protection: string, estimate?: { observedUsd: number; source: string }): string {
  if (estimate) return `$${estimate.observedUsd.toFixed(2)} in ${estimate.source === "billing" ? "latest billing day" : "prior 24 hr"}`;
  return protection === "active" ? "Usage connected" : "Limited usage data";
}

/** True when any level of `child` is above the same level of `parent`. Limits must descend: resource ≤ product ≤ account. */
function exceeds(child: SpendLimits, parent: SpendLimits, levels: AlertLevel[]): boolean {
  return levels.some(level => (child[level.id] ?? 0) > (parent[level.id] ?? 0));
}
