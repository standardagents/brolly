import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { Icon, InfoTip, ProductIcon } from "../components/ui";
import { billingTokenTemplateUrl } from "../lib/billing";
import type { OnboardingBudgetEstimates, OnboardingData } from "../types";

export function AccessActions({ accountId, families, busy, result, notice, error, token, onVerify, onVerified }: {
  accountId: string;
  families: OnboardingData["families"];
  busy: boolean;
  result: OnboardingBudgetEstimates | null;
  notice: string;
  error: string;
  token: string;
  onVerify: () => void;
  onVerified: (result: OnboardingBudgetEstimates) => void;
}) {
  const [billingToken, setBillingToken] = useState("");
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingError, setBillingError] = useState("");
  const [billingSuccess, setBillingSuccess] = useState("");
  const analyticsNeedsReconnect = result ? (["workers", "durable_objects"] as const).some(key => {
    const access = result.access[key];
    return access.state === "blocked" || (access.state === "limited" && accessPermissionProblem(access.detail));
  }) : false;
  const billingNeedsToken = result ? result.access.billing.state !== "connected" : false;
  const revealed = useStaggeredReveal(busy, result);
  useInitialAccessCheck(busy, result, error, onVerify);
  const monitoringDetected = !busy && result !== null && revealed >= 1 && capabilityStatus("monitoring", result).state === "ready";
  const billingDetected = !busy && result !== null && revealed >= 2 && capabilityStatus("billing", result).state === "ready";

  async function saveBillingAccess() {
    setBillingBusy(true);
    setBillingError("");
    setBillingSuccess("");
    try {
      await api("/api/billing-access", token, { method: "PUT", body: JSON.stringify({ token: billingToken }) });
      setBillingToken("");
      const verified = await api<OnboardingBudgetEstimates>("/api/onboarding/estimates", token, { method: "POST" });
      if (verified.access.billing.state !== "connected") throw new Error(verified.access.billing.detail || "Cloudflare did not confirm Billing Read access");
      setBillingSuccess("Billing access connected.");
      onVerified(verified);
    } catch (cause) {
      setBillingError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBillingBusy(false);
    }
  }

  return (
    <div className="mb-5 grid gap-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-[var(--muted)]">
        <span>{busy ? "Checking Brolly's access…" : result ? `Checked ${new Date(result.generatedAt).toLocaleTimeString()} · read-only` : "Read-only. This check cannot change anything in your account."}</span>
        {notice && <span className="font-semibold text-[var(--good)]" role="status">{notice}</span>}
      </div>
      {error && !busy && (
        <div className="form-error flex flex-wrap items-center justify-between gap-3" role="alert">
          <span><strong>Monitoring access check failed.</strong> {error}</span>
          <button type="button" className="button primary small shrink-0" disabled={billingBusy} onClick={onVerify}><Icon name="refresh" />Try again</button>
        </div>
      )}

      {(busy || result) && <UsageAccessResults result={result} checking={busy} revealed={revealed} />}

      {(busy || result) && <ServiceCoverageGrid families={families} monitored={monitoringDetected} capped={billingDetected} />}

      {analyticsNeedsReconnect && (
        <article className="rounded-[var(--radius)] border border-[var(--warn-line)] bg-[var(--warn-bg)] p-4">
          <div className="flex items-center gap-2"><Icon name="refresh" /><strong className="text-sm">Workers and Durable Object access</strong></div>
          <p className="mt-2 max-w-[72ch] text-xs leading-5 text-[var(--muted)]">Cloudflare denied at least one Analytics permission. Reconnect the account, approve Brolly&apos;s current scopes, then run the monitoring check again. You will return to this installation.</p>
          <a className="button secondary mt-3" href="/api/auth/login"><Icon name="external" /> Reconnect Cloudflare</a>
        </article>
      )}

      {(billingNeedsToken || billingSuccess) && (
        <BillingAccessSetup
          accountId={accountId}
          token={billingToken}
          busy={billingBusy}
          error={billingError}
          success={billingSuccess}
          onToken={setBillingToken}
          onSubmit={() => void saveBillingAccess()}
        />
      )}
    </div>
  );
}

function BillingAccessSetup({ accountId, token, busy, error, success, onToken, onSubmit }: {
  accountId: string;
  token: string;
  busy: boolean;
  error: string;
  success: string;
  onToken: (value: string) => void;
  onSubmit: () => void;
}) {
  const templateUrl = billingTokenTemplateUrl(accountId);
  return (
    <section className="rounded-[var(--radius)] border border-[var(--line)] bg-[var(--panel)] p-5" aria-labelledby="billing-access-title">
      <h3 id="billing-access-title" className="m-0 text-base">Add billing access</h3>
      <p className="mt-1 max-w-[60ch] text-xs leading-5 text-[var(--muted)]">Cloudflare keeps billing behind a separate read-only token.</p>

      <ol className="mt-4 grid gap-2">
        <BillingStep index={1} label="Create a billing token in Cloudflare" hint="Cloudflare's token creation page will be pre-configured with your account values.">
          <a className="button primary w-full sm:w-auto" href={templateUrl} target="_blank" rel="noreferrer"><Icon name="external" /> Open Cloudflare</a>
        </BillingStep>

        <BillingStep index={2} label="Paste your token" hint="Cloudflare shows a new token one time. Brolly checks billing access when you save it." stacked>
          <form className="grid w-full max-w-[30rem] gap-2" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <label className="sr-only" htmlFor="billing-access-token">Billing token from Cloudflare</label>
              <input id="billing-access-token" className="min-h-10 min-w-0 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--panel)] px-3 text-sm" type="password" value={token} onChange={event => onToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="cfut_…" />
              <button type="submit" className="button primary" disabled={busy || !token.trim()}><Icon name="check" /> {busy ? "Saving…" : "Save"}</button>
            </div>
            {error && <p className="form-error" role="alert"><strong>Billing access failed.</strong> {error}</p>}
            {success && <p className="form-success" role="status">{success}</p>}
          </form>
        </BillingStep>
      </ol>
      <small className="mt-3 flex items-center gap-1.5 leading-5 text-[var(--faint)] [&_.icon]:size-3.5"><Icon name="lock" />Brolly encrypts your token inside your own installation and never shows it again.</small>
    </section>
  );
}

/**
 * Both billing steps share one number + label + hint template. Step 1 keeps
 * its single button on the right; step 2 stacks the token form under the
 * label so the input gets full width.
 */
function BillingStep({ index, label, hint, stacked, children }: { index: number; label: string; hint: string; stacked?: boolean; children: ReactNode }) {
  return (
    <li className={`grid gap-3 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--panel-soft)] p-4 ${stacked ? "grid-cols-[auto_minmax(0,1fr)]" : "sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"}`}>
      <b className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--orange-soft)] text-xs text-[var(--orange-deep)]">{index}</b>
      <div className="min-w-0">
        <strong className="block text-sm leading-5">{label}</strong>
        <span className="block text-pretty text-xs leading-4 text-[var(--muted)]">{hint}</span>
      </div>
      {stacked ? <div className="col-start-2">{children}</div> : children}
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
    <section className="mb-5 flex flex-col gap-4 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--panel-soft)] p-4 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="recent-usage-estimator-title">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--orange-soft)] text-[var(--orange-deep)] [&_.icon]:size-5"><Icon name="trend" /></span>
        <div>
          <div className="flex items-center gap-2">
            <strong id="recent-usage-estimator-title" className="text-sm">Fill limits from this account&apos;s recent usage</strong>
            <InfoTip label="How recent-usage suggestions work">Brolly makes at most two bounded Cloudflare Analytics requests for the previous rolling 24 hours, plus one billing request only when a Billing Read token is configured. Results are cached for 15 minutes. Suggestions add 25% warning, 75% critical, and 150% emergency headroom. Nothing is saved until you finish setup.</InfoTip>
          </div>
          <p className="mt-1 max-w-[62ch] text-xs leading-5 text-[var(--muted)]">Use the previous 24 hours, add safety headroom, and fill every account, product, Worker, and namespace limit Brolly can estimate. You can edit every value before saving.</p>
          {notice && <p className="mt-2 text-xs font-semibold text-[var(--good)]" role="status">{notice}</p>}
          {result && <p className="mt-1 text-[11px] text-[var(--faint)]">{result.cached ? "Reused the 15-minute cache" : `${result.apiCalls} bounded Cloudflare API ${result.apiCalls === 1 ? "request" : "requests"}`} · Window ended {new Date(result.windowEndAt).toLocaleString()}</p>}
        </div>
      </div>
      <button type="button" className="button secondary shrink-0" disabled={busy} onClick={onSuggest}><Icon name="trend" />{busy ? "Reading usage…" : result ? "Fill suggested limits" : "Read usage & fill limits"}</button>
    </section>
  );
}

/**
 * The check verifies permission surfaces, but the cards speak in what those
 * permissions let Brolly do. Monitoring is probed through the Workers and
 * Durable Objects Analytics queries (the same grant covers every cataloged
 * product); billing needs the separate Billing Read token and is the carrot —
 * it upgrades every service in the coverage grid from monitor-only to
 * monitoring plus spending caps.
 */
const ACCESS_CAPABILITIES = [
  { key: "monitoring" as const, label: "Usage monitoring", detail: "Live usage meters and alerts for every service.", icon: "pulse" as const },
  { key: "billing" as const, label: "Billing access", detail: "Daily and monthly spending caps based on invoiced dollar amounts.", icon: "wallet" as const },
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
function UsageAccessResults({ result, checking, revealed }: { result: OnboardingBudgetEstimates | null; checking: boolean; revealed: number }) {
  return (
    <div className="grid gap-2" aria-label="Verified Cloudflare permissions" aria-live="polite">
      {ACCESS_CAPABILITIES.map((row, index) => {
        const status: CapabilityStatus = !checking && result && index < revealed ? capabilityStatus(row.key, result) : { state: "checking" };
        return (
          <article
            key={row.key}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--panel)] px-4 py-3">
            <span className="grid size-9 place-items-center rounded-lg bg-[var(--panel-soft)] text-[var(--muted)] [&_.icon]:size-5"><Icon name={row.icon} /></span>
            <div className="min-w-0">
              <strong className="block text-sm leading-5">{row.label}</strong>
              <span className="block text-xs leading-4 text-[var(--muted)]">{row.detail}</span>
            </div>
            <CapabilityPill status={status} />
          </article>
        );
      })}
    </div>
  );
}

/**
 * One pill shape for every state so the right column of the cards stays the
 * same size while a check resolves. Checking uses a spinning arc, which reads
 * as "in progress" where a pulsing dot reads as a status light. Not connected
 * is neutral because billing access is optional; only a real permission
 * denial (the reconnect action) uses accent color.
 */
function CapabilityPill({ status }: { status: CapabilityStatus }) {
  const base = "inline-flex min-h-7 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-semibold leading-none [&_.icon]:size-3.5";
  if (status.state === "checking") {
    return (
      <span className={`${base} border-[var(--line)] bg-[var(--panel-soft)] text-[var(--muted)]`}>
        <i className="size-3 animate-spin rounded-full border-2 border-[var(--line)] border-t-[var(--orange)] motion-reduce:[animation-duration:2s]" aria-hidden="true" />
        Checking
      </span>
    );
  }
  const resolved = "animate-access-resolve motion-reduce:animate-none";
  if (status.state === "ready") {
    return <span className={`${base} ${resolved} border-[var(--good-line)] bg-[var(--good-bg)] text-[var(--good)]`}><Icon name="check" />{status.note}</span>;
  }
  if (status.state === "attention") {
    return <span className={`${base} ${resolved} border-[var(--line)] bg-[var(--panel)] text-[var(--muted)]`}><i className="size-2 rounded-full border-[1.5px] border-current" aria-hidden="true" />{status.note}</span>;
  }
  return <a className={`${base} ${resolved} border-[var(--line)] bg-[var(--panel)] text-[var(--blue)] hover:border-[var(--blue)]`} href={status.href}><Icon name="refresh" />{status.label}</a>;
}

/**
 * Every monitored service with a status light. Off = monitoring not yet
 * confirmed; yellow = monitor only; green = monitoring plus spending caps.
 * Lights stay off until the Usage monitoring row resolves as connected, and
 * all turn green together when Billing Read connects — the grid exists to
 * make that upgrade worth the manual token paste, so the carrot line stays
 * visible until billing is connected.
 */
// Bright status-light hues, deliberately hotter than the muted --good/--warn
// text tokens so the dots read as lights in both themes.
const LIGHT_GREEN = "bg-[#2fd05e] shadow-[0_0_6px_#2fd05e66]";
const LIGHT_YELLOW = "bg-[#ffc53d] shadow-[0_0_6px_#ffc53d66]";

function ServiceCoverageGrid({ families, monitored, capped }: { families: OnboardingData["families"]; monitored: boolean; capped: boolean }) {
  const dot = capped ? LIGHT_GREEN : monitored ? LIGHT_YELLOW : "bg-[var(--faint)] opacity-40";
  return (
    <section className="rounded-[var(--radius)] border border-[var(--line)] bg-[var(--panel)] p-4" aria-label="Service coverage">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm">Service coverage</strong>
        <span className="flex items-center gap-4 text-[11px] text-[var(--muted)]">
          <span className="flex items-center gap-1.5"><i className={`size-2 rounded-full ${LIGHT_YELLOW}`} /> Monitor only</span>
          <span className="flex items-center gap-1.5"><i className={`size-2 rounded-full ${LIGHT_GREEN}`} /> Monitoring + spending caps</span>
        </span>
      </header>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {families.map(family => (
          <span key={family.family} className="flex min-w-0 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--line-soft)] bg-[var(--panel-soft)] px-2.5 py-2">
            <i className={`size-2 flex-none rounded-full ${dot}`} />
            <span className="truncate text-xs font-semibold">{family.label}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

function accessPermissionProblem(detail: string): boolean {
  return /permission denied|access denied|forbidden|unauthorized|authentication|missing required|\b403\b/i.test(detail);
}
