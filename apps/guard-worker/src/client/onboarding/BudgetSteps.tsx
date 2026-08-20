import type { ReactNode } from "react";
import { RuntimeAgentHandoff, RuntimeInstallGuide } from "../components/protection";
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

export function RuntimeStep({ assets }: {
  assets: OnboardingData["scopedAssets"];
}) {
  return <>
    <StepIntro title="Install the circuit breaker">This step is optional; alerts work without it. The circuit breaker is a few lines of code that let Brolly stop a runaway Worker or one Durable Object.</StepIntro>
    <RuntimeAgentHandoff assets={assets} />
    <details className="group mt-5 rounded-panel border border-line bg-panel">
      <summary className="cursor-pointer px-[15px] py-[13px] text-[13px] font-bold group-open:border-b group-open:border-line-soft">Prefer to install it yourself?</summary>
      {/* Inside this disclosure the install guide needs its own 16px inset. */}
      <div className="p-4"><RuntimeInstallGuide /></div>
    </details>
  </>;
}

export function VerifyStep({ assets, token, integrations, onChange, autoRun }: {
  assets: OnboardingData["scopedAssets"];
  token: string;
  integrations: Record<string, RuntimeIntegration>;
  onChange: (values: Record<string, RuntimeIntegration>) => void;
  autoRun: boolean;
}) {
  return <>
    <StepIntro title="Verify the circuit breaker">Brolly checks each Worker in Cloudflare for the deployed breaker and its secret.</StepIntro>
    <RuntimeIntegrationMap assets={assets} token={token} values={integrations} onChange={onChange} autoRun={autoRun} />
  </>;
}
