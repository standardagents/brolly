import { useEffect, useState, type ReactNode } from "react";
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
      <section className="flex flex-col gap-4 rounded-[var(--radius)] border border-[var(--good-line)] bg-[var(--good-bg)] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--panel)] text-[var(--good)] [&_.icon]:size-5"><Icon name="shield" /></span>
          <div>
            <div className="flex items-center gap-2"><strong className="text-sm">Check Brolly&apos;s access</strong><InfoTip label="How Brolly checks access">Brolly makes at most two read-only Analytics requests and one billing request only when Billing Read is configured. Results are cached for 15 minutes. This check never changes limits or Cloudflare resources.</InfoTip></div>
            <p className="mt-1 max-w-[64ch] text-xs leading-5 text-[var(--muted)]">
              {result && !busy ? `Checked ${new Date(result.generatedAt).toLocaleTimeString()}` : "Read-only. This check cannot change anything in your account."}
            </p>
            {notice && <p className="mt-2 text-xs font-semibold text-[var(--good)]" role="status">{notice}</p>}
          </div>
        </div>
        <button type="button" className="button primary shrink-0" disabled={busy || billingBusy} onClick={onVerify}><Icon name="radar" />{busy ? "Checking…" : result ? "Check again" : "Check monitoring access"}</button>
        {error && <p className="form-error basis-full" role="alert"><strong>Monitoring access check failed.</strong> {error}</p>}
      </section>

      {(busy || result) && <UsageAccessResults result={result} checking={busy} />}

      {(busy || result) && <ServiceCoverageGrid families={families} checking={busy} capped={result?.access.billing.state === "connected"} />}

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
    <section className="rounded-[var(--radius)] border border-[var(--warn-line)] bg-[var(--panel)] p-5" aria-labelledby="billing-access-title">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--warn-bg)] text-[var(--warn)] [&_.icon]:size-5"><Icon name="wallet" /></span>
        <div>
          <p className="eyebrow">Missing permission</p>
          <h3 id="billing-access-title" className="m-0 text-base">Add billing access</h3>
          <p className="mt-1 max-w-[60ch] text-xs leading-5 text-[var(--muted)]">Cloudflare keeps billing behind a separate read-only token.</p>
        </div>
      </div>

      <ol className="mt-4 grid gap-2">
        <BillingStep index={1} label="Create the token in Cloudflare">
          <a className="button primary w-full sm:w-auto" href={templateUrl} target="_blank" rel="noreferrer"><Icon name="external" /> Create billing token</a>
        </BillingStep>

        <BillingStep index={2} label="Paste the token here">
          <form className="grid w-full gap-2 sm:w-[26rem]" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <label className="sr-only" htmlFor="billing-access-token">Paste the token Cloudflare shows</label>
              <input id="billing-access-token" className="min-h-10 min-w-0 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--panel)] px-3 text-sm" type="password" value={token} onChange={event => onToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="cfut_…" />
              <button type="submit" className="button primary" disabled={busy || !token.trim()}><Icon name="check" /> {busy ? "Verifying…" : "Verify and save"}</button>
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
 * Both billing steps share one row template so the numbers, the step labels,
 * and the right-hand controls line up column for column across the steps.
 */
function BillingStep({ index, label, children }: { index: number; label: string; children: ReactNode }) {
  return (
    <li className="grid gap-3 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--panel-soft)] p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
      <b className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--orange-soft)] text-xs text-[var(--orange-deep)]">{index}</b>
      <strong className="text-sm">{label}</strong>
      {children}
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
  { key: "billing" as const, label: "Billing access", detail: "Enables daily and monthly spending caps based on actual invoiced dollar amounts.", icon: "wallet" as const },
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
 * Permission cards that animate in once when the check starts and then
 * resolve in place — the pulsing dot flips to a status, staggered left to
 * right. The cards themselves never unmount or re-animate between the
 * checking and resolved states.
 */
function UsageAccessResults({ result, checking }: { result: OnboardingBudgetEstimates | null; checking: boolean }) {
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    if (checking || !result) {
      setRevealed(0);
      return;
    }
    const timers = ACCESS_CAPABILITIES.map((_, index) => window.setTimeout(() => setRevealed(count => Math.max(count, index + 1)), 200 + index * 180));
    return () => timers.forEach(timer => window.clearTimeout(timer));
  }, [checking, result]);

  return (
    <div className="grid gap-3 sm:grid-cols-2" aria-label="Verified Cloudflare permissions" aria-live="polite">
      {ACCESS_CAPABILITIES.map((row, index) => {
        const status: CapabilityStatus = !checking && result && index < revealed ? capabilityStatus(row.key, result) : { state: "checking" };
        const badge = status.state === "ready" ? { icon: "check" as const, tone: "bg-[var(--good-bg)] text-[var(--good)]" }
          : status.state === "action" || status.state === "attention" ? { icon: "alert" as const, tone: "bg-[var(--warn-bg)] text-[var(--warn)]" }
            : null;
        return (
          <article
            key={row.key}
            className="flex flex-col gap-2.5 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--panel)] p-4 [animation:access-reveal_.4s_cubic-bezier(.2,.7,.3,1)_both] motion-reduce:animate-none"
            style={{ animationDelay: `${index * 90}ms` }}
          >
            <header className="flex items-start justify-between">
              <span className="grid size-[34px] flex-none place-items-center rounded-[7px] bg-[var(--panel-soft)] text-[var(--muted)] [&_.icon]:size-[19px]"><Icon name={row.icon} /></span>
              {badge ? (
                <span className={`grid size-[22px] flex-none place-items-center rounded-full [animation:access-resolve_.3s_cubic-bezier(.2,.7,.3,1)_both] motion-reduce:animate-none [&_.icon]:size-[13px] ${badge.tone}`}>
                  <Icon name={badge.icon} />
                </span>
              ) : (
                <span className="grid size-[22px] flex-none place-items-center">
                  <i className="size-2 rounded-full bg-[var(--orange)] [animation:access-pulse_1s_ease-in-out_infinite] motion-reduce:[animation-duration:2.4s]" style={{ animationDelay: `${index * 160}ms` }} />
                </span>
              )}
            </header>
            <div>
              <strong className="block text-sm leading-none">{row.label}</strong>
              <span className="mt-1 block text-xs leading-4 text-[var(--faint)]">{row.detail}</span>
            </div>
            {status.state === "checking" && <span className="text-xs text-[var(--faint)]">Checking…</span>}
            {status.state === "ready" && <span className="text-xs font-semibold text-[var(--good)]">{status.note}</span>}
            {status.state === "attention" && <span className="text-xs font-semibold text-[var(--warn)]">{status.note}</span>}
            {status.state === "action" && <a className="text-xs font-bold text-[var(--blue)] hover:underline" href={status.href}>{status.label} →</a>}
          </article>
        );
      })}
    </div>
  );
}

/**
 * Every monitored service with a status light. Yellow = monitor only; green =
 * monitoring plus spending caps. All lights turn green together when Billing
 * Read connects — the grid exists to make that upgrade worth the manual token
 * paste, so the carrot line stays visible until billing is connected.
 */
// Bright status-light hues, deliberately hotter than the muted --good/--warn
// text tokens so the dots read as lights in both themes.
const LIGHT_GREEN = "bg-[#2fd05e] shadow-[0_0_6px_#2fd05e66]";
const LIGHT_YELLOW = "bg-[#ffc53d] shadow-[0_0_6px_#ffc53d66]";

function ServiceCoverageGrid({ families, checking, capped }: { families: OnboardingData["families"]; checking: boolean; capped?: boolean }) {
  const dot = checking ? "bg-[var(--faint)] opacity-40" : capped ? LIGHT_GREEN : LIGHT_YELLOW;
  return (
    <section className="rounded-[var(--radius)] border border-[var(--line)] bg-[var(--panel)] p-4 [animation:access-reveal_.4s_cubic-bezier(.2,.7,.3,1)_both] [animation-delay:180ms] motion-reduce:animate-none" aria-label="Service coverage">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm">Service coverage</strong>
        <span className="flex items-center gap-4 text-[11px] text-[var(--muted)]">
          <span className="flex items-center gap-1.5"><i className={`size-2 rounded-full ${LIGHT_YELLOW}`} /> Monitor only</span>
          <span className="flex items-center gap-1.5"><i className={`size-2 rounded-full ${LIGHT_GREEN}`} /> Monitoring + spending caps</span>
        </span>
      </header>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {families.map((family, index) => (
          <span key={family.family} className="flex min-w-0 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--line-soft)] bg-[var(--panel-soft)] px-2.5 py-2">
            <i className={`size-2 flex-none rounded-full ${dot} ${checking ? "[animation:access-pulse_1s_ease-in-out_infinite]" : ""}`} style={checking ? { animationDelay: `${index * 60}ms` } : undefined} />
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
