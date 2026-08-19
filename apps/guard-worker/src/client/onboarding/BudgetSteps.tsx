import type { ReactNode } from "react";
import { RuntimeAgentHandoff, RuntimeInstallGuide } from "../components/protection";
import { Icon } from "../components/ui";
import type { OnboardingBudgetEstimates, OnboardingData } from "../types";
import { AccessActions } from "./access";
import { RuntimeIntegrationMap } from "./runtime";
import type { RuntimeIntegration } from "./model";

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

export function AccessStep({ data, token, busy, result, notice, error, billingDialogOpen, onCheckComplete, onCloseBilling, onOpenBilling, onVerify, onVerified }: {
  data: OnboardingData;
  token: string;
  busy: boolean;
  result: OnboardingBudgetEstimates | null;
  notice: string;
  error: string;
  billingDialogOpen: boolean;
  onCheckComplete: (complete: boolean) => void;
  onCloseBilling: () => void;
  onOpenBilling: () => void;
  onVerify: () => void;
  onVerified: (result: OnboardingBudgetEstimates) => void;
}) {
  return <>
    <StepIntro title="Confirm account access" />
    <AccessActions accountId={data.accountId} families={data.families} busy={busy} result={result} notice={notice} error={error} token={token} billingDialogOpen={billingDialogOpen} onCheckComplete={onCheckComplete} onCloseBilling={onCloseBilling} onOpenBilling={onOpenBilling} onVerify={onVerify} onVerified={onVerified} />
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
