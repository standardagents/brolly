import { useState, type ReactNode } from "react";
import { Brand, Icon } from "../components/ui";
import type { OnboardingData } from "../types";
import {
  AccessStep,
  AccountBudgetStep,
  ObjectBudgetStep,
  ProductBudgetStep,
  ResourceBudgetStep,
  RuntimeStep,
} from "./BudgetSteps";
import { preparePolicy, prepareRuntimeIntegrations } from "./model";
import { useBudgetEstimates } from "./useBudgetEstimates";
import { useOnboardingSave } from "./useOnboardingSave";
import { useWizardNavigation } from "./useWizardNavigation";

const STEPS = [
  { label: "Verify account access", preview: "Confirm which Cloudflare usage APIs Brolly can read." },
  { label: "Account budget", preview: "One daily dollar limit for the whole account." },
  { label: "Product budgets", preview: "A daily limit for each Cloudflare product." },
  { label: "Resource budgets", preview: "A daily limit for each Worker and Durable Object namespace." },
  { label: "Per-object limits", preview: "Usage thresholds for individual Durable Objects." },
  { label: "Install shutdown fuse", preview: "Optional runtime fuse that enables emergency quarantine." },
];

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
    <main className="setup-shell">
      <header className="setup-header">
        <Brand />
        <div>{editing ? "Budget settings" : "First-run setup"}</div>
        <span className="ml-auto flex items-center gap-2">
          {onCancel && <button type="button" className="button quiet" onClick={onCancel}>Close</button>}
          <button type="button" className="button quiet" onClick={onLogout} title="Sign out of Brolly"><Icon name="logout" /> Sign out</button>
        </span>
      </header>
      <div className="setup-layout">
        <WizardSidebar editing={editing} active={navigation.active} unlocked={navigation.unlocked} onSelect={navigation.scrollToSection} />
        <div className="grid min-w-0 gap-5">
          {STEPS.map((step, index) => index > navigation.unlocked
            ? <LockedStep key={step.label} step={step} index={index} />
            : (
              <section
                key={step.label}
                ref={element => { navigation.sectionRefs.current[index] = element; }}
                className="setup-panel scroll-mt-[84px]"
              >
                <p className="eyebrow orange">Step {index + 1} of {STEPS.length}</p>
                {bodies[index]}
                {index === navigation.unlocked && index === 1 && estimates.suggestionError && <p className="form-error">{estimates.suggestionError}</p>}
                {index === navigation.unlocked && index < STEPS.length - 1 && (index !== 0 || estimates.estimates) && (
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
    <aside className="setup-steps">
      <h1>{editing ? "Tune your limits" : "Customize Brolly"}</h1>
      <ol>
        {STEPS.map((step, index) => {
          const reachable = index <= unlocked;
          return (
            <li key={step.label} className={index === active ? "active" : index < unlocked ? "done" : reachable ? "" : "locked"}>
              <button
                type="button"
                className="setup-step-button"
                disabled={!reachable}
                aria-current={index === active ? "step" : undefined}
                title={reachable ? undefined : "Unlocks when you reach this step"}
                onClick={() => onSelect(index)}
              >
                <span className="setup-step-marker">{index < unlocked ? "✓" : index + 1}</span>
                <span className="setup-step-label">{step.label}</span>
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
    <section className="flex items-center gap-3.5 rounded-xl border border-dashed border-[var(--line)] px-[22px] py-4 text-[var(--faint)]" aria-label={`${step.label} (locked)`}>
      <span className="setup-step-marker">{index + 1}</span>
      <div>
        <strong className="block text-sm text-[var(--muted)]">{step.label}</strong>
        <p className="mt-0.5 text-[12.5px] leading-normal">{step.preview}</p>
      </div>
      <span className="ml-auto flex-none [&_.icon]:size-4"><Icon name="lock" /></span>
    </section>
  );
}

function ContinueFooter({ billingConnected, busy, firstStep, onContinue }: {
  billingConnected: boolean;
  busy: boolean;
  firstStep: boolean;
  onContinue: () => void;
}) {
  const label = firstStep ? billingConnected ? "Continue to limits" : "Continue without billing access" : "Continue";
  return (
    <footer className="setup-actions">
      <span className="flex w-full flex-wrap items-center justify-between gap-4">
        {firstStep && !billingConnected && <small className="max-w-[52ch] text-left leading-5 text-[var(--muted)]"><strong className="text-[var(--ink)]">Billing API access is highly recommended.</strong> It gives Brolly exact account-wide charges and greatly improves protection for your account.</small>}
        <button type="button" className="button primary ml-auto shrink-0" disabled={busy} onClick={onContinue}>{label}</button>
      </span>
    </footer>
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
    {error && <p className="form-error">{error}</p>}
    <footer className="setup-actions">
      <span className={`runtime-finish-note ${automatic && installedCount === 0 ? "caution" : ""}`}>
        {assetCount
          ? <><strong>{installedCount} of {assetCount} resources reported installed.</strong> {installedCount ? "Verify them after deployment." : "Brolly will alert but cannot quarantine them yet."}</>
          : <><strong>No resources discovered yet.</strong> Finish in alerts-only mode, run a scan, then return here.</>}
      </span>
      <button type="button" className="button primary" disabled={busy} onClick={onSave}>{buttonLabel}</button>
    </footer>
  </>;
}
