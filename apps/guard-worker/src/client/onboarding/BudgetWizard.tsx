import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Brand, Button, Eyebrow, Icon, Notice, Spinner, StepMarker } from "../components/ui";
import { effectivePlanTier } from "../plan-tier";
import type { OnboardingData } from "../types";
import {
  AccessStep,
  RuntimeStep,
  StepActions,
  StepIntro,
  VerifyStep,
} from "./BudgetSteps";
import { AlertsStep } from "./alerts";
import { AlertLevelsStep, useAlertLevels } from "./levels";
import { ChartTour } from "./ChartTour";
import { RiskToleranceStep } from "./RiskToleranceStep";
import { AccountLimitStep } from "./LimitSteps";
import { ProductLimitsStep } from "./ProductLimitsStep";
import { GrantBillingAccessButton } from "./access";
import { ImportProgress } from "./ingest";
import { useNotificationTargets } from "../components/notifications";
import { preparePolicy, prepareRuntimeIntegrations } from "./model";
import { useBudgetEstimates } from "./useBudgetEstimates";
import { useOnboardingSave } from "./useOnboardingSave";
import { useWizardNavigation } from "./useWizardNavigation";

/**
 * Setup order. The first three steps establish access, alert channels, and
 * alert-level behavior. Risk tolerance seeds the daily and billing-cycle
 * charts that follow it.
 */
type Step = {
  key: "access" | "alerts" | "levels" | "tolerance" | "account" | "products" | "runtime" | "verify";
  label: string;
  /** Rail label on constrained widths; below lg the rail keeps markers only. */
  short: string;
  preview: string;
  continueLabel?: string;
};
const STEPS: readonly Step[] = [
  { key: "access", label: "Connect Cloudflare", short: "Connect", preview: "Confirm the usage and billing APIs Brolly can read." },
  { key: "alerts", label: "Alert channels", short: "Channels", preview: "Where Brolly sends alerts." },
  { key: "levels", label: "Alert levels", short: "Levels", preview: "Ordered thresholds, channels, repeat intervals, and protective actions." },
  { key: "tolerance", label: "Risk tolerance", short: "Risk", preview: "How far above typical usage each alert level starts." },
  { key: "account", label: "Account limits", short: "Account", preview: "One cost limit for the whole account, per day and per billing cycle." },
  { key: "products", label: "Product limits", short: "Products", preview: "Cost and billable usage limits for each product and resource, per day and per billing cycle." },
  { key: "runtime", label: "Install breaker", short: "Install", preview: "Optional code that lets Brolly stop a Worker or one Durable Object in an emergency.", continueLabel: "I installed the circuit breaker" },
  { key: "verify", label: "Verify breaker", short: "Verify", preview: "Brolly checks each Worker in Cloudflare for the deployed breaker." },
];
type StepKey = Step["key"];
const stepIndex = (key: StepKey) => STEPS.findIndex(step => step.key === key);


export function BudgetWizard({ data, token, editing, initialStep = 0, onCancel, onLogout, onSaved }: {
  data: OnboardingData;
  token: string;
  editing: boolean;
  initialStep?: number;
  onCancel?: () => void;
  onLogout: () => void;
  onSaved: () => Promise<void>;
}) {
  const [policy, setPolicy] = useState(() => preparePolicy(data.policy, data.families.map(item => item.family), data.scopedAssets, undefined, data.complete));
  const [integrations, setIntegrations] = useState(() => prepareRuntimeIntegrations(data.scopedAssets));
  const [billingDialogOpen, setBillingDialogOpen] = useState(false);
  const [accessCheckComplete, setAccessCheckComplete] = useState(false);
  const [breakerClaimed, setBreakerClaimed] = useState(false);
  // Risk tolerance and the limit steps chart imported history, so the wizard
  // holds at alert levels until the initial import finishes.
  const [importRunning, setImportRunning] = useState(true);
  // Chart guide card between alert levels and risk tolerance: it appears
  // when the levels step's Continue is pressed on a first-run wizard, the
  // tolerance step unlocks when it finishes or is skipped, and the card stays
  // in the flow afterwards for replay.
  const [tour, setTour] = useState<"pending" | "open" | "done">(editing ? "done" : "pending");
  const board = useAlertLevels(token);
  const targets = useNotificationTargets(token);
  const channelReady = targets.targets.length > 0;
  const navigation = useWizardNavigation(STEPS.length, initialStep, editing);
  const estimates = useBudgetEstimates(token, policy, setPolicy, board.levels, data.planTier);
  const save = useOnboardingSave(token, data, policy, integrations, editing, onSaved);
  const installedCount = Object.values(integrations).filter(integration => integration.installed).length;
  const billingConnected = estimates.estimates?.access.billing.state === "connected";
  const billingState = estimates.estimates ? billingConnected : undefined;
  const planTier = effectivePlanTier(data);
  const billingRequired = planTier !== "free" && planTier !== "enterprise";
  const billingFlow = useBillingSuccessFlow(billingState, billingRequired && !editing && navigation.unlocked === 0, navigation.advance);

  useEffect(() => {
    if (board.levels.length) setPolicy(current => preparePolicy(current, data.families.map(item => item.family), data.scopedAssets, board.levels, data.complete));
  }, [board.levels, data.families, data.scopedAssets]);

  const bodies: ReactNode[] = [
    <AccessStep
      data={data}
      token={token}
      busy={estimates.busy}
      result={estimates.estimates}
      notice={estimates.accessNotice}
      error={estimates.accessError}
      billingDialogOpen={billingDialogOpen}
      onCheckComplete={setAccessCheckComplete}
      onCloseBilling={() => setBillingDialogOpen(false)}
      onOpenBilling={() => setBillingDialogOpen(true)}
      onVerify={() => void estimates.verifyAccess()}
      onVerified={estimates.acceptBillingAccess}
    />,
    <AlertsStep token={token} targets={targets} />,
    <AlertLevelsStep token={token} targets={targets} board={board} />,
    importRunning && !editing
      ? <ImportHoldStep />
      : <RiskToleranceStep token={token} policy={policy} levels={board.levels} setPolicy={setPolicy} accountName={data.accountName ?? null} accountId={data.accountId} />,
    <AccountLimitStep token={token} policy={policy} levels={board.levels} setPolicy={setPolicy} planTier={data.planTier} />,
    <ProductLimitsStep token={token} data={data} policy={policy} levels={board.levels} setPolicy={setPolicy} />,
    <RuntimeStep assets={data.scopedAssets} />,
    <VerifyStep assets={data.scopedAssets} token={token} integrations={integrations} onChange={setIntegrations} autoRun={breakerClaimed && !editing} />,
  ];

  return (
    <main className="min-h-screen bg-bg">
      <header data-wizard-rail className="sticky top-0 z-40 grid min-h-[60px] grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-x-6 border-b border-line bg-panel px-7 font-[680] max-md:grid-cols-[1fr_auto] max-md:gap-x-3 max-md:px-3.5">
        <span className="flex items-center justify-self-start py-2.5 max-md:col-start-1 max-md:row-start-1">
          <Brand />
        </span>
        <div className="flex min-w-0 justify-center max-md:col-span-2 max-md:col-start-1 max-md:row-start-2">
          <WizardStepper active={navigation.active} unlocked={navigation.unlocked} onSelect={navigation.scrollToSection} />
        </div>
        <span className="flex flex-none items-center gap-2 justify-self-end whitespace-nowrap py-2.5 max-md:col-start-2 max-md:row-start-1">
          {onCancel && <Button variant="quiet" onClick={onCancel}>Close</Button>}
          <Button variant="quiet" onClick={onLogout} title="Sign out of Brolly"><Icon name="logout" /> Sign out</Button>
        </span>
      </header>
      <div className="mx-auto max-w-[1440px] px-8 pt-8 pb-[100px] max-xl:px-6 max-xl:pb-20 max-md:px-3.5 max-md:pt-4 max-md:pb-[60px]">
        <div className="grid min-w-0 gap-5">
          {STEPS.map((step, index) => <Fragment key={step.label}>
            {step.key === "tolerance" && (tour === "pending"
              ? <LockedGuideCard />
              : <ChartTour levels={board.levels} policy={policy} done={tour === "done"}
                  onDone={() => { setTour("done"); navigation.advance(); }} />
            )}
            {index > navigation.unlocked
            ? <LockedStep step={step} index={index} />
            : (
              <section
                ref={element => { navigation.sectionRefs.current[index] = element; }}
                className="min-w-0 scroll-mt-[76px] rounded-[12px] border border-line bg-panel p-[clamp(26px,4vw,48px)] shadow-panel max-md:scroll-mt-[116px] max-md:px-4 max-md:py-[22px]"
              >
                <Eyebrow tone="orange">Step {index + 1} of {STEPS.length}</Eyebrow>
                {bodies[index]}
                {index === navigation.unlocked && index === stepIndex("products") && estimates.suggestionError && <Notice tone="error">{estimates.suggestionError}</Notice>}
                {index === navigation.unlocked && index < STEPS.length - 1 && (index !== 0 || estimates.estimates) && (
                  <ContinueFooter
                    billingConnected={billingConnected}
                    billingRequired={billingRequired}
                    planTier={planTier}
                    busy={save.busy || (index === 0 && estimates.busy)}
                    blocked={
                      index === stepIndex("alerts") && !channelReady ? "Add at least one alert channel to continue."
                      : index === stepIndex("tolerance") && importRunning && !editing ? "This step opens when the account history import finishes."
                      : ""
                    }
                    firstStep={index === 0}
                    billingFlow={billingFlow}
                    label={step.continueLabel}
                    accessCheckComplete={accessCheckComplete}
                    onOpenBilling={() => setBillingDialogOpen(true)}
                    onContinue={() => {
                      if (step.key === "runtime") setBreakerClaimed(true);
                      if (step.key === "levels" && tour !== "done") {
                        setTour("open");
                        if (tour === "open") document.querySelector("[data-chart-tour]")?.scrollIntoView({ behavior: "smooth", block: "start" });
                        return;
                      }
                      navigation.advance();
                    }}
                  />
                )}
                {index === STEPS.length - 1 && (
                  <FinishFooter
                    assetCount={data.scopedAssets.length}
                    busy={save.busy}
                    editing={editing}
                    error={save.error}
                    installedCount={installedCount}
                    onSave={() => void save.save()}
                  />
                )}
              </section>
            )}
          </Fragment>)}
        </div>
      </div>
      {navigation.unlocked >= 1 && <ImportProgress token={token} billingConnected={billingConnected} onRunningChange={setImportRunning} />}
    </main>
  );
}

/**
 * Horizontal step rail, centered inside the single header row. Full labels
 * show on wide screens, one-word labels below `xl`, markers only below `lg`,
 * and below `md` the markers wrap onto their own second header row.
 */
function WizardStepper({ active, unlocked, onSelect }: {
  active: number;
  unlocked: number;
  onSelect: (index: number) => void;
}) {
  const listRef = useRef<HTMLOListElement>(null);

  // When the rail overflows, keep the active step centered as the page scrolls.
  useEffect(() => {
    const list = listRef.current;
    const item = list?.children[active] as HTMLElement | undefined;
    if (!list || !item || list.scrollWidth <= list.clientWidth) return;
    list.scrollTo({ left: item.offsetLeft - (list.clientWidth - item.offsetWidth) / 2, behavior: "smooth" });
  }, [active]);

  return (
    <ol ref={listRef} className="flex max-w-full list-none items-center gap-1 overflow-x-auto py-2 max-md:flex-wrap max-md:justify-center max-md:gap-1.5 max-md:overflow-visible max-md:py-1.5">
      {STEPS.map((step, index) => {
        const reachable = index <= unlocked;
        return (
          <li key={step.label} data-step={step.key} className={`flex items-center text-[13px] font-[640] ${index === active ? "text-ink" : index < unlocked ? "text-good" : reachable ? "text-faint" : "text-faint opacity-55"}`}>
            {index > 0 && <span className="mx-1 h-px w-3 bg-line max-xl:hidden" aria-hidden="true" />}
            <button
              type="button"
              className="group/step flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-field border-0 bg-transparent px-1.5 py-1 text-left text-inherit hover:bg-panel-soft disabled:cursor-default disabled:hover:bg-transparent"
              disabled={!reachable}
              aria-current={index === active ? "step" : undefined}
              title={reachable ? step.label : "Unlocks when you reach this step"}
              onClick={() => onSelect(index)}
            >
              <StepMarker className="max-xl:size-[22px] max-xl:text-[11px]" state={index === active ? "active" : index < unlocked ? "done" : "todo"}>{index < unlocked ? "✓" : index + 1}</StepMarker>
              <span className={`max-xl:sr-only ${reachable ? "group-hover/step:text-ink" : ""}`}>{step.short}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Step 4 body while the account history import runs: tolerance charts real usage, so the step holds until the data exists. */
function ImportHoldStep() {
  return <>
    <StepIntro title="Risk tolerance">
      Set how far above your usual daily spend each alert level starts.
    </StepIntro>
    <div className="grid justify-items-center gap-3 rounded-panel border border-dashed border-line px-6 py-14 text-center">
      <Spinner />
      <strong className="text-[14px] text-ink">Importing your account history…</strong>
      <p className="max-w-[46ch] text-[12.5px] leading-normal text-muted">Risk tolerance is set against your real usage. This step opens when the import finishes.</p>
    </div>
  </>;
}

function LockedCard({ marker, title, preview, label }: { marker: ReactNode; title: string; preview: string; label: string }) {
  return (
    <section className="flex items-center gap-3.5 rounded-xl border border-dashed border-line px-[22px] py-4 text-faint" aria-label={`${label} (locked)`}>
      <StepMarker>{marker}</StepMarker>
      <div>
        <strong className="block text-sm text-muted">{title}</strong>
        <p className="mt-0.5 text-[12.5px] leading-normal">{preview}</p>
      </div>
      <span className="ml-auto flex-none"><Icon name="lock" className="size-4" /></span>
    </section>
  );
}

function LockedStep({ step, index }: { step: typeof STEPS[number]; index: number }) {
  return <LockedCard marker={index + 1} title={step.label} preview={step.preview} label={step.label} />;
}

/**
 * Stand-in card for the guide before it opens, so the flow shows where it will
 * appear. The guide stays out of the header step rail on purpose: it is an
 * unnumbered card between steps 3 and 4.
 */
function LockedGuideCard() {
  return <LockedCard marker={<Icon name="sliders" className="size-3.5" />} title="How to use Brolly" preview="A guided tour of the charts and controls the next steps use." label="How to use Brolly" />;
}

type BillingFlow = "idle" | "settling" | "done";

/**
 * Post-connect choreography for step 1: hold a checking state long enough for
 * the coverage board to turn green, show a quiet success label, then advance
 * to the next step on its own. It runs only when billing moves from a known
 * not-connected result to connected, never when a page load discovers billing
 * that was already connected.
 */
function useBillingSuccessFlow(connected: boolean | undefined, active: boolean, advance: () => void): BillingFlow {
  const [flow, setFlow] = useState<BillingFlow>("idle");
  const wasConnected = useRef(connected);
  useEffect(() => {
    const was = wasConnected.current;
    wasConnected.current = connected;
    if (connected !== true || was !== false || !active) return;
    setFlow("settling");
    const settle = setTimeout(() => setFlow("done"), 1600);
    const next = setTimeout(advance, 2800);
    return () => { clearTimeout(settle); clearTimeout(next); };
  }, [connected, active, advance]);
  return flow;
}

export function ContinueFooter({ accessCheckComplete = true, billingConnected, billingRequired = true, planTier = "unknown", billingFlow = "idle", blocked = "", busy, firstStep, label, onContinue, onOpenBilling }: {
  accessCheckComplete?: boolean;
  billingConnected: boolean;
  billingRequired?: boolean;
  planTier?: OnboardingData["planTier"];
  billingFlow?: BillingFlow;
  blocked?: string;
  busy: boolean;
  firstStep: boolean;
  label?: string;
  onContinue: () => void;
  onOpenBilling: () => void;
}) {
  if (firstStep && billingRequired && !billingConnected) {
    return (
      <StepActions>
        <span className="flex w-full flex-col items-end gap-1.5">
          <GrantBillingAccessButton disabled={busy || !accessCheckComplete} onClick={onOpenBilling} />
          <small className="text-[12px] text-muted">{planTier === "unknown" ? "Billing Read is required to identify this account's plan and continue." : "Read-only billing access is required to continue."}</small>
        </span>
      </StepActions>
    );
  }

  if (firstStep && billingFlow !== "idle") {
    return (
      <StepActions>
        <span className="flex w-full justify-end">
          {billingFlow === "settling"
            ? <Button variant="secondary" disabled><Spinner /> Checking billing access…</Button>
            : <span className="inline-flex min-h-9 items-center gap-[7px] rounded-field border border-good-line px-3.5 text-[13.5px] font-[620] text-good"><Icon name="check" className="size-4" /> Billing access enabled</span>}
        </span>
      </StepActions>
    );
  }

  return (
    <StepActions>
      <span className="flex w-full flex-col items-end gap-1.5">
        <Button variant="primary" className="shrink-0" disabled={busy || (firstStep && !accessCheckComplete) || Boolean(blocked)} title={blocked || undefined} onClick={onContinue}>{label ?? (firstStep ? "Continue to alerts" : "Continue")}</Button>
        {blocked && <small className="text-[12px] text-muted">{blocked}</small>}
        {firstStep && !billingRequired && <small className="max-w-[48ch] text-right text-[12px] text-muted">{planTier === "free" ? "Free plans have hard usage caps, so Brolly continues with usage monitoring." : "Enterprise billing reconciliation is unavailable, so Brolly continues with usage monitoring."}</small>}
      </span>
    </StepActions>
  );
}

function FinishFooter({ assetCount, busy, editing, error, installedCount, onSave }: {
  assetCount: number;
  busy: boolean;
  editing: boolean;
  error: string;
  installedCount: number;
  onSave: () => void;
}) {
  const buttonLabel = busy ? "Saving…" : editing ? "Save breaker status" : installedCount ? "Finish setup" : "Finish alerts-only setup";
  return <>
    {error && <Notice tone="error">{error}</Notice>}
    <StepActions>
      <span className="mx-auto max-w-[42ch] px-3.5 text-center text-[11.5px] leading-[1.45] text-muted max-md:order-first max-md:basis-full">
        {assetCount
          ? <><strong className="text-ink">{installedCount} of {assetCount} resources verified.</strong> {installedCount ? "Quarantine is ready for them." : "Brolly will alert but cannot stop them yet."}</>
          : <><strong className="text-ink">No resources discovered yet.</strong> Finish in alerts-only mode, run a scan, then return here.</>}
      </span>
      <Button variant="primary" data-action="finish" disabled={busy} onClick={onSave}>{buttonLabel}</Button>
    </StepActions>
  </>;
}
