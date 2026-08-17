import type { Dispatch, ReactNode, SetStateAction } from "react";
import { ProtectionExplainer, RuntimeAgentHandoff, RuntimeInstallGuide } from "../components/protection";
import { Icon } from "../components/ui";
import type { OnboardingBudgetEstimates, OnboardingData, Policy, SpendLimits, Threshold } from "../types";
import { AccessActions, RecentUsageEstimator } from "./access";
import { LimitEditor, LimitTable, ObjectLimitRow, TelemetryLegend } from "./limits";
import { RuntimeIntegrationMap } from "./runtime";
import { findThreshold, LIMIT_ROWS, replaceThreshold, type RuntimeIntegration } from "./model";

type SharedStepProps = {
  data: OnboardingData;
  estimates: OnboardingBudgetEstimates | null;
  policy: Policy;
  setPolicy: Dispatch<SetStateAction<Policy>>;
};

/** Every step opens with the same heading and lead paragraph. */
export function StepIntro({ title, children }: { title: string; children: ReactNode }) {
  return <>
    <h2 className="mb-2.5 text-[27px] tracking-[-.025em]">{title}</h2>
    <p className="mb-7 text-[14px] leading-[1.6] text-muted">{children}</p>
  </>;
}

/** Rule + action row that closes every step. */
export function StepActions({ children }: { children: ReactNode }) {
  return <footer className="mt-[34px] flex justify-between border-t border-line pt-[22px] max-md:flex-wrap max-md:gap-2.5">{children}</footer>;
}

export function AccessStep({ data, token, busy, result, notice, error, onVerify, onVerified }: {
  data: OnboardingData;
  token: string;
  busy: boolean;
  result: OnboardingBudgetEstimates | null;
  notice: string;
  error: string;
  onVerify: () => void;
  onVerified: (result: OnboardingBudgetEstimates) => void;
}) {
  return <>
    <StepIntro title="Confirm account access">Brolly monitors usage through Cloudflare&apos;s read-only APIs.</StepIntro>
    <AccessActions accountId={data.accountId} families={data.families} busy={busy} result={result} notice={notice} error={error} token={token} onVerify={onVerify} onVerified={onVerified} />
  </>;
}

export function AccountBudgetStep({ busy, estimates, notice, policy, setPolicy, onSuggest }: SharedStepProps & {
  busy: boolean;
  notice: string;
  onSuggest: () => void;
}) {
  return <>
    <StepIntro title="What is an unacceptable account day?">These limits apply across all monitored Cloudflare products. Warnings give you time; emergency limits create approval-ready stop actions where a safe control exists.</StepIntro>
    <RecentUsageEstimator busy={busy} result={estimates} notice={notice} onSuggest={onSuggest} />
    <LimitEditor title="Total account spend" value={policy.accountDailySpend} onChange={value => setPolicy(current => ({ ...current, accountDailySpend: value }))} />
    <div className="mt-4 flex items-center justify-between gap-[18px] rounded-panel border border-line-soft bg-panel-soft px-[18px] py-4">
      <div>
        <strong className="text-[14px]">Control mode</strong>
        <p className="mt-1 max-w-[52ch] text-[12.5px] text-muted">Automatic mode applies an installed fuse only at an emergency threshold. Recovery remains manual.</p>
      </div>
      <select
        className="min-h-10 flex-none rounded-field border border-field-line bg-field px-3 text-ink"
        value={policy.mode}
        onChange={event => setPolicy(current => ({ ...current, mode: event.target.value as Policy["mode"] }))}
      >
        <option value="observe">Observe only</option>
        <option value="approval">Require approval</option>
        <option value="automatic">Automatic emergency quarantine</option>
      </select>
    </div>
  </>;
}

export function ProductBudgetStep({ data, estimates, policy, setPolicy }: SharedStepProps) {
  return <>
    <StepIntro title="Daily spend by product">Set a limit for every billable family. Brolly saves every limit now and clearly marks products where Cloudflare exposes only some of the usage data needed for alerts.</StepIntro>
    <TelemetryLegend />
    <LimitTable
      heading="Product"
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

export function ResourceBudgetStep({ data, estimates, policy, setPolicy }: SharedStepProps) {
  const rows = data.scopedAssets.map(asset => ({
    key: asset.key,
    family: asset.family,
    label: asset.name,
    detail: `${asset.family === "workers" ? "Worker script" : "Durable Object namespace"} · ${usageDetail(asset.protection, estimates?.assets[asset.key])}`,
    connected: asset.protection === "active",
    value: policy.assetDailySpend[asset.key]!,
    onChange: (value: SpendLimits) => setPolicy(current => ({ ...current, assetDailySpend: { ...current.assetDailySpend, [asset.key]: value } })),
  }));
  return <>
    <StepIntro title="Limits for each Worker and namespace">These daily budgets override the product default for one Worker script or one Durable Object namespace. Newly discovered resources inherit their product limit until you assign an explicit budget here.</StepIntro>
    <TelemetryLegend />
    {rows.length
      ? <LimitTable heading="Resource" rows={rows} />
      : <div className="px-4 py-6 text-[13px] leading-[1.5] text-faint">No Worker scripts or Durable Object namespaces have been discovered yet. Run a scan, then reopen Budgets to assign them.</div>}
  </>;
}

export function ObjectBudgetStep({ policy, setPolicy }: Pick<SharedStepProps, "policy" | "setPolicy">) {
  return <>
    <StepIntro title="Durable Object kill-switch limits">Brolly evaluates each returned Durable Object ID independently, so one runaway object can be isolated without deleting its storage or taking an entire account offline.</StepIntro>
    <div className="overflow-hidden rounded-panel border border-line">
      {LIMIT_ROWS.map(row => <ObjectLimitRow key={`${row.metric}:${row.windowMs}`} row={row} threshold={findThreshold(policy, row.metric, row.windowMs, row.defaults)} onChange={(threshold: Threshold) => setPolicy(current => ({ ...current, thresholds: replaceThreshold(current.thresholds, threshold) }))} />)}
    </div>
    <ProtectionExplainer mode={policy.mode} />
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
