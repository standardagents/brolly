import { useEffect, useState } from "react";
import { api } from "../api";
import { ProtectionExplainer, RuntimeAgentHandoff, RuntimeInstallGuide } from "../components/protection";
import { Brand, Icon, InfoTip, ProductIcon } from "../components/ui";
import { normalizeNumericDraft } from "../format";
import type { OnboardingBudgetEstimates, OnboardingData, Policy, SpendLimits, Threshold } from "../types";

const LIMIT_ROWS = [
  { metric: "projected_daily_cost_usd", windowMs: 86_400_000, label: "Projected cost per Durable Object", unit: "USD / day", defaults: [0.5, 2, 5] },
  { metric: "rows_read", windowMs: 300_000, label: "Rows read per Durable Object", unit: "rows / 5 min", defaults: [1_000_000, 2_500_000, 5_000_000] },
  { metric: "rows_written", windowMs: 300_000, label: "Rows written per Durable Object", unit: "rows / 5 min", defaults: [5_000, 12_500, 25_000] },
  { metric: "rows_read", windowMs: 86_400_000, label: "Daily rows read per Durable Object", unit: "rows / 24 hr", defaults: [25_000_000, 50_000_000, 100_000_000] },
  { metric: "rows_written", windowMs: 86_400_000, label: "Daily rows written per Durable Object", unit: "rows / 24 hr", defaults: [125_000, 250_000, 500_000] },
] as const;

type RuntimeIntegration = { workerScript: string; installed: boolean };

export function BudgetWizard({ data, token, editing, initialStep = 0, onCancel, onLogout, onSaved }: {
  data: OnboardingData;
  token: string;
  editing: boolean;
  initialStep?: number;
  onCancel?: () => void;
  onLogout: () => void;
  onSaved: () => Promise<void>;
}) {
  const [step, setStep] = useState(initialStep);
  const [policy, setPolicy] = useState(() => preparePolicy(data.policy, data.families.map(item => item.family), data.scopedAssets));
  const [integrations, setIntegrations] = useState(() => prepareRuntimeIntegrations(data.scopedAssets));
  const [busy, setBusy] = useState(false);
  const [estimateBusy, setEstimateBusy] = useState(false);
  const [estimates, setEstimates] = useState<OnboardingBudgetEstimates | null>(null);
  const [estimateNotice, setEstimateNotice] = useState("");
  const [accessNotice, setAccessNotice] = useState("");
  const [accessError, setAccessError] = useState("");
  const [error, setError] = useState("");
  const steps = ["Check usage access", "Account budget", "Product budgets", "Resource budgets", "Per-object limits", "Install shutdown fuse"];
  const installedIntegrations = Object.values(integrations).filter(integration => integration.installed).length;

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("/api/onboarding", token, {
        method: "POST",
        body: JSON.stringify({
          policy: { ...policy, version: new Date().toISOString() },
          integrations: data.scopedAssets.map(asset => ({
            family: asset.family,
            id: asset.id,
            workerScript: integrations[asset.key]?.workerScript || undefined,
            installed: integrations[asset.key]?.installed === true,
          })),
        }),
      });
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function applySuggestions(result: OnboardingBudgetEstimates) {
    const familySuggestions = Object.entries(result.families).filter(([family]) => family in policy.familyDailySpend);
    const assetSuggestions = Object.entries(result.assets).filter(([key]) => key in policy.assetDailySpend);
    const appliedFamilies = familySuggestions.length;
    const appliedAssets = assetSuggestions.length;
    setPolicy(current => {
      const familyDailySpend = { ...current.familyDailySpend };
      const assetDailySpend = { ...current.assetDailySpend };
      for (const [family, suggestion] of familySuggestions) familyDailySpend[family] = suggestion.limits;
      for (const [key, suggestion] of assetSuggestions) assetDailySpend[key] = suggestion.limits;
      return {
        ...current,
        familyDailySpend,
        assetDailySpend,
        accountDailySpend: result.account && !result.account.partial ? result.account.limits : current.accountDailySpend,
      };
    });
    if (appliedFamilies === 0) {
      setEstimateNotice("Cloudflare returned no non-zero cost estimate for this window, so no limits were changed.");
    } else {
      const accountNote = result.account?.partial ? " The account-wide limit was left unchanged because the scan had partial product coverage." : " The account-wide limit was updated too.";
      setEstimateNotice(`Filled ${appliedFamilies} product ${appliedFamilies === 1 ? "budget" : "budgets"}${appliedAssets ? ` and ${appliedAssets} resource ${appliedAssets === 1 ? "budget" : "budgets"}` : ""}.${accountNote}`);
    }
  }

  async function verifyUsageAccess() {
    setEstimateBusy(true);
    setAccessNotice("");
    setAccessError("");
    try {
      const result = await api<OnboardingBudgetEstimates>("/api/onboarding/estimates", token, { method: "POST" });
      setEstimates(result);
      setAccessNotice("Monitoring access check complete. No limits were changed.");
    } catch (cause) {
      setAccessError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setEstimateBusy(false);
    }
  }

  async function suggestFromRecentUsage() {
    setEstimateBusy(true);
    setEstimateNotice("");
    setError("");
    try {
      const result = estimates ?? await api<OnboardingBudgetEstimates>("/api/onboarding/estimates", token, { method: "POST" });
      setEstimates(result);
      applySuggestions(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setEstimateBusy(false);
    }
  }

  return (
    <main className="setup-shell">
      <header className="setup-header">
        <Brand />
        <div>{editing ? "Budget settings" : "First-run protection setup"}</div>
        <span className="ml-auto flex items-center gap-2">
          {onCancel && <button type="button" className="button quiet" onClick={onCancel}>Close</button>}
          <button type="button" className="button quiet" onClick={onLogout} title="Sign out of Brolly"><Icon name="logout" /> Sign out</button>
        </span>
      </header>
      <div className="setup-layout">
        <aside className="setup-steps">
          <div className="setup-kicker">Protection policy</div>
          <h1>{editing ? "Tune your limits" : "Set the line before spend crosses it."}</h1>
          <p>Every amount is configurable later. Approval mode is the default; automatic emergency quarantine is opt-in and only works for runtimes with the Brolly fuse installed.</p>
          <ol>
            {steps.map((label, index) => (
              <li key={label} className={index === step ? "active" : index < step ? "done" : ""}>
                <span>{index < step ? "✓" : index + 1}</span>{label}
              </li>
            ))}
          </ol>
        </aside>
        <section className="setup-panel">
          {step === 0 && (
            <>
              <p className="eyebrow orange">Step 1 of 6</p>
              <h2>Check what Brolly can see</h2>
              <p className="section-copy">Brolly works by using existing Cloudflare APIs to monitor individual services and the billed usage for those services. To get started, let&apos;s make sure Brolly has the appropriate permissions to safely monitor your account&apos;s usage.</p>
              <AccessActions accountId={data.accountId} busy={estimateBusy} result={estimates} notice={accessNotice} error={accessError} token={token} onVerify={() => void verifyUsageAccess()} onVerified={result => { setEstimates(result); setAccessError(""); setAccessNotice("Billing access saved and verified. No limits were changed."); }} />
            </>
          )}
          {step === 1 && (
            <>
              <p className="eyebrow orange">Step 2 of 6</p>
              <h2>What is an unacceptable account day?</h2>
              <p className="section-copy">These limits apply across all monitored Cloudflare products. Warnings give you time; emergency limits create approval-ready stop actions where a safe control exists.</p>
              <RecentUsageEstimator busy={estimateBusy} result={estimates} notice={estimateNotice} onSuggest={() => void suggestFromRecentUsage()} />
              <LimitEditor title="Total account spend" value={policy.accountDailySpend} onChange={value => setPolicy({ ...policy, accountDailySpend: value })} />
              <div className="mode-card">
                <div>
                  <strong>Control mode</strong>
                  <p>Automatic mode applies an installed fuse only at an emergency threshold. Recovery remains manual.</p>
                </div>
                <select value={policy.mode} onChange={event => setPolicy({ ...policy, mode: event.target.value as Policy["mode"] })}>
                  <option value="observe">Observe only</option>
                  <option value="approval">Require approval</option>
                  <option value="automatic">Automatic emergency quarantine</option>
                </select>
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <p className="eyebrow orange">Step 3 of 6</p>
              <h2>Daily spend by product</h2>
              <p className="section-copy">Set a limit for every billable family. Brolly saves every limit now and clearly marks products where Cloudflare exposes only some of the usage data needed for alerts.</p>
              <TelemetryLegend />
              <div className="limit-table-head"><span>Product</span><span>Warn</span><span>Critical</span><span>Emergency</span></div>
              <div className="limit-table">
                {data.families.map(family => (
                  <FamilyLimitRow
                    key={family.family}
                    family={family}
                    value={policy.familyDailySpend[family.family]!}
                    estimate={estimates?.families[family.family]}
                    onChange={value => setPolicy({ ...policy, familyDailySpend: { ...policy.familyDailySpend, [family.family]: value } })}
                  />
                ))}
              </div>
            </>
          )}
          {step === 3 && (
            <>
              <p className="eyebrow orange">Step 4 of 6</p>
              <h2>Limits for each Worker and namespace</h2>
              <p className="section-copy">These daily budgets override the product default for one Worker script or one Durable Object namespace. Newly discovered resources inherit their product limit until you assign an explicit budget here.</p>
              <TelemetryLegend />
              <div className="limit-table-head"><span>Resource</span><span>Warn</span><span>Critical</span><span>Emergency</span></div>
              <div className="limit-table">
                {data.scopedAssets.length ? data.scopedAssets.map(asset => (
                  <ScopedLimitRow
                    key={asset.key}
                    asset={asset}
                    value={policy.assetDailySpend[asset.key]!}
                    estimate={estimates?.assets[asset.key]}
                    onChange={value => setPolicy({ ...policy, assetDailySpend: { ...policy.assetDailySpend, [asset.key]: value } })}
                  />
                )) : (
                  <div className="empty-small">No Worker scripts or Durable Object namespaces have been discovered yet. Run a scan, then reopen Budgets to assign them.</div>
                )}
              </div>
            </>
          )}
          {step === 4 && (
            <>
              <p className="eyebrow orange">Step 5 of 6</p>
              <h2>Durable Object kill-switch limits</h2>
              <p className="section-copy">Brolly evaluates each returned Durable Object ID independently, so one runaway object can be isolated without deleting its storage or taking an entire account offline.</p>
              <div className="object-limits">
                {LIMIT_ROWS.map(row => (
                  <ObjectLimitRow
                    key={`${row.metric}:${row.windowMs}`}
                    row={row}
                    threshold={findThreshold(policy, row.metric, row.windowMs, row.defaults)}
                    onChange={threshold => setPolicy({ ...policy, thresholds: replaceThreshold(policy.thresholds, threshold) })}
                  />
                ))}
              </div>
              <ProtectionExplainer mode={policy.mode} />
            </>
          )}
          {step === 5 && (
            <>
              <p className="eyebrow orange">Step 6 of 6</p>
              <h2>Make quarantine available</h2>
              <p className="section-copy">Brolly can monitor and alert as soon as you finish setup. To let it quarantine a runaway Worker or one Durable Object, your application needs a tiny local runtime guard.</p>
              <div className="runtime-readiness">
                <article className="ready">
                  <Icon name="check" />
                  <div><strong>Monitoring and alerts are ready</strong><p>No application changes are required. You can safely finish onboarding now.</p></div>
                </article>
                <article>
                  <Icon name="shield" />
                  <div><strong>Quarantine needs a few code lines</strong><p>Install the runtime in each Worker you want Brolly to stop, then verify its deployment.</p></div>
                </article>
              </div>
              <RuntimeAgentHandoff assets={data.scopedAssets} />
              <details className="manual-runtime-guide">
                <summary>Prefer to install it yourself?</summary>
                <p>Use the manual package, secret, constructor, and Worker-ingress instructions.</p>
                <RuntimeInstallGuide />
              </details>
              <RuntimeIntegrationMap assets={data.scopedAssets} values={integrations} onChange={setIntegrations} />
            </>
          )}
          {error && <p className="form-error">{error}</p>}
          <footer className="setup-actions">
            <button type="button" className="button secondary" disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>Back</button>
            {step === 5 && (
              <span className={`runtime-finish-note ${policy.mode === "automatic" && installedIntegrations === 0 ? "caution" : ""}`}>
                {data.scopedAssets.length
                  ? <><strong>{installedIntegrations} of {data.scopedAssets.length} resources reported installed.</strong> {installedIntegrations ? "Verify them after deployment." : "Brolly will alert but cannot quarantine them yet."}</>
                  : <><strong>No resources discovered yet.</strong> Finish in alerts-only mode, run a scan, then return here.</>}
              </span>
            )}
            {step < 5
              ? <button type="button" className="button primary" disabled={busy || (step === 0 && (!estimates || estimateBusy))} onClick={() => setStep(step + 1)}>{step === 0 ? "Continue to limits" : "Continue"}</button>
              : <button type="button" className="button primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : editing ? "Save runtime status" : installedIntegrations ? "Finish and verify installs" : "Finish setup — alerts only"}</button>}
          </footer>
        </section>
      </div>
    </main>
  );
}

function LimitEditor({ title, value, onChange }: { title: string; value: SpendLimits; onChange: (value: SpendLimits) => void }) {
  return (
    <div className="limit-editor">
      <h3>{title}</h3>
      <div className="limit-grid">
        {(["warning", "critical", "emergency"] as const).map(key => (
          <label key={key}>
            <span>{key}</span>
            <div className="money-input"><b>$</b><NumericInput value={value[key]} step="0.01" onChange={next => onChange({ ...value, [key]: next })} /></div>
            <small>per rolling day</small>
          </label>
        ))}
      </div>
    </div>
  );
}

function AccessActions({ accountId, busy, result, notice, error, token, onVerify, onVerified }: {
  accountId: string;
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
  const [recipeCopied, setRecipeCopied] = useState(false);
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
      await api("/api/onboarding/billing-access", token, { method: "PUT", body: JSON.stringify({ token: billingToken }) });
      setBillingToken("");
      const verified = await api<OnboardingBudgetEstimates>("/api/onboarding/estimates", token, { method: "POST" });
      if (verified.access.billing.state !== "connected") throw new Error(verified.access.billing.detail || "Cloudflare did not confirm Billing Read access");
      setBillingSuccess("Billing Read is connected. The token is encrypted in this Brolly installation and will not be shown again.");
      onVerified(verified);
    } catch (cause) {
      setBillingError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBillingBusy(false);
    }
  }

  async function copyBillingRecipe() {
    const recipe = [
      "Cloudflare API token for Brolly",
      "Token name: Brolly Billing Read",
      "Permissions: Account → Billing → Read",
      "Account resources: Include → the same account connected to Brolly",
      "Zone permissions: none",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(recipe);
      setRecipeCopied(true);
      window.setTimeout(() => setRecipeCopied(false), 2_000);
    } catch {
      setBillingError("Your browser could not copy the recipe. Select the settings below and copy them manually.");
    }
  }

  return (
    <div className="mb-5 grid gap-4">
      <section className="flex flex-col gap-4 rounded-[var(--radius)] border border-[var(--good-line)] bg-[var(--good-bg)] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--panel)] text-[var(--good)] [&_.icon]:size-5"><Icon name="shield" /></span>
          <div>
            <div className="flex items-center gap-2"><strong className="text-sm">Check Brolly&apos;s access</strong><InfoTip label="How Brolly checks access">Brolly makes at most two read-only Analytics requests and one billing request only when Billing Read is configured. Results are cached for 15 minutes. This check never changes limits or Cloudflare resources.</InfoTip></div>
            <p className="mt-1 max-w-[64ch] text-xs leading-5 text-[var(--muted)]">Brolly reads Cloudflare's usage APIs. It cannot deploy, quarantine, pause, delete, or change anything during this check, and it does not write monitoring traffic into your applications.</p>
            {notice && <p className="mt-2 text-xs font-semibold text-[var(--good)]" role="status">{notice}</p>}
            {result && <p className="mt-1 text-[11px] text-[var(--faint)]">Checked {new Date(result.generatedAt).toLocaleString()} · {result.apiCalls} bounded API {result.apiCalls === 1 ? "request" : "requests"}</p>}
          </div>
        </div>
        <button type="button" className="button primary shrink-0" disabled={busy || billingBusy} onClick={onVerify}><Icon name="radar" />{busy ? "Checking…" : result ? "Check again" : "Check monitoring access"}</button>
        {error && <p className="form-error basis-full" role="alert"><strong>Monitoring access check failed.</strong> {error}</p>}
      </section>

      {result && <UsageAccessResults result={result} />}

      {analyticsNeedsReconnect && (
        <article className="rounded-[var(--radius)] border border-[var(--warn-line)] bg-[var(--warn-bg)] p-4">
          <div className="flex items-center gap-2"><Icon name="refresh" /><strong className="text-sm">Workers and Durable Object access</strong></div>
          <p className="mt-2 max-w-[72ch] text-xs leading-5 text-[var(--muted)]">Cloudflare denied at least one Analytics permission. Reconnect the account, approve Brolly's current scopes, then run the monitoring check again. You will return to this installation.</p>
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
          copied={recipeCopied}
          onToken={setBillingToken}
          onCopy={() => void copyBillingRecipe()}
          onSubmit={() => void saveBillingAccess()}
        />
      )}
    </div>
  );
}

function BillingAccessSetup({ accountId, token, busy, error, success, copied, onToken, onCopy, onSubmit }: {
  accountId: string;
  token: string;
  busy: boolean;
  error: string;
  success: string;
  copied: boolean;
  onToken: (value: string) => void;
  onCopy: () => void;
  onSubmit: () => void;
}) {
  return (
    <section className="rounded-[var(--radius)] border border-[var(--warn-line)] bg-[var(--panel)] p-5" aria-labelledby="billing-access-title">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--warn-bg)] text-[var(--warn)] [&_.icon]:size-5"><Icon name="wallet" /></span>
        <div>
          <p className="eyebrow">One more permission</p>
          <h3 id="billing-access-title" className="m-0 text-base">Add daily billing access</h3>
          <p className="mt-1 max-w-[72ch] text-xs leading-5 text-[var(--muted)]">Cloudflare requires one separate read-only token to show your real bill totals. Copy Brolly&apos;s settings, create the token in Cloudflare, then paste it back here. It cannot change billing or resources.</p>
        </div>
      </div>

      <ol className="mt-5 grid gap-3">
        <li className="grid gap-3 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--panel-soft)] p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-start">
          <b className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--orange-soft)] text-xs text-[var(--orange-deep)]">1</b>
          <div>
            <strong className="block text-sm">Copy Brolly&apos;s token settings</strong>
            <p className="mt-1 text-xs leading-5 text-[var(--muted)]">You&apos;ll paste these exact settings into Cloudflare in the next step.</p>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
              <dt className="text-[var(--faint)]">Name</dt><dd className="m-0 font-semibold">Brolly Billing Read</dd>
              <dt className="text-[var(--faint)]">Permission</dt><dd className="m-0 font-semibold">Account → Billing → Read</dd>
              <dt className="text-[var(--faint)]">Account</dt><dd className="m-0 font-semibold">Include → this account</dd>
              <dt className="text-[var(--faint)]">Zone access</dt><dd className="m-0 font-semibold">None</dd>
            </dl>
          </div>
          <button type="button" className="button secondary shrink-0" onClick={onCopy}><Icon name="clipboard" /> {copied ? "Recipe copied" : "Copy recipe"}</button>
        </li>

        <li className="grid gap-3 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--panel-soft)] p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
          <b className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--orange-soft)] text-xs text-[var(--orange-deep)]">2</b>
          <div>
            <strong className="block text-sm">Open this account&apos;s API Tokens page</strong>
            <p className="mt-1 text-xs leading-5 text-[var(--muted)]">Click <strong>Create Custom Token</strong>, then enter the settings you just copied.</p>
          </div>
          <a className="button secondary shrink-0" href={`https://dash.cloudflare.com/${encodeURIComponent(accountId)}/api-tokens`} target="_blank" rel="noreferrer"><Icon name="external" /> Open Cloudflare</a>
        </li>

        <li className="grid gap-3 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--panel-soft)] p-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
          <b className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--orange-soft)] text-xs text-[var(--orange-deep)]">3</b>
          <form className="grid gap-3" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
            <div>
              <strong className="block text-sm">Create the token, then paste it here</strong>
              <p className="mt-1 text-xs leading-5 text-[var(--muted)]">In Cloudflare, click <strong>Continue to summary</strong>, then <strong>Create Token</strong>. Copy the token Cloudflare shows—it is displayed only once.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <label className="sr-only" htmlFor="billing-access-token">Paste the new Cloudflare API token</label>
              <input id="billing-access-token" className="min-h-10 min-w-0 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--panel)] px-3 text-sm" type="password" value={token} onChange={event => onToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste the Cloudflare API token" />
              <button type="submit" className="button primary" disabled={busy || !token.trim()}><Icon name="check" /> {busy ? "Verifying…" : "Verify and save"}</button>
            </div>
            <small className="leading-5 text-[var(--faint)]">Brolly verifies the token first, encrypts it in this installation, and never displays it again.</small>
            {error && <p className="form-error mt-1" role="alert"><strong>Billing access failed.</strong> {error}</p>}
            {success && <p className="form-success mt-1" role="status">{success}</p>}
          </form>
        </li>
      </ol>
      <p className="mt-3 text-xs text-[var(--faint)]">Need more help? <a className="font-semibold text-[var(--blue)] hover:underline" href="https://developers.cloudflare.com/fundamentals/api/get-started/create-token/" target="_blank" rel="noreferrer">See Cloudflare&apos;s token instructions ↗</a></p>
    </section>
  );
}

function RecentUsageEstimator({ busy, result, notice, onSuggest }: {
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
            <strong id="recent-usage-estimator-title" className="text-sm">Fill limits from this account's recent usage</strong>
            <InfoTip label="How recent-usage suggestions work">
              Brolly makes at most two bounded Cloudflare Analytics requests for the previous rolling 24 hours, plus one billing request only when a Billing Read token is configured. Results are cached for 15 minutes. Suggestions add 25% warning, 75% critical, and 150% emergency headroom. Nothing is saved until you finish setup.
            </InfoTip>
          </div>
          <p className="mt-1 max-w-[62ch] text-xs leading-5 text-[var(--muted)]">Use the previous 24 hours, add safety headroom, and fill every account, product, Worker, and namespace limit Brolly can estimate. You can edit every value before saving.</p>
          {notice && <p className="mt-2 text-xs font-semibold text-[var(--good)]" role="status">{notice}</p>}
          {result && (
            <p className="mt-1 text-[11px] text-[var(--faint)]">
              {result.cached ? "Reused the 15-minute cache" : `${result.apiCalls} bounded Cloudflare API ${result.apiCalls === 1 ? "request" : "requests"}`} · Window ended {new Date(result.windowEndAt).toLocaleString()}
            </p>
          )}
        </div>
      </div>
      <button type="button" className="button secondary shrink-0" disabled={busy} onClick={onSuggest}>
        <Icon name="trend" />{busy ? "Reading usage…" : result ? "Fill suggested limits" : "Read usage & fill limits"}
      </button>
    </section>
  );
}

function UsageAccessResults({ result }: { result: OnboardingBudgetEstimates }) {
  const rows = [
    { key: "workers" as const, label: "Worker activity" },
    { key: "durable_objects" as const, label: "Durable Object activity" },
    { key: "billing" as const, label: "Cloudflare bill totals" },
  ];
  return (
    <section className="overflow-hidden rounded-[var(--radius)] border border-[var(--line)] bg-[var(--panel)]" aria-label="Cloudflare usage access results">
      <header className="border-b border-[var(--line-soft)] bg-[var(--panel-soft)] px-4 py-3"><strong className="text-sm">Monitoring access results</strong></header>
      {rows.map(row => {
        const access = result.access[row.key];
        const good = access.state === "connected";
        const permissionProblem = accessPermissionProblem(access.detail);
        const bestAvailable = row.key === "workers" && access.state === "limited" && !permissionProblem;
        const ready = good || bestAvailable;
        const caution = !ready && (access.state === "limited" || access.state === "not_configured" || access.state === "unknown");
        const status = access.state === "connected" ? "Ready"
          : bestAvailable ? "Ready for limits"
            : access.state === "limited" ? "Some data missing"
            : access.state === "blocked" ? "Needs access"
              : access.state === "not_configured" ? "Setup needed"
                : "Could not verify";
        const nextStep = row.key === "billing" && !good
          ? { href: "#billing-access-title", label: "Add Billing Read below" }
          : bestAvailable && result.access.billing.state !== "connected"
            ? { href: "#billing-access-title", label: "Add exact account totals below" }
            : row.key !== "billing" && (access.state === "blocked" || permissionProblem)
            ? { href: "/api/auth/login", label: "Reconnect Cloudflare" }
              : null;
        return (
          <article key={row.key} className="grid gap-2 border-t border-[var(--line-soft)] px-4 py-3 first:border-t-0 md:grid-cols-[minmax(190px,.65fr)_auto_minmax(0,1.35fr)] md:items-center md:gap-4">
            <div className="flex items-center gap-2">
              <span className={ready ? "text-[var(--good)]" : caution ? "text-[var(--warn)]" : "text-[var(--danger)]"}><Icon name={ready ? "check" : caution ? "info" : "alert"} /></span>
              <strong className="text-sm">{row.label}</strong>
            </div>
            <span className={`w-max rounded-full px-2 py-1 text-[11px] font-bold ${ready ? "bg-[var(--good-bg)] text-[var(--good)]" : caution ? "bg-[var(--warn-bg)] text-[var(--warn)]" : "bg-[var(--danger-bg)] text-[var(--danger)]"}`}>{status}</span>
            <div>
              <p className="m-0 break-words text-xs leading-5 text-[var(--muted)]">{access.detail}</p>
              {bestAvailable && (
                <p className="mt-1 text-xs font-semibold leading-5 text-[var(--ink)]">
                  {result.access.billing.state === "connected"
                    ? "Account-wide billing is connected too. This is the complete Worker cost coverage Cloudflare currently makes available."
                    : "The Billing Read step below adds exact account-wide charges. Together, those totals and these per-Worker signals provide the complete coverage Cloudflare currently makes available."}
                </p>
              )}
              {nextStep && <a className="mt-2 inline-block text-xs font-bold text-[var(--blue)] hover:underline" href={nextStep.href}>{nextStep.label} →</a>}
              {good && <p className="mt-1 text-xs font-semibold text-[var(--good)]">No action needed.</p>}
            </div>
          </article>
        );
      })}
    </section>
  );
}

function accessPermissionProblem(detail: string): boolean {
  return /permission denied|access denied|forbidden|unauthorized|authentication|missing required|\b403\b/i.test(detail);
}

function FamilyLimitRow({ family, value, estimate, onChange }: { family: OnboardingData["families"][number]; value: SpendLimits; estimate?: OnboardingBudgetEstimates["families"][string]; onChange: (value: SpendLimits) => void }) {
  return (
    <div className="limit-table-row">
      <div className="resource-label">
        <ProductIcon family={family.family} />
        <span className="resource-label-copy">
          <strong>{family.label}</strong>
          <small><i className={`coverage-dot ${family.protection === "active" ? "active" : "gap"}`} aria-hidden="true" />{estimate ? `$${estimate.observedUsd.toFixed(2)} in ${estimate.source === "billing" ? "latest billing day" : "prior 24 hr"}` : family.protection === "active" ? "Usage connected" : "Limited usage data"}</small>
        </span>
      </div>
      {(["warning", "critical", "emergency"] as const).map(key => (
        <label key={key}>
          <span>$</span>
          <NumericInput ariaLabel={`${family.label} ${key}`} value={value[key]} step="0.01" onChange={next => onChange({ ...value, [key]: next })} />
        </label>
      ))}
    </div>
  );
}

function ScopedLimitRow({ asset, value, estimate, onChange }: { asset: OnboardingData["scopedAssets"][number]; value: SpendLimits; estimate?: OnboardingBudgetEstimates["assets"][string]; onChange: (value: SpendLimits) => void }) {
  const kind = asset.family === "workers" ? "Worker script" : "Durable Object namespace";
  return (
    <div className="limit-table-row">
      <div className="resource-label">
        <ProductIcon family={asset.family} />
        <span className="resource-label-copy">
          <strong>{asset.name}</strong>
          <small><i className={`coverage-dot ${asset.protection === "active" ? "active" : "gap"}`} aria-hidden="true" />{kind} · {estimate ? `$${estimate.observedUsd.toFixed(2)} in ${estimate.source === "billing" ? "latest billing day" : "prior 24 hr"}` : asset.protection === "active" ? "Usage connected" : "Limited usage data"}</small>
        </span>
      </div>
      {(["warning", "critical", "emergency"] as const).map(key => (
        <label key={key}>
          <span>$</span>
          <NumericInput ariaLabel={`${asset.name} ${key}`} value={value[key]} step="0.01" onChange={next => onChange({ ...value, [key]: next })} />
        </label>
      ))}
    </div>
  );
}

function TelemetryLegend() {
  return (
    <div className="telemetry-legend" aria-label="Usage data status legend">
      <span><i className="coverage-dot active" aria-hidden="true" /><span><strong>Usage connected</strong><small>Brolly can read every known billing signal for this product</small></span></span>
      <span><i className="coverage-dot gap" aria-hidden="true" /><span><strong>Limited usage data</strong><small>Cloudflare currently exposes only some signals to this installation</small></span></span>
    </div>
  );
}

function ObjectLimitRow({ row, threshold, onChange }: { row: typeof LIMIT_ROWS[number]; threshold: Threshold; onChange: (threshold: Threshold) => void }) {
  return (
    <div className="object-limit-row">
      <div><strong>{row.label}</strong><small>{row.unit}</small></div>
      {(["warning", "critical", "emergency"] as const).map(key => (
        <label key={key}>
          <span>{key}</span>
          <NumericInput value={threshold[key] ?? 0} step={row.metric.includes("cost") ? "0.01" : "1"} onChange={next => onChange({ ...threshold, [key]: next })} />
        </label>
      ))}
    </div>
  );
}

function NumericInput({ value, step, ariaLabel, onChange }: { value: number; step: string; ariaLabel?: string; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => { setDraft(String(value)); }, [value]);

  function update(raw: string) {
    const normalized = normalizeNumericDraft(raw);
    setDraft(normalized);
    if (normalized === "") return;
    const next = Number(normalized);
    if (Number.isFinite(next) && next >= 0) onChange(next);
  }

  function commit() {
    if (draft === "") {
      setDraft(String(value));
      return;
    }
    const next = Number(draft);
    if (Number.isFinite(next) && next >= 0) {
      setDraft(String(next));
      onChange(next);
    } else {
      setDraft(String(value));
    }
  }

  return <input aria-label={ariaLabel} type="number" min="0" step={step} value={draft} onChange={event => update(event.target.value)} onBlur={commit} />;
}

function RuntimeIntegrationMap({ assets, values, onChange }: {
  assets: OnboardingData["scopedAssets"];
  values: Record<string, RuntimeIntegration>;
  onChange: (values: Record<string, RuntimeIntegration>) => void;
}) {
  const workers = assets.filter(asset => asset.family === "workers");
  const namespaces = assets.filter(asset => asset.family === "durable_objects");

  function update(key: string, patch: Partial<RuntimeIntegration>) {
    onChange({ ...values, [key]: { ...values[key]!, ...patch } });
  }

  return (
    <section className="runtime-map">
      <header>
        <div>
          <strong>Connect the resources Brolly discovered</strong>
          <p>Only check an item after deploying the exact guard shown above. Unchecked resources still alert, but Brolly will not claim precise shutdown protection.</p>
        </div>
      </header>
      {workers.length > 0 && (
        <div className="runtime-map-group">
          <h3>Worker scripts</h3>
          {workers.map(asset => (
            <label className="runtime-map-row" key={asset.key}>
              <span>
                <ProductIcon family="workers" />
                <span><strong>{asset.name}</strong><small>Confirm <code>brollyWorker(env)</code> runs before application work.</small></span>
              </span>
              <span className="runtime-confirm">
                <input type="checkbox" checked={values[asset.key]?.installed ?? false} onChange={event => update(asset.key, { installed: event.target.checked })} /> Ingress fuse installed
              </span>
            </label>
          ))}
        </div>
      )}
      {namespaces.length > 0 && (
        <div className="runtime-map-group">
          <h3>Durable Object namespaces</h3>
          {namespaces.map(asset => (
            <div className="runtime-map-row namespace" key={asset.key}>
              <span>
                <ProductIcon family="durable_objects" />
                <span><strong>{asset.name}</strong><small>Cloudflare reports the Worker that owns this namespace.</small></span>
              </span>
              <span className="runtime-worker-field"><span>Owning Worker</span><code>{values[asset.key]?.workerScript || "Not reported"}</code></span>
              <label className="runtime-confirm">
                <input
                  type="checkbox"
                  checked={values[asset.key]?.installed ?? false}
                  disabled={!values[asset.key]?.workerScript.trim()}
                  onChange={event => update(asset.key, { installed: event.target.checked })}
                /> Constructor fuse installed
              </label>
            </div>
          ))}
        </div>
      )}
      {!assets.length && (
        <p className="empty-small">No Worker scripts or Durable Object namespaces were discovered. Finish setup for alerts, run a scan, then return to Budgets to map the runtime fuse.</p>
      )}
      <div className="runtime-map-note">
        <strong>Automatic mode is fail-safe:</strong> Brolly only uses Cloudflare's ownership mapping, a recent successful runtime verification, and two consecutive emergency samples. Missing evidence produces an alert—not a guessed deployment.
      </div>
    </section>
  );
}

function preparePolicy(policy: Policy, families: string[], scopedAssets: OnboardingData["scopedAssets"]): Policy {
  const next = structuredClone(policy);
  next.familyDailySpend ??= {};
  next.assetDailySpend ??= {};
  for (const family of families) next.familyDailySpend[family] ??= { warning: 1, critical: 5, emergency: 10 };
  for (const asset of scopedAssets) next.assetDailySpend[asset.key] ??= { ...(next.familyDailySpend[asset.family] ?? { warning: 1, critical: 5, emergency: 10 }) };
  for (const row of LIMIT_ROWS) next.thresholds = replaceThreshold(next.thresholds, findThreshold(next, row.metric, row.windowMs, row.defaults));
  return next;
}

function prepareRuntimeIntegrations(assets: OnboardingData["scopedAssets"]): Record<string, RuntimeIntegration> {
  return Object.fromEntries(assets.map(asset => [asset.key, {
    workerScript: asset.tags.cloudflareWorkerScript ?? (asset.family === "workers" ? asset.id : ""),
    installed: asset.tags.brollyFuse === "true",
  }]));
}

function findThreshold(policy: Policy, metric: string, windowMs: number, defaults: readonly number[]): Threshold {
  const existing = policy.thresholds.find(item => item.metric === metric && item.windowMs === windowMs);
  return {
    ...existing,
    metric,
    windowMs,
    warning: existing?.warning ?? defaults[0],
    critical: existing?.critical ?? defaults[1],
    emergency: existing?.emergency ?? defaults[2],
  };
}

function replaceThreshold(thresholds: Threshold[], next: Threshold): Threshold[] {
  const found = thresholds.some(item => item.metric === next.metric && item.windowMs === next.windowMs);
  return found
    ? thresholds.map(item => item.metric === next.metric && item.windowMs === next.windowMs ? next : item)
    : [...thresholds, next];
}
