import { useEffect, useRef, useState, type AnchorHTMLAttributes, type ReactNode } from "react";
import { familyControl } from "@standardagents/brolly-core";
import { api } from "../api";
import { Button, Icon, InfoTip, Input, Modal, Notice, ProductIcon, Spinner } from "../components/ui";
import { billingTokenTemplateUrl } from "../lib/billing";
import type { OnboardingBudgetEstimates, OnboardingData } from "../types";

/**
 * Anchor styled exactly like <Button>. Access setup leaves the app for
 * Cloudflare's token page and re-enters it through the OAuth login route, so
 * both actions must be real links.
 */
function ButtonLink({ variant, className = "", ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant: "primary" | "secondary" }) {
  return (
    <a
      className={`inline-flex min-h-9 cursor-pointer items-center justify-center gap-[7px] rounded-field border px-3.5 text-[13.5px] font-[620] transition-[background-color,border-color,box-shadow] duration-[130ms] [&>svg]:size-4 ${
        variant === "primary"
          ? "border-orange bg-orange text-white hover:border-orange-hover hover:bg-orange-hover"
          : "border-line-strong bg-panel text-ink hover:border-faint hover:bg-panel-soft dark:hover:bg-[#252a31]"
      } ${className}`}
      {...rest}
    />
  );
}

export function AccessActions({ accountId, families, busy, result, notice, error, token, billingDialogOpen, onCheckComplete, onCloseBilling, onOpenBilling, onVerify, onVerified }: {
  accountId: string;
  families: OnboardingData["families"];
  busy: boolean;
  result: OnboardingBudgetEstimates | null;
  notice: string;
  error: string;
  token: string;
  billingDialogOpen: boolean;
  onCheckComplete?: (complete: boolean) => void;
  onCloseBilling: () => void;
  onOpenBilling: () => void;
  onVerify: () => void;
  onVerified: (result: OnboardingBudgetEstimates) => void;
}) {
  const [billingToken, setBillingToken] = useState("");
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingError, setBillingError] = useState("");
  const analyticsNeedsReconnect = result ? (["workers", "durable_objects"] as const).some(key => {
    const access = result.access[key];
    return access.state === "blocked" || (access.state === "limited" && accessPermissionProblem(access.detail));
  }) : false;
  const revealed = useStaggeredReveal(busy, result);
  useInitialAccessCheck(busy, result, error, onVerify);
  const checkComplete = !busy && result !== null && revealed >= ACCESS_CAPABILITIES.length;
  useEffect(() => { onCheckComplete?.(checkComplete); }, [checkComplete, onCheckComplete]);
  const monitoringDetected = !busy && result !== null && revealed >= 1 && capabilityStatus("monitoring", result).state === "ready";
  const billingDetected = !busy && result !== null && revealed >= 2 && capabilityStatus("billing", result).state === "ready";

  async function saveBillingAccess() {
    setBillingBusy(true);
    setBillingError("");
    try {
      await api("/api/billing-access", token, { method: "PUT", body: JSON.stringify({ token: billingToken }) });
      setBillingToken("");
      const verified = await api<OnboardingBudgetEstimates>("/api/onboarding/estimates", token, { method: "POST" });
      if (verified.access.billing.state !== "connected") throw new Error(verified.access.billing.detail || "Cloudflare did not confirm Billing Read access");
      onVerified(verified);
      onCloseBilling();
    } catch (cause) {
      setBillingError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBillingBusy(false);
    }
  }

  function closeBillingDialog() {
    if (billingBusy) return;
    setBillingToken("");
    setBillingError("");
    onCloseBilling();
  }

  return (
    <div className="mb-5 grid gap-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-muted">
        <span>{busy ? "Checking Brolly's access…" : result ? `Checked ${new Date(result.generatedAt).toLocaleTimeString()} · read-only` : "Read-only. This check cannot change anything in your account."}</span>
        {notice && <span className="font-semibold text-good" role="status">{notice}</span>}
      </div>
      {error && !busy && (
        <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
          <span><strong>Monitoring access check failed.</strong> {error}</span>
          <Button variant="primary" size="small" className="shrink-0" disabled={billingBusy} onClick={onVerify}><Icon name="refresh" />Try again</Button>
        </Notice>
      )}

      {(busy || result) && <UsageAccessResults result={result} checking={busy} revealed={revealed} onConnectBilling={onOpenBilling} />}

      {(busy || result) && <ServiceCoverageGrid families={families} monitored={monitoringDetected} capped={billingDetected} />}

      {analyticsNeedsReconnect && (
        <article className="rounded-panel border border-warn-line bg-warn-bg p-4">
          <div className="flex items-center gap-2"><Icon name="refresh" /><strong className="text-sm">Workers and Durable Object access</strong></div>
          <p className="mt-2 max-w-[72ch] text-xs leading-5 text-muted">Cloudflare denied at least one Analytics permission. Reconnect the account, approve Brolly&apos;s current scopes, then run the monitoring check again. You will return to this installation.</p>
          <ButtonLink variant="secondary" className="mt-3" href="/api/auth/login"><Icon name="external" /> Reconnect Cloudflare</ButtonLink>
        </article>
      )}

      {billingDialogOpen && result?.access.billing.state !== "connected" && (
        <BillingAccessSetup
          accountId={accountId}
          token={billingToken}
          busy={billingBusy}
          error={billingError}
          onClose={closeBillingDialog}
          onToken={setBillingToken}
          onSubmit={() => void saveBillingAccess()}
        />
      )}
    </div>
  );
}

export function GrantBillingAccessButton({ disabled = false, onClick }: { disabled?: boolean; onClick: () => void }) {
  return <Button variant="primary" className="shrink-0" disabled={disabled} onClick={onClick}><Icon name="wallet" />Grant billing access</Button>;
}

function BillingAccessSetup({ accountId, token, busy, error, onClose, onToken, onSubmit }: {
  accountId: string;
  token: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onToken: (value: string) => void;
  onSubmit: () => void;
}) {
  const templateUrl = billingTokenTemplateUrl(accountId);
  return (
    <Modal
      labelledBy="billing-access-title"
      onClose={onClose}
      header={<div><h2 id="billing-access-title">Enable billing access</h2><p>Cloudflare keeps billing behind a separate read-only token.</p></div>}
    >
      <ol className="grid gap-2">
        <BillingStep index={1} label="Create a billing token in Cloudflare" hint="Cloudflare's token creation page will be pre-configured with your account values.">
          <ButtonLink variant="primary" href={templateUrl} target="_blank" rel="noreferrer"><Icon name="external" /> Open Cloudflare</ButtonLink>
        </BillingStep>

        <BillingStep index={2} label="Paste your token" hint="Cloudflare shows a new token one time. Brolly checks billing access when you save it.">
          <form className="grid w-full max-w-[30rem] gap-2" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <label className="sr-only" htmlFor="billing-access-token">Billing token from Cloudflare</label>
              <Input id="billing-access-token" className="min-w-0 text-sm" type="password" value={token} onChange={event => onToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="cfut_…" />
              <Button type="submit" variant="primary" className="min-w-24" disabled={busy || !token.trim()}><Icon name="check" /> {busy ? "Saving…" : "Save"}</Button>
            </div>
            {error && <Notice tone="error"><strong>Billing access failed.</strong> {error}</Notice>}
          </form>
        </BillingStep>
      </ol>
      <small className="mt-3 flex items-center gap-1.5 leading-5 text-faint"><Icon name="lock" className="size-3.5" /><span>Brolly encrypts your token inside your installation. Brolly never shows the token again.</span></small>
    </Modal>
  );
}

/**
 * Both billing steps share one template: number, then label, hint, and the
 * control stacked in one column. The controls therefore start on the same
 * left edge in both steps.
 */
function BillingStep({ index, label, hint, children }: { index: number; label: string; hint: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-3 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--panel-soft)] p-4">
      <b className="grid size-7 place-items-center self-start rounded-full bg-[var(--orange-soft)] text-xs text-[var(--orange-deep)]">{index}</b>
      <div className="min-w-0">
        <strong className="block text-sm leading-7">{label}</strong>
        <span className="block text-pretty text-xs leading-4 text-[var(--muted)]">{hint}</span>
      </div>
      <div className="col-start-2 flex">{children}</div>
    </li>
  );
}

export function RecentUsageEstimator({ busy, result, notice, onSuggest }: {
  busy: boolean;
  result: OnboardingBudgetEstimates | null;
  notice: string;
  onSuggest: () => void;
}) {
  return (
    <section className="mb-5 flex flex-col gap-4 rounded-panel border border-line bg-panel-soft p-4 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="recent-usage-estimator-title">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-orange-soft text-orange-deep"><Icon name="trend" className="size-5" /></span>
        <div>
          <div className="flex items-center gap-2">
            <strong id="recent-usage-estimator-title" className="text-sm">Fill limits from this account&apos;s recent usage</strong>
            <InfoTip label="How recent-usage suggestions work">Brolly makes at most two bounded Cloudflare Analytics requests for the previous rolling 24 hours, plus one billing request only when a Billing Read token is configured. Results are cached for 15 minutes. Suggestions add 25% warning, 75% critical, and 150% emergency headroom. Nothing is saved until you finish setup.</InfoTip>
          </div>
          <p className="mt-1 max-w-[62ch] text-xs leading-5 text-muted">Use the previous 24 hours, add safety headroom, and fill every account, product, Worker, and namespace limit Brolly can estimate. You can edit every value before saving.</p>
          {notice && <p className="mt-2 text-xs font-semibold text-good" role="status">{notice}</p>}
          {result && <p className="mt-1 text-[11px] text-faint">{result.cached ? "Reused the 15-minute cache" : `${result.apiCalls} bounded Cloudflare API ${result.apiCalls === 1 ? "request" : "requests"}`} · Window ended {new Date(result.windowEndAt).toLocaleString()}</p>}
        </div>
      </div>
      <Button className="shrink-0" disabled={busy} onClick={onSuggest}><Icon name="trend" />{busy ? "Reading usage…" : result ? "Fill suggested limits" : "Read usage & fill limits"}</Button>
    </section>
  );
}

/**
 * The check verifies permission surfaces, but the cards speak in what those
 * permissions let Brolly do. Monitoring is probed through the Workers and
 * Durable Objects Analytics queries (the same grant covers every cataloged
 * product); billing needs the separate Billing Read token and adds
 * dollar-denominated alerts for every service in the coverage grid. Neither
 * grant adds enforcement: only the families in FAMILY_CONTROLS can be
 * quarantined or paused, and that depends on the fuse and control actions,
 * not on access.
 */
const ACCESS_CAPABILITIES = [
  { key: "monitoring" as const, label: "Usage monitoring", detail: "Trigger alerts and actions based on usage quantities.", icon: "pulse" as const },
  { key: "billing" as const, label: "Billing monitoring", detail: "Trigger alerts and actions based on billable amounts.", icon: "wallet" as const },
];

type CapabilityStatus =
  | { state: "checking" }
  | { state: "ready"; note: string }
  | { state: "attention"; note: string }
  | { state: "action"; href: string; label: string };

function capabilityStatus(key: (typeof ACCESS_CAPABILITIES)[number]["key"], result: OnboardingBudgetEstimates): CapabilityStatus {
  if (key === "billing") {
    return result.access.billing.state === "connected"
      ? { state: "ready", note: "Connected" }
      : { state: "attention", note: "Not connected" };
  }
  const analyticsBlocked = (["workers", "durable_objects"] as const).some(surface => {
    const access = result.access[surface];
    return access.state === "blocked" || accessPermissionProblem(access.detail);
  });
  return analyticsBlocked
    ? { state: "action", href: "/api/auth/login", label: "Reconnect Cloudflare" }
    : { state: "ready", note: "Connected" };
}

/**
 * The first access check runs as soon as step 1 mounts. It is read-only,
 * cached for 15 minutes, and bounded to three Cloudflare requests, so there
 * is nothing for the operator to decide before it runs. Re-runs happen on
 * their own: a reconnect reloads the page, a token paste re-verifies, and an
 * error offers a retry.
 */
function useInitialAccessCheck(busy: boolean, result: OnboardingBudgetEstimates | null, error: string, onVerify: () => void) {
  const started = useRef(false);
  useEffect(() => {
    if (started.current || busy || result || error) return;
    started.current = true;
    onVerify();
  }, [busy, result, error, onVerify]);
}

// Monitoring resolves quickly; billing holds its spinner long enough that
// the operator sees it settle on its own rather than appear pre-decided.
const REVEAL_DELAYS_MS = [250, 1400];

/**
 * How many capability rows have resolved, in order, after a check finishes.
 * Owned by AccessActions so the coverage grid lights follow the same reveal
 * as the capability pills instead of jumping ahead of them.
 */
function useStaggeredReveal(checking: boolean, result: OnboardingBudgetEstimates | null): number {
  const [revealed, setRevealed] = useState(0);
  useEffect(() => {
    if (checking || !result) {
      setRevealed(0);
      return;
    }
    const timers = ACCESS_CAPABILITIES.map((_, index) => window.setTimeout(() => setRevealed(count => Math.max(count, index + 1)), REVEAL_DELAYS_MS[index]));
    return () => timers.forEach(timer => window.clearTimeout(timer));
  }, [checking, result]);
  return revealed;
}

/**
 * Permission cards. They mount with the step (the check starts on its own),
 * then resolve in place, staggered top to bottom. Every card is one full-width
 * row: icon, label + detail, status pill. The pill is vertically centered
 * against the text block, so the status column lines up across rows no
 * matter how long a detail line runs. The cards never unmount or re-animate
 * between the checking and resolved states.
 */
function UsageAccessResults({ result, checking, revealed, onConnectBilling }: {
  result: OnboardingBudgetEstimates | null;
  checking: boolean;
  revealed: number;
  onConnectBilling: () => void;
}) {
  return (
    <div className="grid gap-2 xl:grid-cols-2" aria-label="Verified Cloudflare permissions" aria-live="polite">
      {ACCESS_CAPABILITIES.map((row, index) => {
        const status: CapabilityStatus = !checking && result && index < revealed ? capabilityStatus(row.key, result) : { state: "checking" };
        return (
          <article
            key={row.key}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-panel border border-line bg-panel px-4 py-3">
            <span className="grid size-9 place-items-center rounded-lg bg-panel-soft text-muted"><Icon name={row.icon} className="size-5" /></span>
            <div className="min-w-0">
              <strong className="block text-sm leading-5">{row.label}</strong>
              <span className="block text-xs leading-4 text-muted">{row.detail}</span>
            </div>
            {row.key === "billing" && status.state === "attention"
              ? <span className="animate-access-resolve motion-reduce:animate-none"><GrantBillingAccessButton onClick={onConnectBilling} /></span>
              : <CapabilityPill status={status} />}
          </article>
        );
      })}
    </div>
  );
}

/**
 * One pill shape keeps status rows stable while checks resolve. Billing uses
 * an explicit connection action when its read-only token is unavailable.
 */
function CapabilityPill({ status }: { status: CapabilityStatus }) {
  const base = "inline-flex min-h-7 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-semibold leading-none";
  if (status.state === "checking") {
    return (
      <span className={`${base} border-line bg-panel-soft text-muted`}>
        <Spinner />
        Checking
      </span>
    );
  }
  const resolved = "animate-access-resolve motion-reduce:animate-none";
  if (status.state === "ready") {
    return <span className={`${base} ${resolved} border-good-line bg-good-bg text-good`}><Icon name="check" className="size-3.5" />{status.note}</span>;
  }
  if (status.state === "attention") {
    return <span className={`${base} ${resolved} border-line bg-panel text-muted`}><i className="size-2 rounded-full border-[1.5px] border-current" aria-hidden="true" />{status.note}</span>;
  }
  return <a className={`${base} ${resolved} border-line bg-panel text-blue hover:border-blue`} href={status.href}><Icon name="refresh" className="size-3.5" />{status.label}</a>;
}

/**
 * Every cataloged service with a status light and, where it applies, a
 * quarantine marker. The light says what Brolly can see: off until usage
 * monitoring is confirmed, yellow for usage triggers, green once billing access
 * adds dollar alerts. The shield says Brolly can quarantine the product
 * (Workers, Durable Objects, Queues). Billing access changes the lights,
 * never the markers.
 */
// Bright status-light hues, deliberately hotter than the muted --good/--warn
// text tokens so the dots read as lights in both themes.
const LIGHT_GREEN = "bg-[#2fd05e] shadow-[0_0_6px_#2fd05e66]";
const LIGHT_YELLOW = "bg-[#ffc53d] shadow-[0_0_6px_#ffc53d66]";
/** One marker for every product Brolly can quarantine (Workers, Durable Objects, Queues). */
const QUARANTINE_MARKER = { icon: "shield" as const, label: "Quarantine available" };

function ServiceCoverageGrid({ families, monitored, capped }: { families: OnboardingData["families"]; monitored: boolean; capped: boolean }) {
  const dot = capped ? LIGHT_GREEN : monitored ? LIGHT_YELLOW : "bg-faint opacity-40";
  return (
    <section className="rounded-panel border border-line bg-panel p-4" aria-label="Service coverage">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <strong className="text-sm">Service coverage</strong>
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted [&_svg]:size-3.5">
          <span className="flex items-center gap-1.5"><i className={`size-2 rounded-full ${dot}`} /> {capped ? "Usage & billing triggers" : monitored ? "Usage triggers" : "Checking"}</span>
          <span className="flex items-center gap-1.5"><Icon name={QUARANTINE_MARKER.icon} /> {QUARANTINE_MARKER.label}</span>
        </span>
      </header>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {families.map(family => {
          const control = familyControl(family.family);
          return (
            <span key={family.family} className="flex min-w-0 items-center gap-2 rounded-field border border-line-soft bg-panel-soft px-2.5 py-2">
              <ProductIcon family={family.family} size="sm" />
              <i className={`size-2 flex-none rounded-full ${dot}`} />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold">{family.label}</span>
              {control && <Icon name={QUARANTINE_MARKER.icon} className="size-3.5 flex-none text-muted" aria-label={QUARANTINE_MARKER.label} />}
            </span>
          );
        })}
      </div>
    </section>
  );
}

function accessPermissionProblem(detail: string): boolean {
  return /permission denied|access denied|forbidden|unauthorized|authentication|missing required|\b403\b/i.test(detail);
}
