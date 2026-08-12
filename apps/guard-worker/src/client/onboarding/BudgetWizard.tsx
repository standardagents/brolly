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

export function BudgetWizard({ data, token, editing, initialStep = 0, onCancel, onSaved }: {
  data: OnboardingData;
  token: string;
  editing: boolean;
  initialStep?: number;
  onCancel?: () => void;
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
    setError("");
    try {
      const result = await api<OnboardingBudgetEstimates>("/api/onboarding/estimates", token, { method: "POST" });
      setEstimates(result);
      setAccessNotice("Access verified. No limits were changed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
        {onCancel && <button type="button" className="button quiet" onClick={onCancel}>Close</button>}
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
              <p className="eyebrow orange">Step 1 of 6 · Optional</p>
              <h2>Check what Brolly can see</h2>
              <p className="section-copy">Confirm that this installation can read the account inventory, Workers Analytics, Durable Object Analytics, and optional daily billing data. This check is read-only and does not change a limit.</p>
              <AccessActions busy={estimateBusy} result={estimates} notice={accessNotice} token={token} onVerify={() => void verifyUsageAccess()} onVerified={result => { setEstimates(result); setAccessNotice("Billing access saved and verified. No limits were changed."); }} />
              {estimates ? <UsageAccessResults result={estimates} /> : <div className="grid gap-3 md:grid-cols-3">
                <article className="rounded-[var(--radius)] border border-[var(--line-soft)] bg-[var(--panel-soft)] p-4">
                  <Icon name="radar" />
                  <strong className="mt-3 block text-sm">Read-only</strong>
                  <p className="mt-1 text-xs leading-5 text-[var(--muted)]">This step reads Cloudflare Analytics. It cannot deploy, quarantine, pause, or delete anything.</p>
                </article>
                <article className="rounded-[var(--radius)] border border-[var(--line-soft)] bg-[var(--panel-soft)] p-4">
                  <Icon name="gauge" />
                  <strong className="mt-3 block text-sm">Strictly bounded</strong>
                  <p className="mt-1 text-xs leading-5 text-[var(--muted)]">At most two Analytics requests, plus one billing request when Billing Read is configured. Results are cached for 15 minutes.</p>
                </article>
                <article className="rounded-[var(--radius)] border border-[var(--line-soft)] bg-[var(--panel-soft)] p-4">
                  <Icon name="sliders" />
                  <strong className="mt-3 block text-sm">Access only</strong>
                  <p className="mt-1 text-xs leading-5 text-[var(--muted)]">This screen verifies permissions. Historical usage fills limits on the next screen.</p>
                </article>
              </div>}
              {!estimates && <p className="mt-4 text-xs text-[var(--faint)]">You can skip this check and enter every limit manually.</p>}
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
              ? <button type="button" className="button primary" onClick={() => setStep(step + 1)}>{step === 0 ? estimates ? "Continue to limits" : "Skip access check" : "Continue"}</button>
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

function AccessActions({ busy, result, notice, token, onVerify, onVerified }: {
  busy: boolean;
  result: OnboardingBudgetEstimates | null;
  notice: string;
  token: string;
  onVerify: () => void;
  onVerified: (result: OnboardingBudgetEstimates) => void;
}) {
  const [billingToken, setBillingToken] = useState("");
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingError, setBillingError] = useState("");

  async function saveBillingAccess() {
    setBillingBusy(true);
    setBillingError("");
    try {
      await api("/api/onboarding/billing-access", token, { method: "PUT", body: JSON.stringify({ token: billingToken }) });
      setBillingToken("");
      const verified = await api<OnboardingBudgetEstimates>("/api/onboarding/estimates", token, { method: "POST" });
      onVerified(verified);
    } catch (cause) {
      setBillingError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBillingBusy(false);
    }
  }

  return (
    <div className="mb-5 grid gap-3">
      <section className="flex flex-col gap-4 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--panel-soft)] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--orange-soft)] text-[var(--orange-deep)] [&_.icon]:size-5"><Icon name="radar" /></span>
          <div>
            <div className="flex items-center gap-2"><strong className="text-sm">Verify current access</strong><InfoTip label="What the access check does">Brolly makes at most two bounded Analytics requests and one billing request when Billing Read is configured. Results are cached for 15 minutes. This screen never changes or saves a spending limit.</InfoTip></div>
            <p className="mt-1 max-w-[64ch] text-xs leading-5 text-[var(--muted)]">Test the credentials already connected to this installation and show exactly which usage sources Cloudflare allows Brolly to read.</p>
            {notice && <p className="mt-2 text-xs font-semibold text-[var(--good)]" role="status">{notice}</p>}
            {result && <p className="mt-1 text-[11px] text-[var(--faint)]">Checked {new Date(result.generatedAt).toLocaleString()} · {result.apiCalls} bounded API {result.apiCalls === 1 ? "request" : "requests"}</p>}
          </div>
        </div>
        <button type="button" className="button primary shrink-0" disabled={busy || billingBusy} onClick={onVerify}><Icon name="radar" />{busy ? "Verifying…" : result ? "Verify again" : "Verify access"}</button>
      </section>

      <section className="grid gap-3 md:grid-cols-2" aria-label="Increase Cloudflare access">
        <article className="rounded-[var(--radius)] border border-[var(--line-soft)] bg-[var(--panel)] p-4">
          <div className="flex items-center gap-2"><Icon name="refresh" /><strong className="text-sm">Workers and Durable Object access</strong></div>
          <p className="mt-2 text-xs leading-5 text-[var(--muted)]">If Analytics or inventory access is blocked, reconnect Cloudflare and approve the current read and control scopes. You will return to this Brolly installation.</p>
          <a className="button secondary mt-3" href="/api/auth/login"><Icon name="external" /> Reconnect Cloudflare</a>
        </article>
        <article className="rounded-[var(--radius)] border border-[var(--line-soft)] bg-[var(--panel)] p-4">
          <div className="flex items-center gap-2"><Icon name="wallet" /><strong className="text-sm">Daily billing access</strong></div>
          <p className="mt-2 text-xs leading-5 text-[var(--muted)]">For invoice-aligned daily costs, create an account-scoped token with only <strong>Billing Read</strong>, paste it once, and verify it here. Brolly encrypts it in this installation's D1.</p>
          <form className="mt-3 grid gap-2" onSubmit={event => { event.preventDefault(); void saveBillingAccess(); }}>
            <label className="text-xs font-semibold" htmlFor="billing-access-token">Billing Read API token</label>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <input id="billing-access-token" className="min-h-9 min-w-0 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--panel-soft)] px-3 text-sm" type="password" value={billingToken} onChange={event => setBillingToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste token once" />
              <button type="submit" className="button secondary" disabled={billingBusy || !billingToken.trim()}>{billingBusy ? "Verifying…" : "Save & verify"}</button>
            </div>
            <a className="text-xs font-semibold text-[var(--blue)] hover:underline" href="https://developers.cloudflare.com/fundamentals/api/get-started/create-token/" target="_blank" rel="noreferrer">How to create the token ↗</a>
            {billingError && <p className="form-error mt-1" role="alert">{billingError}</p>}
          </form>
        </article>
      </section>
    </div>
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
    { key: "workers" as const, label: "Workers usage" },
    { key: "durable_objects" as const, label: "Durable Object usage" },
    { key: "billing" as const, label: "Daily billing details" },
  ];
  return (
    <div className="grid gap-3 md:grid-cols-3" aria-label="Cloudflare usage access results">
      {rows.map(row => {
        const access = result.access[row.key];
        const good = access.state === "connected";
        const caution = access.state === "limited" || access.state === "not_configured" || access.state === "unknown";
        return (
          <article key={row.key} className={`rounded-[var(--radius)] border p-4 ${good ? "border-[var(--good-line)] bg-[var(--good-bg)]" : caution ? "border-[var(--warn-line)] bg-[var(--warn-bg)]" : "border-[var(--danger-line)] bg-[var(--danger-bg)]"}`}>
            <div className="flex items-center gap-2">
              <span className={good ? "text-[var(--good)]" : caution ? "text-[var(--warn)]" : "text-[var(--danger)]"}><Icon name={good ? "check" : caution ? "info" : "alert"} /></span>
              <strong className="text-sm">{row.label}</strong>
            </div>
            <p className="mt-2 text-xs font-semibold capitalize">{access.state.replaceAll("_", " ")}</p>
            <p className="mt-1 break-words text-xs leading-5 text-[var(--muted)]">{access.detail}</p>
          </article>
        );
      })}
    </div>
  );
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
