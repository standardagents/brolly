import { useState, type ReactNode } from "react";
import { Brand, Button, Eyebrow, Icon, Notice } from "../components/ui";
import type { OnboardingData } from "../types";
import {
  AccessStep,
  AccountBudgetStep,
  ObjectBudgetStep,
  ProductBudgetStep,
  ResourceBudgetStep,
  RuntimeStep,
  StepActions,
} from "./BudgetSteps";
import { preparePolicy, prepareRuntimeIntegrations } from "./model";
import { useBudgetEstimates } from "./useBudgetEstimates";
import { useOnboardingSave } from "./useOnboardingSave";
import { useWizardNavigation } from "./useWizardNavigation";
import { ImportHistoryStep } from "./ingest";

const STEPS = [
  { label: "Confirm account access", preview: "Confirm which Cloudflare usage APIs Brolly can read." },
  { label: "Import history", preview: "Pull the last 90 days of usage and billing." },
  { label: "Account budget", preview: "One daily dollar limit for the whole account." },
  { label: "Product budgets", preview: "A daily limit for each Cloudflare product." },
  { label: "Resource budgets", preview: "A daily limit for each Worker and Durable Object namespace." },
  { label: "Per-object limits", preview: "Usage thresholds for individual Durable Objects." },
  { label: "Install shutdown fuse", preview: "Optional runtime fuse that enables emergency quarantine." },
];

/** Round step marker: filled while active, green once done, outlined otherwise. */
function StepMarker({ state = "todo", children }: { state?: "active" | "done" | "todo"; children: ReactNode }) {
  return (
    <span
      className={`grid size-[27px] flex-none place-items-center rounded-full border text-[12px] ${
        state === "active"
          ? "border-orange bg-orange text-white"
          : state === "done"
            ? "border-[#74b996] bg-good-bg dark:border-[#4a8a68]"
            : "border-[#cbd1d7] dark:border-[#505862]"
      }`}
    >
      {children}
    </span>
  );
}

export function BudgetWizard({ data, token, editing, initialStep = 0, onCancel, onLogout, onSaved }: {
  data: OnboardingData;
  token: string;
  editing: boolean;
  initialStep?: number;
  onCancel?: () => void;
  onLogout: () => void;
  onSaved: () => Promise<void>;
}) {
  const [policy, setPolicy] = useState(() => preparePolicy(data.policy, data.families.map(item => item.family), data.scopedAssets));
  const [integrations, setIntegrations] = useState(() => prepareRuntimeIntegrations(data.scopedAssets));
  const navigation = useWizardNavigation(STEPS.length, initialStep, editing);
  const estimates = useBudgetEstimates(token, policy, setPolicy);
  const save = useOnboardingSave(token, data, policy, integrations, onSaved);
  const installedCount = Object.values(integrations).filter(integration => integration.installed).length;
  const billingConnected = estimates.estimates?.access.billing.state === "connected";

  const bodies: ReactNode[] = [
    <AccessStep
      data={data}
      token={token}
      busy={estimates.busy}
      result={estimates.estimates}
      notice={estimates.accessNotice}
      error={estimates.accessError}
      onVerify={() => void estimates.verifyAccess()}
      onVerified={estimates.acceptBillingAccess}
    />,
    <ImportHistoryStep token={token} billingConnected={billingConnected} onContinue={navigation.advance} />,
    <AccountBudgetStep
      data={data}
      estimates={estimates.estimates}
      policy={policy}
      setPolicy={setPolicy}
      busy={estimates.busy}
      notice={estimates.suggestionNotice}
      onSuggest={() => void estimates.suggestLimits()}
    />,
    <ProductBudgetStep data={data} estimates={estimates.estimates} policy={policy} setPolicy={setPolicy} />,
    <ResourceBudgetStep data={data} estimates={estimates.estimates} policy={policy} setPolicy={setPolicy} />,
    <ObjectBudgetStep policy={policy} setPolicy={setPolicy} />,
    <RuntimeStep assets={data.scopedAssets} integrations={integrations} onChange={setIntegrations} />,
  ];

  return (
    <main className="min-h-screen bg-bg">
      <header className="sticky top-0 z-40 flex h-[60px] items-center gap-6 border-b border-line bg-panel px-7 font-[680] max-md:px-3.5">
        <Brand />
        <div className="border-l border-line pl-6 text-[14px] text-muted max-md:hidden">{editing ? "Budget settings" : "First-run setup"}</div>
        <span className="ml-auto flex items-center gap-2">
          {onCancel && <Button variant="quiet" onClick={onCancel}>Close</Button>}
          <Button variant="quiet" onClick={onLogout} title="Sign out of Brolly"><Icon name="logout" /> Sign out</Button>
        </span>
      </header>
      <div className="mx-auto grid max-w-[1280px] grid-cols-[340px_minmax(0,1fr)] gap-14 px-8 pt-14 pb-[100px] max-xl:grid-cols-[290px_1fr] max-xl:gap-[30px] max-xl:px-6 max-xl:pt-10 max-xl:pb-20 max-md:block max-md:px-3.5 max-md:pt-[26px] max-md:pb-[60px]">
        <WizardSidebar editing={editing} active={navigation.active} unlocked={navigation.unlocked} onSelect={navigation.scrollToSection} />
        <div className="grid min-w-0 gap-5">
          {STEPS.map((step, index) => index > navigation.unlocked
            ? <LockedStep key={step.label} step={step} index={index} />
            : (
              <section
                key={step.label}
                ref={element => { navigation.sectionRefs.current[index] = element; }}
                className="scroll-mt-[84px] rounded-[12px] border border-line bg-panel p-[clamp(26px,4vw,48px)] shadow-panel max-md:px-4 max-md:py-[22px]"
              >
                <Eyebrow tone="orange">Step {index + 1} of {STEPS.length}</Eyebrow>
                {bodies[index]}
                {index === navigation.unlocked && index === 2 && estimates.suggestionError && <Notice tone="error">{estimates.suggestionError}</Notice>}
                {index === navigation.unlocked && index < STEPS.length - 1 && index !== 1 && (index !== 0 || estimates.estimates) && (
                  <ContinueFooter
                    billingConnected={billingConnected}
                    busy={save.busy || (index === 0 && estimates.busy)}
                    firstStep={index === 0}
                    onContinue={navigation.advance}
                  />
                )}
                {index === STEPS.length - 1 && (
                  <FinishFooter
                    assetCount={data.scopedAssets.length}
                    automatic={policy.mode === "automatic"}
                    busy={save.busy}
                    editing={editing}
                    error={save.error}
                    installedCount={installedCount}
                    onSave={() => void save.save()}
                  />
                )}
              </section>
            ))}
        </div>
      </div>
    </main>
  );
}

function WizardSidebar({ editing, active, unlocked, onSelect }: {
  editing: boolean;
  active: number;
  unlocked: number;
  onSelect: (index: number) => void;
}) {
  return (
    <aside className="sticky top-24 h-max max-md:static max-md:mb-5">
      <h1 className="mt-5 mb-3.5 text-[37px] leading-[1.05] tracking-[-.035em] max-md:text-[28px]">{editing ? "Tune your limits" : "Customize Brolly"}</h1>
      <ol className="mt-[26px] list-none border-t border-line pt-[18px] max-md:mt-2 max-md:flex max-md:justify-between max-md:border-t-0 max-md:pt-2">
        {STEPS.map((step, index) => {
          const reachable = index <= unlocked;
          return (
            <li
              key={step.label}
              className={`text-[14px] font-[640] ${index === active ? "text-ink" : index < unlocked ? "text-good" : reachable ? "text-faint" : "text-faint opacity-55"}`}
            >
              <button
                type="button"
                className="group/step flex w-full cursor-pointer items-center gap-3 border-0 bg-transparent py-[9px] text-left text-[14px] font-[640] text-inherit disabled:cursor-default max-md:gap-0 max-md:py-1"
                disabled={!reachable}
                aria-current={index === active ? "step" : undefined}
                title={reachable ? undefined : "Unlocks when you reach this step"}
                onClick={() => onSelect(index)}
              >
                <StepMarker state={index === active ? "active" : index < unlocked ? "done" : "todo"}>{index < unlocked ? "✓" : index + 1}</StepMarker>
                <span className={`max-md:sr-only ${reachable ? "group-hover/step:text-ink" : ""}`}>{step.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function LockedStep({ step, index }: { step: typeof STEPS[number]; index: number }) {
  return (
    <section className="flex items-center gap-3.5 rounded-xl border border-dashed border-line px-[22px] py-4 text-faint" aria-label={`${step.label} (locked)`}>
      <StepMarker>{index + 1}</StepMarker>
      <div>
        <strong className="block text-sm text-muted">{step.label}</strong>
        <p className="mt-0.5 text-[12.5px] leading-normal">{step.preview}</p>
      </div>
      <span className="ml-auto flex-none"><Icon name="lock" className="size-4" /></span>
    </section>
  );
}

function ContinueFooter({ billingConnected, busy, firstStep, onContinue }: {
  billingConnected: boolean;
  busy: boolean;
  firstStep: boolean;
  onContinue: () => void;
}) {
  const label = firstStep ? billingConnected ? "Continue to import" : "Continue without billing access" : "Continue";
  return (
    <StepActions>
      <span className="flex w-full flex-wrap items-center justify-between gap-4">
        {firstStep && !billingConnected && <small className="max-w-[52ch] text-left leading-5 text-muted"><strong className="text-ink">Billing API access is highly recommended.</strong> It gives Brolly exact account-wide charges and greatly improves protection for your account.</small>}
        <Button variant="primary" className="ml-auto shrink-0" disabled={busy} onClick={onContinue}>{label}</Button>
      </span>
    </StepActions>
  );
}

function FinishFooter({ assetCount, automatic, busy, editing, error, installedCount, onSave }: {
  assetCount: number;
  automatic: boolean;
  busy: boolean;
  editing: boolean;
  error: string;
  installedCount: number;
  onSave: () => void;
}) {
  const buttonLabel = busy ? "Saving…" : editing ? "Save runtime status" : installedCount ? "Finish and verify installs" : "Finish setup — alerts only";
  return <>
    {error && <Notice tone="error">{error}</Notice>}
    <StepActions>
      <span className={`mx-auto max-w-[42ch] px-3.5 text-center text-[11.5px] leading-[1.45] max-md:order-first max-md:basis-full ${automatic && installedCount === 0 ? "text-warn" : "text-muted"}`}>
        {assetCount
          ? <><strong className="text-ink">{installedCount} of {assetCount} resources reported installed.</strong> {installedCount ? "Verify them after deployment." : "Brolly will alert but cannot quarantine them yet."}</>
          : <><strong className="text-ink">No resources discovered yet.</strong> Finish in alerts-only mode, run a scan, then return here.</>}
      </span>
      <Button variant="primary" disabled={busy} onClick={onSave}>{buttonLabel}</Button>
    </StepActions>
  </>;
}
