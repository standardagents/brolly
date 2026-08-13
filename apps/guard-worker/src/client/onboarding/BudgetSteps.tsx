import type { Dispatch, SetStateAction } from "react";
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
    <h2>Verify account access</h2>
    <p className="section-copy">Brolly monitors usage through Cloudflare&apos;s read-only APIs. Confirm it has access.</p>
    <AccessActions accountId={data.accountId} families={data.families} busy={busy} result={result} notice={notice} error={error} token={token} onVerify={onVerify} onVerified={onVerified} />
  </>;
}

export function AccountBudgetStep({ busy, estimates, notice, policy, setPolicy, onSuggest }: SharedStepProps & {
  busy: boolean;
  notice: string;
  onSuggest: () => void;
}) {
  return <>
    <h2>What is an unacceptable account day?</h2>
    <p className="section-copy">These limits apply across all monitored Cloudflare products. Warnings give you time; emergency limits create approval-ready stop actions where a safe control exists.</p>
    <RecentUsageEstimator busy={busy} result={estimates} notice={notice} onSuggest={onSuggest} />
    <LimitEditor title="Total account spend" value={policy.accountDailySpend} onChange={value => setPolicy(current => ({ ...current, accountDailySpend: value }))} />
    <div className="mode-card">
      <div><strong>Control mode</strong><p>Automatic mode applies an installed fuse only at an emergency threshold. Recovery remains manual.</p></div>
      <select value={policy.mode} onChange={event => setPolicy(current => ({ ...current, mode: event.target.value as Policy["mode"] }))}>
        <option value="observe">Observe only</option>
        <option value="approval">Require approval</option>
        <option value="automatic">Automatic emergency quarantine</option>
      </select>
    </div>
  </>;
}

export function ProductBudgetStep({ data, estimates, policy, setPolicy }: SharedStepProps) {
  return <>
    <h2>Daily spend by product</h2>
    <p className="section-copy">Set a limit for every billable family. Brolly saves every limit now and clearly marks products where Cloudflare exposes only some of the usage data needed for alerts.</p>
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
    <h2>Limits for each Worker and namespace</h2>
    <p className="section-copy">These daily budgets override the product default for one Worker script or one Durable Object namespace. Newly discovered resources inherit their product limit until you assign an explicit budget here.</p>
    <TelemetryLegend />
    {rows.length
      ? <LimitTable heading="Resource" rows={rows} />
      : <div className="empty-small">No Worker scripts or Durable Object namespaces have been discovered yet. Run a scan, then reopen Budgets to assign them.</div>}
  </>;
}

export function ObjectBudgetStep({ policy, setPolicy }: Pick<SharedStepProps, "policy" | "setPolicy">) {
  return <>
    <h2>Durable Object kill-switch limits</h2>
    <p className="section-copy">Brolly evaluates each returned Durable Object ID independently, so one runaway object can be isolated without deleting its storage or taking an entire account offline.</p>
    <div className="object-limits">
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
    <h2>Make quarantine available</h2>
    <p className="section-copy">Brolly can monitor and alert as soon as you finish setup. To let it quarantine a runaway Worker or one Durable Object, your application needs a tiny local runtime guard.</p>
    <div className="runtime-readiness">
      <article className="ready"><Icon name="check" /><div><strong>Monitoring and alerts are ready</strong><p>No application changes are required. You can safely finish onboarding now.</p></div></article>
      <article><Icon name="shield" /><div><strong>Quarantine needs a few code lines</strong><p>Install the runtime in each Worker you want Brolly to stop, then verify its deployment.</p></div></article>
    </div>
    <RuntimeAgentHandoff assets={assets} />
    <details className="manual-runtime-guide"><summary>Prefer to install it yourself?</summary><p>Use the manual package, secret, constructor, and Worker-ingress instructions.</p><RuntimeInstallGuide /></details>
    <RuntimeIntegrationMap assets={assets} values={integrations} onChange={onChange} />
  </>;
}

function usageDetail(protection: string, estimate?: { observedUsd: number; source: string }): string {
  if (estimate) return `$${estimate.observedUsd.toFixed(2)} in ${estimate.source === "billing" ? "latest billing day" : "prior 24 hr"}`;
  return protection === "active" ? "Usage connected" : "Limited usage data";
}
