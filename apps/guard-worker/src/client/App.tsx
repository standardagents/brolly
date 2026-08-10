import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, forgetToken, rememberToken, savedToken } from "./api";
import { dateTime, duration, measurement, metricTitle, money, normalizeNumericDraft, number, relativeTime } from "./format";
import type { AssetTier, DashboardData, Incident, NotificationKind, NotificationTarget, OnboardingData, Policy, Severity, SpendLimits, Threshold } from "./types";

const LIMIT_ROWS = [
  { metric: "projected_daily_cost_usd", windowMs: 86_400_000, label: "Projected cost per Durable Object", unit: "USD / day", defaults: [0.5, 2, 5] },
  { metric: "rows_read", windowMs: 300_000, label: "Rows read per Durable Object", unit: "rows / 5 min", defaults: [1_000_000, 2_500_000, 5_000_000] },
  { metric: "rows_written", windowMs: 300_000, label: "Rows written per Durable Object", unit: "rows / 5 min", defaults: [5_000, 12_500, 25_000] },
  { metric: "rows_read", windowMs: 86_400_000, label: "Daily rows read per Durable Object", unit: "rows / 24 hr", defaults: [25_000_000, 50_000_000, 100_000_000] },
  { metric: "rows_written", windowMs: 86_400_000, label: "Daily rows written per Durable Object", unit: "rows / 24 hr", defaults: [125_000, 250_000, 500_000] },
] as const;

const PRODUCT_ICON: Record<string, string> = {
  durable_objects: "durable-objects", workers: "workers", workers_ai: "workers-ai", queues: "queues", d1: "d1", r2: "r2", kv: "kv",
  pages: "pages", images: "images", stream: "stream", vectorize: "vectorize", hyperdrive: "hyperdrive", ai_gateway: "ai-gateway", zones: "dns",
};

const NOTIFICATION_CHANNELS: Array<{ kind: NotificationKind; label: string; description: string }> = [
  { kind: "discord", label: "Discord", description: "Post structured incident messages to a Discord channel webhook." },
  { kind: "slack", label: "Slack", description: "Send incident summaries to a Slack incoming webhook." },
  { kind: "twilio", label: "Twilio SMS", description: "Text a phone number for high-urgency incidents through Twilio." },
];

export default function App() {
  const [token, setToken] = useState(savedToken());
  const [onboarding, setOnboarding] = useState<OnboardingData | null>(null);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [page, setPage] = useState<"dashboard" | "settings">(() => window.location.pathname === "/settings" ? "settings" : "dashboard");

  const loadDashboard = useCallback(async (activeToken = token) => {
    const next = await api<DashboardData>("/api/dashboard", activeToken);
    setDashboard(next);
    return next;
  }, [token]);

  const bootstrap = useCallback(async (activeToken: string) => {
    setLoading(true); setError("");
    try {
      const setup = await api<OnboardingData>("/api/onboarding", activeToken);
      setOnboarding(setup);
      if (setup.complete) await loadDashboard(activeToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      forgetToken(); setToken(""); setOnboarding(null); setDashboard(null);
    } finally { setLoading(false); }
  }, [loadDashboard]);

  useEffect(() => { if (token) void bootstrap(token); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const updatePage = () => setPage(window.location.pathname === "/settings" ? "settings" : "dashboard");
    window.addEventListener("popstate", updatePage);
    return () => window.removeEventListener("popstate", updatePage);
  }, []);
  useEffect(() => {
    if (!token || !onboarding?.complete) return;
    const interval = window.setInterval(() => void loadDashboard().catch(() => undefined), 60_000);
    return () => window.clearInterval(interval);
  }, [loadDashboard, onboarding?.complete, token]);

  async function login(nextToken: string) {
    rememberToken(nextToken); setToken(nextToken); await bootstrap(nextToken);
  }

  function logout() {
    forgetToken(); setToken(""); setOnboarding(null); setDashboard(null); setError("");
  }

  function navigate(next: "dashboard" | "settings") {
    window.history.pushState({}, "", next === "settings" ? "/settings" : "/");
    setPage(next);
    window.scrollTo({ top: 0 });
  }

  async function openSettings() {
    const next = await api<OnboardingData>("/api/onboarding", token);
    setOnboarding(next);
    setSettingsOpen(true);
  }

  if (!token) return <Login onLogin={login} error={error} />;
  if (loading && !onboarding) return <LoadingScreen />;
  if (onboarding && (!onboarding.complete || settingsOpen)) {
    return <BudgetSetup
      data={onboarding}
      token={token}
      editing={settingsOpen}
      onCancel={settingsOpen ? () => setSettingsOpen(false) : undefined}
      onSaved={async () => {
        const next = await api<OnboardingData>("/api/onboarding", token);
        setOnboarding(next); setSettingsOpen(false); await loadDashboard();
      }}
    />;
  }
  if (!dashboard) return error ? <Login onLogin={login} error={error} /> : <LoadingScreen />;
  if (page === "settings") return <SettingsPage data={dashboard} token={token} onDashboard={() => navigate("dashboard")} onLogout={logout} onBudgets={() => void openSettings()} />;
  return <Dashboard data={dashboard} token={token} onRefresh={() => loadDashboard()} onLogout={logout} onBudgets={() => void openSettings()} onSettings={() => navigate("settings")} />;
}

function Login({ onLogin, error }: { onLogin: (token: string) => Promise<void>; error: string }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!value.trim()) return;
    setBusy(true); try { await onLogin(value.trim()); } finally { setBusy(false); }
  }
  return <main className="auth-shell">
    <section className="auth-card">
      <Brand large />
      <p className="eyebrow">Cloudflare cost control</p>
      <h1>See the spike.<br />Stop the spend.</h1>
      <p className="auth-copy">Sign in with the admin token created when this Brolly guard was installed.</p>
      <form onSubmit={submit}>
        <label htmlFor="admin-token">Brolly admin token</label>
        <input id="admin-token" type="password" autoFocus autoComplete="current-password" value={value} onChange={event => setValue(event.target.value)} placeholder="Paste token" />
        {error && <p className="form-error">{error}</p>}
        <button className="button primary full" disabled={busy || !value.trim()}>{busy ? "Checking…" : "Open Brolly"}</button>
      </form>
      <p className="fine-print">The token stays in this browser. Brolly never sends it to a third party.</p>
    </section>
    <div className="auth-art" aria-hidden="true"><div className="radar-ring one" /><div className="radar-ring two" /><div className="auth-cloud">☁</div></div>
  </main>;
}

function BudgetSetup({ data, token, editing, onCancel, onSaved }: { data: OnboardingData; token: string; editing: boolean; onCancel?: () => void; onSaved: () => Promise<void> }) {
  const [step, setStep] = useState(0);
  const [policy, setPolicy] = useState(() => preparePolicy(data.policy, data.families.map(item => item.family), data.scopedAssets));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const steps = ["Account budget", "Product budgets", "Resource budgets", "Per-object limits"];

  async function save() {
    setBusy(true); setError("");
    try {
      await api("/api/onboarding", token, { method: "POST", body: JSON.stringify({ policy: { ...policy, version: new Date().toISOString() } }) });
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <main className="setup-shell">
    <header className="setup-header"><Brand /><div>{editing ? "Budget settings" : "First-run protection setup"}</div>{onCancel && <button className="button quiet" onClick={onCancel}>Close</button>}</header>
    <div className="setup-layout">
      <aside className="setup-steps">
        <div className="setup-kicker">Protection policy</div>
        <h1>{editing ? "Tune your limits" : "Set the line before spend crosses it."}</h1>
        <p>Every amount is configurable later. Automatic shutdown remains off; Brolly will prepare reversible actions for approval.</p>
        <ol>{steps.map((label, index) => <li key={label} className={index === step ? "active" : index < step ? "done" : ""}><span>{index < step ? "✓" : index + 1}</span>{label}</li>)}</ol>
      </aside>
      <section className="setup-panel">
        {step === 0 && <>
          <p className="eyebrow orange">Step 1 of 4</p><h2>What is an unacceptable account day?</h2>
          <p className="section-copy">These limits apply across all monitored Cloudflare products. Warnings give you time; emergency limits create approval-ready stop actions where a safe control exists.</p>
          <LimitEditor title="Total account spend" value={policy.accountDailySpend} onChange={value => setPolicy({ ...policy, accountDailySpend: value })} />
          <div className="mode-card"><div><strong>Control mode</strong><p>Approval is the safest place to start. Brolly never deletes data.</p></div><select value={policy.mode} onChange={event => setPolicy({ ...policy, mode: event.target.value as Policy["mode"] })}><option value="observe">Observe only</option><option value="approval">Require approval</option></select></div>
        </>}
        {step === 1 && <>
          <p className="eyebrow orange">Step 2 of 4</p><h2>Daily spend by product</h2>
          <p className="section-copy">Set a limit for every billable family. Limits with partial telemetry are saved now and gain full enforcement as the remaining collectors are connected.</p>
          <TelemetryLegend />
          <div className="limit-table-head"><span>Product</span><span>Warn</span><span>Critical</span><span>Emergency</span></div>
          <div className="limit-table">{data.families.map(family => <FamilyLimitRow key={family.family} family={family} value={policy.familyDailySpend[family.family]!} onChange={value => setPolicy({ ...policy, familyDailySpend: { ...policy.familyDailySpend, [family.family]: value } })} />)}</div>
        </>}
        {step === 2 && <>
          <p className="eyebrow orange">Step 3 of 4</p><h2>Limits for each Worker and namespace</h2>
          <p className="section-copy">These daily budgets override the product default for one Worker script or one Durable Object namespace. Newly discovered resources inherit their product limit until you assign an explicit budget here.</p>
          <TelemetryLegend />
          <div className="limit-table-head"><span>Resource</span><span>Warn</span><span>Critical</span><span>Emergency</span></div>
          <div className="limit-table">{data.scopedAssets.length ? data.scopedAssets.map(asset => <ScopedLimitRow key={asset.key} asset={asset} value={policy.assetDailySpend[asset.key]!} onChange={value => setPolicy({ ...policy, assetDailySpend: { ...policy.assetDailySpend, [asset.key]: value } })} />) : <div className="empty-small">No Worker scripts or Durable Object namespaces have been discovered yet. Run a scan, then reopen Budgets to assign them.</div>}</div>
        </>}
        {step === 3 && <>
          <p className="eyebrow orange">Step 4 of 4</p><h2>Durable Object kill-switch limits</h2>
          <p className="section-copy">Brolly evaluates each returned Durable Object ID independently, so one runaway object can be isolated without deleting its storage or taking an entire account offline.</p>
          <div className="object-limits">{LIMIT_ROWS.map(row => <ObjectLimitRow key={`${row.metric}:${row.windowMs}`} row={row} threshold={findThreshold(policy, row.metric, row.windowMs, row.defaults)} onChange={threshold => setPolicy({ ...policy, thresholds: replaceThreshold(policy.thresholds, threshold) })} />)}</div>
          <ProtectionExplainer mode={policy.mode} />
        </>}
        {error && <p className="form-error">{error}</p>}
        <footer className="setup-actions">
          <button className="button secondary" disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>Back</button>
          {step < 3 ? <button className="button primary" onClick={() => setStep(step + 1)}>Continue</button> : <button className="button primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : editing ? "Save budget policy" : "Activate Brolly"}</button>}
        </footer>
      </section>
    </div>
  </main>;
}

function LimitEditor({ title, value, onChange }: { title: string; value: SpendLimits; onChange: (value: SpendLimits) => void }) {
  return <div className="limit-editor"><h3>{title}</h3><div className="limit-grid">
    {(["warning", "critical", "emergency"] as const).map(key => <label key={key}><span>{key}</span><div className="money-input"><b>$</b><NumericInput value={value[key]} step="0.01" onChange={next => onChange({ ...value, [key]: next })} /></div><small>per rolling day</small></label>)}
  </div></div>;
}

function FamilyLimitRow({ family, value, onChange }: { family: OnboardingData["families"][number]; value: SpendLimits; onChange: (value: SpendLimits) => void }) {
  return <div className="limit-table-row"><div className="resource-label"><ProductIcon family={family.family} /><span className="resource-label-copy"><strong>{family.label}</strong><small><i className={`coverage-dot ${family.protection === "active" ? "active" : "gap"}`} aria-hidden="true" />{family.protection === "active" ? "Full telemetry" : "Partial telemetry"}</small></span></div>{(["warning", "critical", "emergency"] as const).map(key => <label key={key}><span>$</span><NumericInput ariaLabel={`${family.label} ${key}`} value={value[key]} step="0.01" onChange={next => onChange({ ...value, [key]: next })} /></label>)}</div>;
}

function ScopedLimitRow({ asset, value, onChange }: { asset: OnboardingData["scopedAssets"][number]; value: SpendLimits; onChange: (value: SpendLimits) => void }) {
  const kind = asset.family === "workers" ? "Worker script" : "Durable Object namespace";
  return <div className="limit-table-row"><div className="resource-label"><ProductIcon family={asset.family} /><span className="resource-label-copy"><strong>{asset.name}</strong><small><i className={`coverage-dot ${asset.protection === "active" ? "active" : "gap"}`} aria-hidden="true" />{kind} · {asset.protection === "active" ? "Full telemetry" : "Partial telemetry"}</small></span></div>{(["warning", "critical", "emergency"] as const).map(key => <label key={key}><span>$</span><NumericInput ariaLabel={`${asset.name} ${key}`} value={value[key]} step="0.01" onChange={next => onChange({ ...value, [key]: next })} /></label>)}</div>;
}

function TelemetryLegend() {
  return <div className="telemetry-legend" aria-label="Telemetry status legend">
    <span><i className="coverage-dot active" aria-hidden="true" /><span><strong>Full telemetry</strong><small>All known billing signals are monitored</small></span></span>
    <span><i className="coverage-dot gap" aria-hidden="true" /><span><strong>Partial telemetry</strong><small>One or more billing signals still need a collector</small></span></span>
  </div>;
}

function ObjectLimitRow({ row, threshold, onChange }: { row: typeof LIMIT_ROWS[number]; threshold: Threshold; onChange: (threshold: Threshold) => void }) {
  return <div className="object-limit-row"><div><strong>{row.label}</strong><small>{row.unit}</small></div>{(["warning", "critical", "emergency"] as const).map(key => <label key={key}><span>{key}</span><NumericInput value={threshold[key] ?? 0} step={row.metric.includes("cost") ? "0.01" : "1"} onChange={next => onChange({ ...threshold, [key]: next })} /></label>)}</div>;
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

function ProtectionExplainer({ mode }: { mode: Policy["mode"] }) {
  const finalStep = mode === "observe"
    ? "Observe mode records the incident and alerts you, but never sends a quarantine command."
    : mode === "approval"
      ? "Approval mode waits for you to inspect the incident and explicitly approve quarantine. Nothing is stopped automatically."
      : "Automatic mode may quarantine a standard or disposable object immediately after every safety requirement passes.";

  return <section className="protection-explainer">
    <header><Icon name="shield" /><div><strong>What “stop this object” actually means</strong><p>An exact-object stop is a signed application-level quarantine—not a Cloudflare pause switch.</p></div></header>
    <div className="protection-body">
      <section className="explainer-section">
        <h3>How Brolly reaches one object from outside</h3>
        <ol className="control-flow">
          <li><span>1</span><div><strong>Detect and identify</strong><p>A bounded scan attributes the emergency to one 64-character Durable Object ID.</p></div></li>
          <li><span>2</span><div><strong>Sign a short-lived command</strong><p>Brolly sends the owning Worker a 60-second ES256 command scoped to the account, project, object ID, and action ID.</p></div></li>
          <li><span>3</span><div><strong>Route to the exact object</strong><p>The Worker verifies the signature and scope, reconstructs that ID through its Durable Object namespace binding, then invokes the object's quarantine RPC.</p></div></li>
          <li><span>4</span><div><strong>Persist before interrupting</strong><p>The object writes its quarantine state first, marks execution stopped, deletes its alarm, and aborts active execution. Repeated commands are idempotent.</p></div></li>
        </ol>
      </section>
      <ObjectStopImpact />
      <section className="mode-explanation"><strong>What your selected mode does</strong><p>{finalStep} Warning and critical incidents only alert; only an emergency is eligible for quarantine.</p></section>
    </div>
    <div className="quarantine-note"><strong>This requires cooperation from the owning runtime.</strong> Cloudflare does not expose a generic account API that pauses one Durable Object. Without Brolly's signed runtime endpoint, the narrow control is unavailable; disabling the parent Worker would affect every object and user behind that Worker, so Brolly treats that as a separate, broader action.</div>
  </section>;
}

function ObjectStopImpact({ compact = false }: { compact?: boolean }) {
  return <section className={`stop-impact ${compact ? "compact" : ""}`}>
    <h3>Service impact while quarantined</h3>
    <div className="impact-grid">
      <div className="impact-card interrupted"><strong>Interrupted now</strong><p>The active agent run or background execution is aborted, and the object's scheduled alarm is removed.</p></div>
      <div className="impact-card blocked"><strong>Blocked until resume</strong><p>New execution or message requests for this object return HTTP 423 Locked instead of running up more cost.</p></div>
      <div className="impact-card preserved"><strong>Preserved</strong><p>The object's SQLite rows, messages, queued records, and history are not deleted. Other object IDs keep serving normally.</p></div>
      <div className="impact-card recovery"><strong>Recovery</strong><p>A signed resume clears quarantine and re-arms processing. Callers may need to retry the request that was interrupted.</p></div>
    </div>
  </section>;
}

function SettingsPage({ data, token, onDashboard, onLogout, onBudgets }: { data: DashboardData; token: string; onDashboard: () => void; onLogout: () => void; onBudgets: () => void }) {
  const connection = connectionHealth(data);
  return <div className="app-shell">
    <header className="topbar"><Brand /><nav className="page-nav"><a href="/" onClick={event => { event.preventDefault(); onDashboard(); }}>Overview</a><a className="active" href="/settings">Settings</a></nav><div className="top-actions"><button className="button quiet" onClick={onBudgets}><Icon name="gauge" /> Edit budgets</button><button className="avatar" title="Sign out" onClick={onLogout}>B</button></div></header>
    <main className="dashboard settings-page">
      <div className="page-heading"><div><p className="eyebrow orange">Configuration</p><h1>Settings</h1><p>Budgets, notification routes, and the controls Brolly is allowed to use.</p></div><button className="button secondary" onClick={onDashboard}><Icon name="arrow" /> Back to overview</button></div>
      <section className="settings-overview" aria-label="Settings overview">
        <article><div className="settings-card-icon"><Icon name="gauge" /></div><div><strong>Budgets and enforcement</strong><p>{money(data.policy.accountDailySpend.warning)} warning · {money(data.policy.accountDailySpend.emergency)} emergency · {data.policy.mode} mode</p></div><button className="button secondary" onClick={onBudgets}>Edit limits</button></article>
        <article><div className={`settings-card-icon connection ${connection.kind}`}><Icon name={connection.kind === "connected" ? "check" : "alert"} /></div><div><strong>Cloudflare connection</strong><p>{connection.label}. Review detailed collector health on the overview.</p></div><button className="button secondary" onClick={onDashboard}>View coverage</button></article>
      </section>
      <NotificationSection token={token} />
      <ControlCapabilities />
    </main>
  </div>;
}

function Dashboard({ data, token, onRefresh, onLogout, onBudgets, onSettings }: { data: DashboardData; token: string; onRefresh: () => Promise<DashboardData>; onLogout: () => void; onBudgets: () => void; onSettings: () => void }) {
  const [selected, setSelected] = useState<Incident | null>(null);
  const [filter, setFilter] = useState<"all" | "open" | "acknowledged">("open");
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const incidents = data.incidents.filter(item => filter === "all" || item.status === filter);
  const connection = connectionHealth(data);
  async function scan() {
    setScanning(true); setScanError("");
    try { await api("/api/run", token, { method: "POST" }); await onRefresh(); }
    catch (cause) { setScanError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setScanning(false); }
  }
  return <div className="app-shell">
    <header className="topbar"><Brand /><nav><a href="#spend">Spend</a><a href="#incidents">Incidents <span>{data.summary.openIncidents}</span></a><a href="#coverage">Coverage</a><a href="#assets">Assets</a></nav><div className="top-actions"><button className="button quiet" onClick={onSettings}><Icon name="sliders" /> Settings</button><div className="scan-control"><button className="button secondary" disabled={scanning} onClick={() => void scan()}><Icon name="refresh" /> {scanning ? "Scanning account…" : "Scan account now"}</button><ScanInfoTip /></div><button className="avatar" title="Sign out" onClick={onLogout}>B</button></div></header>
    <main className="dashboard">
      <div className="page-heading"><div><p className="eyebrow orange">Account guard</p><h1>Cost overview</h1><p>{connection.kind === "local" ? "Local preview" : shortId(data.account.id)} · {data.policy.mode === "approval" ? "Actions require approval" : data.policy.mode}</p></div><div className={`scan-health ${connection.kind}`}><span className="live-dot" /> {connection.kind === "connected" ? `Last account scan ${data.summary.lastCheckAt ? relativeTime(data.summary.lastCheckAt) : "not yet"}` : connection.label}<InfoTip label="What this connection status means" align="right"><h4>{connection.title}</h4><p>{connection.detail}</p><p>The automatic monitor attempts a bounded pass every minute. This status reflects Brolly's evidence, not whether the Cloudflare dashboard itself is reachable.</p></InfoTip></div></div>
      <ConnectionBanner connection={connection} scanError={scanError} />
      <SpendSection data={data} preview={connection.kind !== "connected"} />
      <section className="summary-grid" aria-label="Account summary">
        <SummaryCard href="#incidents" label="Open incidents" value={data.summary.openIncidents} detail={data.summary.openIncidents === 0 ? "No open usage incidents" : data.summary.emergencyIncidents ? `${data.summary.emergencyIncidents} emergency` : "Review the response queue"} tone={data.summary.openIncidents && data.summary.emergencyIncidents ? "danger" : data.summary.openIncidents ? "warning" : "good"} icon="alert" />
        <SummaryCard href="#coverage" label="Coverage gaps" value={data.summary.coverageGaps} detail="Collectors needing attention" tone="warning" icon="radar" />
        <SummaryCard href="#assets" label="Assets watched" value={data.summary.assets} detail={`${data.assets.tiers.unclassified ?? 0} need classification`} tone="neutral" icon="layers" />
        <SummaryCard href="#budgets" label="Account emergency limit" value={money(data.policy.accountDailySpend.emergency)} detail={`${money(data.policy.accountDailySpend.warning)} warning`} tone="neutral" icon="gauge" onClick={onBudgets} />
      </section>
      <IncidentSection incidents={incidents} total={data.incidents.length} filter={filter} onFilter={setFilter} onSelect={setSelected} />
      <CoverageSection data={data} />
      <AssetsSection data={data} />
      <ActionsSection data={data} token={token} onRefresh={onRefresh} />
    </main>
    {selected && <IncidentDrawer incident={selected} token={token} onClose={() => setSelected(null)} onChanged={async () => { const next = await onRefresh(); setSelected(next.incidents.find(item => item.id === selected.id) ?? null); }} />}
  </div>;
}

type ConnectionHealth = { kind: "connected" | "local" | "disconnected"; label: string; title: string; detail: string; errors: string[] };

function ConnectionBanner({ connection, scanError }: { connection: ConnectionHealth; scanError: string }) {
  if (connection.kind === "connected" && !scanError) return null;
  const errors = [...connection.errors, ...(scanError ? [parseProviderError(scanError).message || scanError] : [])];
  return <section className={`connection-banner ${connection.kind}`} role="status">
    <div className="connection-banner-icon"><Icon name={connection.kind === "local" ? "info" : "alert"} /></div>
    <div><div className="connection-title"><strong>{connection.title}</strong><InfoTip label="What works while Cloudflare is disconnected?"><h4>Dashboard-only features still work</h4><p>You can inspect the sample UI, edit local budgets, configure encrypted notification targets, and read the control runbooks.</p><h4>Protection does not work yet</h4><p>Inventory, live spend estimates, incident detection, Cloudflare actions, and delivery of newly detected incident alerts require a working Cloudflare account connection.</p></InfoTip></div><p>{connection.detail}</p>{errors.length > 0 && <ul>{[...new Set(errors)].slice(0, 3).map(message => <li key={message}>{message}</li>)}</ul>}</div>
    <a className="button secondary" href="#coverage">View connection details</a>
  </section>;
}

function ControlCapabilities() {
  return <section id="shutdown-options" className="panel-section controls-explainer">
    <div className="section-heading"><div><p className="eyebrow">Shutdown playbook</p><h2 className="heading-with-info">What Brolly can stop <InfoTip label="How shutdown controls work"><h4>Detection is not enforcement</h4><p>A budget crossing creates an incident. A stop is only available when the asset is classified, the relevant control is supported, and the selected policy mode permits it.</p><p>Every Cloudflare-side change saves rollback state first and is written to the audit log. Brolly never deletes stored customer data.</p></InfoTip></h2><p>The blast radius depends on which lever exists for that Cloudflare resource.</p></div></div>
    <div className="control-capability-grid">
      <article><ProductIcon family="durable_objects" /><div><strong>One Durable Object</strong><span className="capability-pill precise">Precise</span><p>A signed runtime integration quarantines one exact object ID, aborts its active work, removes its alarm, and returns HTTP 423 for new work. Storage is preserved. This is unavailable unless the owning Worker implements Brolly's runtime endpoint.</p></div></article>
      <article><ProductIcon family="workers" /><div><strong>Worker ingress and triggers</strong><span className="capability-pill broad">Broad impact</span><p>Brolly can remove supported routes, custom domains, workers.dev exposure, and cron triggers after saving rollback state. This interrupts every request using those entry points; already-running work and Durable Object alarms are not guaranteed to stop instantly.</p></div></article>
      <article><ProductIcon family="queues" /><div><strong>Queue delivery</strong><span className="capability-pill reversible">Reversible</span><p>Brolly can pause the queue consumer. Messages remain queued, but processing stops until rollback restores the consumer. Producers may continue adding backlog and storage/retention rules still apply.</p></div></article>
      <article className="unavailable"><Icon name="alert" /><div><strong>Account-wide “kill every object”</strong><span className="capability-pill unavailable">Not exposed by Cloudflare</span><p>Cloudflare has no generic account API to terminate every Durable Object instance. Brolly must not imply otherwise. The broadest current fallback is disabling known Worker ingress/triggers, which can cause a major outage and may not stop alarms already scheduled inside objects.</p></div></article>
    </div>
  </section>;
}

function NotificationSection({ token }: { token: string }) {
  const [targets, setTargets] = useState<NotificationTarget[]>([]);
  const [credentialStorageReady, setCredentialStorageReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const result = await api<{ targets: NotificationTarget[]; credentialStorageReady: boolean }>("/api/targets", token);
      setTargets(result.targets.filter(target => NOTIFICATION_CHANNELS.some(channel => channel.kind === target.kind)));
      setCredentialStorageReady(result.credentialStorageReady);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  async function toggle(target: NotificationTarget) {
    setError("");
    try { await api(`/api/targets/${encodeURIComponent(target.id)}`, token, { method: "PATCH", body: JSON.stringify({ enabled: !target.enabled }) }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function severity(target: NotificationTarget, minimumSeverity: Severity) {
    setError("");
    try { await api(`/api/targets/${encodeURIComponent(target.id)}`, token, { method: "PATCH", body: JSON.stringify({ minimumSeverity }) }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <section id="notifications" className="panel-section notification-section">
    <div className="section-heading"><div><p className="eyebrow">Escalation</p><h2 className="heading-with-info">Incident notifications <InfoTip label="When does Brolly send a notification?"><h4>Only new or materially escalated incidents</h4><p>The minute monitor deduplicates repeated detections. Each target receives at most 20 deliveries per hour; Twilio also has a five-SMS-per-day safety cap.</p><h4>Daily summaries</h4><p>The configured daily summary hour is separate from immediate incident delivery. Coverage gaps are reported explicitly so missing telemetry cannot look like zero spend.</p></InfoTip></h2><p>Route warnings and emergencies to the people who can respond.</p></div><span className={`count-badge ${targets.some(target => target.enabled) ? "" : "warning"}`}>{targets.filter(target => target.enabled).length} active</span></div>
    <div className={`credential-callout ${credentialStorageReady ? "ready" : "missing"}`}><Icon name={credentialStorageReady ? "shield" : "alert"} /><div><strong>{credentialStorageReady ? "Credentials are encrypted at rest" : "Credential encryption is not configured"}</strong><p>{credentialStorageReady ? "Webhook URLs and Twilio secrets are sealed before D1 storage and are never returned to the browser." : "Set BROLLY_CREDENTIAL_KEY before saving a destination. Brolly refuses to store notification credentials in plaintext."}</p></div></div>
    {error && <p className="form-error notification-error">{error}</p>}{saved && <p className="form-success">{saved}</p>}
    <div className="notification-grid">{NOTIFICATION_CHANNELS.map(channel => {
      const target = targets.find(item => item.kind === channel.kind);
      return <article key={channel.kind} className="notification-card"><header><BrandLogo kind={channel.kind} /><div><strong>{channel.label}</strong><p>{channel.description}</p></div><span className={`target-status ${target?.enabled ? "active" : "inactive"}`}>{target?.enabled ? "Active" : target ? "Paused" : "Not configured"}</span></header>
        {target && <div className="target-controls"><label>Notify at<select value={target.minimumSeverity} onChange={event => void severity(target, event.target.value as Severity)}><option value="info">Info and above</option><option value="warning">Warning and above</option><option value="critical">Critical and emergency</option><option value="emergency">Emergency only</option></select></label><button className="button secondary" onClick={() => void toggle(target)}>{target.enabled ? "Pause" : "Enable"}</button><small>{target.lastDeliveryAt ? `${target.lastDeliveryOk ? "Delivered" : "Failed"} ${relativeTime(target.lastDeliveryAt)}` : "No delivery attempts yet"}</small></div>}
        <NotificationForm channel={channel} token={token} existing={target} disabled={!credentialStorageReady} onSaved={async () => { setSaved(`${channel.label} notification settings saved.`); await load(); }} />
      </article>;
    })}</div>
    {loading && <p className="loading-inline">Loading notification destinations…</p>}
  </section>;
}

function NotificationForm({ channel, token, existing, disabled, onSaved }: { channel: typeof NOTIFICATION_CHANNELS[number]; token: string; existing?: NotificationTarget; disabled: boolean; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [minimumSeverity, setMinimumSeverity] = useState<Severity>(existing?.minimumSeverity ?? (channel.kind === "twilio" ? "critical" : "warning"));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key: string, value: string) => setFields(current => ({ ...current, [key]: value }));
  useEffect(() => { if (!open && existing) setMinimumSeverity(existing.minimumSeverity); }, [existing?.minimumSeverity, open]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const config = channel.kind === "twilio"
        ? { accountSid: fields.accountSid, token: fields.token, from: fields.from, to: fields.to }
        : { url: fields.url };
      await api("/api/targets", token, { method: "POST", body: JSON.stringify({ id: existing?.id, kind: channel.kind, config, enabled: true, minimumSeverity }) });
      setFields({}); setOpen(false); await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <div className="notification-form-wrap"><button className="configure-link" disabled={disabled} onClick={() => setOpen(!open)}>{existing ? "Replace credentials" : "Configure channel"} <Icon name="chevron" /></button>{open && <form className="notification-form" onSubmit={submit}>
    {channel.kind === "twilio" ? <><label>Account SID<input required autoComplete="off" value={fields.accountSid ?? ""} onChange={event => set("accountSid", event.target.value)} placeholder="AC…" /></label><label>Auth token<input required type="password" autoComplete="new-password" value={fields.token ?? ""} onChange={event => set("token", event.target.value)} /></label><div className="field-pair"><label>From number<input required value={fields.from ?? ""} onChange={event => set("from", event.target.value)} placeholder="+15551234567" /></label><label>Destination number<input required value={fields.to ?? ""} onChange={event => set("to", event.target.value)} placeholder="+15557654321" /></label></div></> : <label>{channel.label} webhook URL<input required type="url" autoComplete="off" value={fields.url ?? ""} onChange={event => set("url", event.target.value)} placeholder={channel.kind === "discord" ? "https://discord.com/api/webhooks/…" : "https://hooks.slack.com/services/…"} /></label>}
    <label>Minimum severity<select value={minimumSeverity} onChange={event => setMinimumSeverity(event.target.value as Severity)}><option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option><option value="emergency">Emergency only</option></select></label>
    <p className="secret-note"><Icon name="shield" /> Brolly stores this secret encrypted and never displays it again.</p>{error && <p className="form-error">{error}</p>}<button className="button primary full" disabled={busy}>{busy ? "Encrypting and saving…" : "Save notification channel"}</button>
  </form>}</div>;
}

function SpendSection({ data, preview }: { data: DashboardData; preview: boolean }) {
  const spend = data.spend;
  return <section id="spend" className="spend-card">
    <div className="spend-head"><div><div className="section-label">{preview ? "Example daily spend — not live" : "Current daily spend"}</div><div className="spend-total">{spend.updatedAt ? money(spend.estimatedTotalUsd) : "Waiting for data"}</div><div className="spend-caption">{preview ? "Local or disconnected data is retained only to preview the dashboard." : spend.label}</div></div><div className="estimate-pill">Estimate, not invoice <InfoTip label="How the spend estimate is calculated" align="right" tone="dark"><h4>Operational estimate</h4><p>Brolly prices the latest five-minute Cloudflare analytics window and projects that rate across a day. Every 15 minutes it also requests a direct rolling 24-hour Durable Objects total.</p><p>It is intentionally conservative and does not subtract included usage, credits, discounts, or contract pricing. The once-daily Billing API reconciliation is the authoritative comparison when a Billing Read token is installed.</p>{preview && <p><strong>This screen is not connected.</strong> Values shown here must not be used as a live account total.</p>}</InfoTip></div></div>
    <div className="spend-body"><SpendChart points={spend.history} /><div className="category-panel"><div className="category-title"><span>By category</span><span>Daily estimate</span></div>{spend.categories.length ? spend.categories.map(category => <a key={category.family} href={`#family-${category.family}`} className="category-row"><span><i style={{ background: categoryColor(category.family) }} />{category.label}<small>{category.coverage === "healthy" ? "Live" : "Partial"}</small></span><strong>{money(category.estimatedUsd)}</strong></a>) : <div className="empty-small">The first aggregate spend snapshot will appear after the next scan.</div>}<a className="coverage-link" href="#coverage">See what is and isn’t measured <Icon name="arrow" /></a></div></div>
    <div className="spend-foot"><Icon name="info" /><span>{spend.note}</span><span>{spend.updatedAt ? `Updated ${relativeTime(spend.updatedAt)}` : "Snapshot pending"}</span></div>
  </section>;
}

function SpendChart({ points }: { points: DashboardData["spend"]["history"] }) {
  if (points.length < 2) return <div className="chart-empty"><div className="chart-placeholder"><span /><span /><span /><span /></div><strong>Building today’s trend</strong><p>Brolly stores one bounded aggregate, not another expensive per-object scan.</p></div>;
  const width = 760, height = 230, pad = 18;
  const max = Math.max(...points.map(point => point.totalUsd), 0.01);
  const coordinates = points.map((point, index) => ({ x: pad + index * ((width - pad * 2) / Math.max(1, points.length - 1)), y: height - pad - (point.totalUsd / max) * (height - pad * 2), ...point }));
  const line = coordinates.map(point => `${point.x},${point.y}`).join(" ");
  const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;
  return <div className="chart-wrap"><div className="chart-y"><span>{money(max)}</span><span>{money(max / 2)}</span><span>$0</span></div><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Estimated daily spend trend"><defs><linearGradient id="spend-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f48120" stopOpacity=".34" /><stop offset="1" stopColor="#f48120" stopOpacity="0" /></linearGradient></defs><line x1={pad} x2={width-pad} y1={height/2} y2={height/2} className="chart-gridline" /><polygon points={area} fill="url(#spend-fill)" /><polyline points={line} fill="none" stroke="#f48120" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />{coordinates.map(point => <circle key={point.at} cx={point.x} cy={point.y} r="4" fill="#fff" stroke="#f48120" strokeWidth="3"><title>{dateTime(point.at)} · {money(point.totalUsd)}</title></circle>)}</svg><div className="chart-x"><span>{dateTime(points[0]?.at ?? 0)}</span><span>Now</span></div></div>;
}

function SummaryCard({ href, label, value, detail, tone, icon, onClick }: { href: string; label: string; value: string | number; detail: string; tone: string; icon: IconName; onClick?: () => void }) {
  return <a href={href} className={`summary-card ${tone}`} onClick={onClick}><div className="summary-icon"><Icon name={icon} /></div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div><Icon name="arrow" /></a>;
}

function IncidentSection({ incidents, total, filter, onFilter, onSelect }: { incidents: Incident[]; total: number; filter: "all" | "open" | "acknowledged"; onFilter: (value: "all" | "open" | "acknowledged") => void; onSelect: (incident: Incident) => void }) {
  return <section id="incidents" className="panel-section"><div className="section-heading"><div><p className="eyebrow">Response queue</p><h2 className="heading-with-info">Usage incidents <InfoTip label="What counts as an incident?"><h4>A limit or anomaly needs review</h4><p>Incidents represent observed usage that crossed a configured warning, critical, or emergency boundary. They are separate from connection and telemetry failures.</p><p>Open incidents still need review. Acknowledging an incident removes it from the active queue but does not change limits or stop the resource.</p></InfoTip></h2><p>Spend or activity crossed a limit. Coverage warnings are tracked separately.</p></div><div className="segmented">{(["open", "acknowledged", "all"] as const).map(value => <button key={value} className={filter === value ? "active" : ""} onClick={() => onFilter(value)}>{value === "all" ? `All ${total}` : value}</button>)}</div></div>
    <div className="incident-list">{incidents.length ? incidents.map(incident => <button key={incident.id} className="incident-row" onClick={() => onSelect(incident)}><span className={`severity ${incident.severity}`}><i />{incident.severity}</span><span className="incident-main"><strong>{incident.familyLabel} <b>/</b> {incident.assetName ?? compactId(incident.assetId)}</strong><small>{incident.metricLabel} · {measurement(incident.observed, incident.unit, incident.windowMs)}</small></span><span className="incident-limit"><small>Limit</small><strong>{incident.threshold == null ? "Anomaly" : incident.unit === "usd" ? money(incident.threshold) : number(incident.threshold)}</strong></span><span className="incident-time"><small>Last detected</small><strong>{relativeTime(incident.lastSeen)}</strong></span><span className="review-link">Review <Icon name="arrow" /></span></button>) : <div className="empty-state"><Icon name="check" /><h3>No incidents in this view</h3><p>Coverage gaps still appear in their own section below.</p></div>}</div>
  </section>;
}

function CoverageSection({ data }: { data: DashboardData }) {
  const byFamily = useMemo(() => {
    const map = new Map<string, typeof data.coverage.gaps>();
    for (const item of data.coverage.gaps) map.set(item.family, [...(map.get(item.family) ?? []), item]);
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [data.coverage.gaps]);
  return <section id="coverage" className="panel-section"><div className="section-heading"><div><p className="eyebrow">Telemetry health</p><h2 className="heading-with-info">Coverage gaps <InfoTip label="What is a coverage gap?"><h4>Missing evidence, not excess spend</h4><p>A gap means Brolly lacks a current, trustworthy signal for one billable meter. It does not mean the meter is zero, and it does not count as a usage incident.</p><p><strong>Permission needed</strong> means Cloudflare rejected the credential or account scope. <strong>Collector pending</strong> means the product is cataloged but Brolly does not yet have a reliable fast collector for that meter.</p></InfoTip></h2><p>These are not spend incidents. They mean Brolly cannot yet make a trustworthy claim for that metric.</p></div><span className="count-badge warning">{data.summary.coverageGaps} gaps</span></div>
    <div className="coverage-grid">{byFamily.map(([family, items]) => <details key={family} className="coverage-family"><summary><ProductIcon family={family} /><span><strong>{data.assets.families.find(item => item.family === family)?.label ?? metricTitle(family)}</strong><small>{items.length} metric{items.length === 1 ? "" : "s"} not fully covered</small></span><span className={`coverage-state ${items.some(item => item.state === "permission_denied") ? "denied" : "pending"}`}>{items.some(item => item.state === "permission_denied") ? "Permission needed" : "Collector pending"}</span><Icon name="chevron" /></summary><div className="coverage-details">{items.map(item => { const guidance = coverageGuidance(item); return <div key={`${item.family}:${item.metric}`}><span><strong>{metricTitle(item.metric)}</strong><small>{guidance.summary}</small>{guidance.fix && <small className="coverage-fix"><b>How to fix:</b> {guidance.fix}</small>}</span><time>{relativeTime(item.checkedAt)}</time></div>; })}</div></details>)}</div>
  </section>;
}

function AssetsSection({ data }: { data: DashboardData }) {
  return <section id="assets" className="panel-section"><div className="section-heading"><div><p className="eyebrow">Inventory</p><h2 className="heading-with-info">Cloudflare assets <InfoTip label="How does asset inventory work?"><h4>One bounded account inventory</h4><p>Brolly asks Cloudflare's control-plane APIs for resource lists; it does not invoke every Worker or wake individual Durable Objects.</p><p>The number is a discovered resource count, not billable usage. Open a product card to inspect the authoritative resource in Cloudflare.</p></InfoTip></h2><p>Every discovered resource, organized by product family.</p></div><span className="count-badge">{data.summary.assets} assets</span></div><div className="asset-grid">{data.assets.families.map(family => <a id={`family-${family.family}`} key={family.family} className="asset-card" href={family.cloudflareUrl} target="_blank" rel="noreferrer"><ProductIcon family={family.family} orange /><div><strong>{family.label}</strong><small>{family.gaps ? `${family.gaps} coverage gaps` : "Telemetry healthy"}</small></div><b>{family.assets}</b><Icon name="external" /></a>)}</div></section>;
}

function ActionsSection({ data, token, onRefresh }: { data: DashboardData; token: string; onRefresh: () => Promise<DashboardData> }) {
  const [selected, setSelected] = useState<DashboardData["actions"][number] | null>(null);
  const incident = selected ? data.incidents.find(item => item.id === selected.incidentId) ?? null : null;
  return <section id="controls" className="panel-section"><div className="section-heading"><div><p className="eyebrow">Reversible controls</p><h2 className="heading-with-info">Recent actions <InfoTip label="What is recorded here?"><h4>Every stage of enforcement</h4><p>Prepared means Brolly computed a safe action but has not changed service. Succeeded means the stop was applied. Rolled back means the stored pre-change configuration was restored. Failed actions retain their error and audit record.</p></InfoTip></h2><p>Open an action to inspect its impact, execute a prepared control, or restore service.</p></div><span className={`mode-pill ${data.policy.mode}`}>{data.policy.mode} mode</span></div>{data.actions.length ? <div className="action-list">{data.actions.map(action => <button type="button" key={action.id} className="action-row" onClick={() => setSelected(action)}><span className={`action-state ${action.state}`}>{action.state}</span><span><strong>{metricTitle(action.kind)}</strong><small>{action.family} / {compactId(action.assetId)}</small></span><time>{relativeTime(action.updatedAt)}</time><span className="review-link">Review <Icon name="arrow" /></span></button>)}</div> : <div className="empty-state compact"><Icon name="shield" /><h3>No control actions yet</h3><p>Emergency incidents can prepare reversible actions after the asset is classified.</p></div>}{selected && <ActionDrawer action={selected} incident={incident} token={token} onClose={() => setSelected(null)} onChanged={async () => { const next = await onRefresh(); setSelected(next.actions.find(item => item.id === selected.id) ?? null); }} />}</section>;
}

function ActionDrawer({ action, incident, token, onClose, onChanged }: { action: DashboardData["actions"][number]; incident: Incident | null; token: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const stopped = action.state === "succeeded";
  const canExecute = action.state === "prepared";
  const canRestore = action.state === "succeeded" || action.state === "failed";

  async function run(kind: "execute" | "resume") {
    const restoring = kind === "resume";
    const warning = restoring
      ? `Restore service for ${metricTitle(action.kind)}?\n\nBrolly will use the rollback state saved before this action. For a Durable Object, this clears quarantine and allows work to run again.`
      : `Execute this prepared ${metricTitle(action.kind)} control now?\n\nThis changes live service. Brolly will retain the rollback snapshot so the action can be reversed.`;
    if (!window.confirm(warning)) return;
    setBusy(kind); setError("");
    try { await api(`/api/actions/${encodeURIComponent(action.id)}/${kind}`, token, { method: "POST", body: JSON.stringify({}) }); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  }

  return <div className="drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><aside className="drawer action-drawer"><header><div><span className={`action-state ${action.state}`}>{action.state}</span><h2>{metricTitle(action.kind)}</h2><p>{incident?.assetName ?? compactId(action.assetId)}</p></div><button className="icon-button" aria-label="Close action details" onClick={onClose}>×</button></header><div className="drawer-body">
    <section className={`action-status-card ${stopped ? "stopped" : action.state}`}><Icon name={stopped ? "alert" : action.state === "rolled_back" ? "check" : "shield"} /><div><span>Current control state</span><strong>{actionStateTitle(action.state)}</strong><p>{actionStateDescription(action.state)}</p></div></section>
    <section className="detail-block"><h3>Action details</h3><p>{action.reason}</p><dl><div><dt>Action ID</dt><dd><code>{action.id}</code></dd></div><div><dt>Target</dt><dd><code>{action.family}/{action.assetId}</code></dd></div><div><dt>Prepared</dt><dd>{dateTime(action.createdAt)}</dd></div><div><dt>Last changed</dt><dd>{dateTime(action.updatedAt)}</dd></div>{action.error && <div><dt>Last error</dt><dd className="error-text">{action.error}</dd></div>}</dl>{incident && <a className="button secondary full" href={incident.cloudflareUrl} target="_blank" rel="noreferrer">Open target in Cloudflare <Icon name="external" /></a>}</section>
    {action.kind === "runtime_quarantine" && <section className="detail-block"><ObjectStopImpact compact /></section>}
    <section className="detail-block"><h3>Available control</h3>{canExecute && <><p>This action is only prepared. No live service change has happened yet.</p><button className="button danger full" disabled={Boolean(busy)} onClick={() => void run("execute")}>{busy === "execute" ? "Stopping…" : "Approve and stop service"}</button></>}{canRestore && <><p>{action.state === "failed" ? "The previous operation failed. A rollback can still restore any state that changed before the failure." : "This control is active. Restore the pre-action configuration to return the resource to service."}</p><button className="button primary full" disabled={Boolean(busy)} onClick={() => void run("resume")}>{busy === "resume" ? "Restoring…" : action.kind === "runtime_quarantine" ? "Un-jail and resume object" : "Restore service from rollback"}</button></>}{!canExecute && !canRestore && <p>No operator action is needed. This control has already been rolled back or is currently changing state.</p>}</section>
    {error && <p className="form-error">{error}</p>}
  </div><footer><button className="button secondary" onClick={onClose}>Done</button></footer></aside></div>;
}

function IncidentDrawer({ incident, token, onClose, onChanged }: { incident: Incident; token: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const [tier, setTier] = useState<AssetTier>(incident.tier);
  const [runtimeUrl, setRuntimeUrl] = useState(incident.tags.runtimeUrl ?? "");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function act(label: string, callback: () => Promise<unknown>) { setBusy(label); setError(""); try { await callback(); await onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(""); } }
  async function classify() {
    await act("classify", () => api(`/api/assets/${encodeURIComponent(incident.family)}/${encodeURIComponent(incident.assetId)}`, token, { method: "PATCH", body: JSON.stringify({ tier, tags: runtimeUrl ? { runtimeUrl } : {} }) }));
  }
  async function prepare() {
    await act("prepare", async () => {
      if (tier !== incident.tier || runtimeUrl !== (incident.tags.runtimeUrl ?? "")) {
        await api(`/api/assets/${encodeURIComponent(incident.family)}/${encodeURIComponent(incident.assetId)}`, token, { method: "PATCH", body: JSON.stringify({ tier, tags: runtimeUrl ? { runtimeUrl } : {} }) });
      }
      return api("/api/actions", token, { method: "POST", body: JSON.stringify({ incidentId: incident.id, runtimeUrl: runtimeUrl || undefined }) });
    });
  }
  async function execute() {
    const warning = incident.family === "durable_objects"
      ? "Quarantine this exact Durable Object now?\n\nIts active execution will be aborted, its alarm removed, and new work will return HTTP 423 until you resume it. Stored data is preserved and other objects are unaffected."
      : "Stop this asset now? Service traffic may be interrupted. The rollback state is stored and the action will be audited.";
    if (!incident.action || !window.confirm(warning)) return;
    await act("execute", () => api(`/api/actions/${incident.action!.id}/execute`, token, { method: "POST", body: JSON.stringify({ runtimeUrl: runtimeUrl || undefined }) }));
  }
  async function resume() {
    if (!incident.action || !window.confirm("Resume this asset using the stored rollback state?")) return;
    await act("resume", () => api(`/api/actions/${incident.action!.id}/resume`, token, { method: "POST", body: JSON.stringify({ runtimeUrl: runtimeUrl || undefined }) }));
  }
  const supported = ["durable_objects", "workers", "queues"].includes(incident.family);
  const runtimeRequired = incident.family === "durable_objects";
  const classified = tier === "standard" || tier === "disposable";
  return <div className="drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><aside className="drawer"><header><div><span className={`severity ${incident.severity}`}><i />{incident.severity}</span><h2>{incident.metricLabel}</h2><p>{incident.familyLabel} / {incident.assetName ?? compactId(incident.assetId)}</p></div><button className="icon-button" onClick={onClose}>×</button></header><div className="drawer-body">
    <section className="measurement-card"><span>Detected activity</span><strong>{measurement(incident.observed, incident.unit, incident.windowMs)}</strong><div><span>Emergency threshold</span><b>{incident.threshold == null ? "Dynamic anomaly" : measurement(incident.threshold, incident.unit, incident.windowMs)}</b></div></section>
    <section className="detail-block"><h3>What happened</h3><p>{incident.reason}</p><dl><div><dt>First detected</dt><dd>{dateTime(incident.firstSeen)}</dd></div><div><dt>Last detected</dt><dd>{dateTime(incident.lastSeen)}</dd></div><div><dt>Occurrences</dt><dd>{incident.occurrences}</dd></div><div><dt>Object ID</dt><dd><code>{incident.assetId}</code></dd></div>{incident.parentId && <div><dt>Namespace</dt><dd><code>{incident.parentId}</code></dd></div>}</dl><a className="button secondary full" href={incident.cloudflareUrl} target="_blank" rel="noreferrer">Open in Cloudflare <Icon name="external" /></a></section>
    <section className="detail-block"><h3>Response controls</h3><p>Classification prevents control-plane or critical assets from being stopped accidentally.</p>{runtimeRequired && <ObjectStopImpact compact />}<label>Asset protection tier<select value={tier} onChange={event => setTier(event.target.value as AssetTier)}><option value="unclassified">Unclassified — alert only</option><option value="critical">Critical — alert only</option><option value="standard">Standard — allow approved stop</option><option value="disposable">Disposable — allow approved stop</option><option value="control_plane">Control plane — never stop</option></select></label>{runtimeRequired && <label>Signed runtime control URL<input type="url" value={runtimeUrl} onChange={event => setRuntimeUrl(event.target.value)} placeholder="https://instance.example.com" /><small>Brolly calls this Worker endpoint; the Worker verifies the signed command and routes it to this exact object ID.</small></label>}<button className="button secondary full" disabled={busy === "classify"} onClick={() => void classify()}>{busy === "classify" ? "Saving…" : "Save classification"}</button>
      {supported && incident.severity === "emergency" && <div className="control-zone"><div><Icon name="shield" /><span><strong>Emergency control</strong><small>{dataActionText(incident)}</small></span></div>{!incident.action && <button className="button primary full" disabled={!classified || (runtimeRequired && !runtimeUrl) || Boolean(busy)} onClick={() => void prepare()}>{busy === "prepare" ? "Preparing…" : "Prepare reversible stop"}</button>}{incident.action?.state === "prepared" && <button className="button danger full" disabled={Boolean(busy)} onClick={() => void execute()}>{busy === "execute" ? "Executing…" : "Approve and stop"}</button>}{["succeeded", "failed"].includes(incident.action?.state ?? "") && <button className="button primary full" disabled={Boolean(busy)} onClick={() => void resume()}>{busy === "resume" ? "Resuming…" : "Resume from rollback"}</button>}</div>}
    </section>
    {error && <p className="form-error">{error}</p>}
  </div><footer><button className="button quiet" disabled={incident.status === "acknowledged" || Boolean(busy)} onClick={() => void act("ack", () => api(`/api/incidents/${incident.id}/ack`, token, { method: "POST" }))}>{incident.status === "acknowledged" ? "Acknowledged" : "Acknowledge incident"}</button><button className="button secondary" onClick={onClose}>Done</button></footer></aside></div>;
}

function ProductIcon({ family, orange = false }: { family: string; orange?: boolean }) {
  const icon = PRODUCT_ICON[family] ?? "dns";
  return <span className={`product-mark product-icon ${orange ? "orange" : ""}`} style={{ "--product-icon": `url(/cloudflare-icons/${icon}.svg)` } as React.CSSProperties} aria-hidden="true" />;
}

function BrandLogo({ kind }: { kind: NotificationKind }) {
  return <span className={`channel-mark ${kind}`} aria-hidden="true"><span className="brand-glyph" style={{ "--brand-icon": `url(/brand-icons/${kind}.svg)` } as React.CSSProperties} /></span>;
}

function Brand({ large = false }: { large?: boolean }) { return <a className={`brand ${large ? "large" : ""}`} href="/" aria-label="Brolly home"><span className="brand-mark"><Umbrella /></span><span>Brolly</span></a>; }

function ScanInfoTip() {
  return <InfoTip label="What does an account scan do?" align="right"><h4>What Brolly scans</h4><p>It inventories Workers, Durable Object namespaces, Queues, D1, R2, KV, Vectorize, Hyperdrive, Pages, AI Gateway, and zones, then asks Cloudflare Analytics for aggregate five-minute Durable Object and Worker usage.</p><h4>Cadence</h4><p>The same bounded monitor runs automatically every minute. Every 15 minutes it adds one rolling-24-hour Durable Objects query. Once daily it reconciles the Billing API when a Billing Read token is configured.</p><h4>Cost and safety</h4><p>A typical one-page account uses about 13 Cloudflare API requests per pass, plus one every 15 minutes and one for the daily billing read. It does <strong>not</strong> wake every Durable Object or read customer-object SQLite rows.</p><p>Brolly's own Worker invocation, CPU, and D1 operations remain billable under your plan. Each pass hard-stops at 150 Cloudflare API calls, 25,000 Brolly D1 row operations, 20,000 samples, or 45 seconds. These are workload caps, not a guaranteed dollar cap.</p></InfoTip>;
}

function InfoTip({ label, align = "left", tone = "light", children }: { label: string; align?: "left" | "right"; tone?: "light" | "dark"; children: React.ReactNode }) {
  return <span className={`info-tip ${align} ${tone}`}><button type="button" className="info-tip-trigger" aria-label={label}>i</button><span className="info-tip-panel" role="tooltip">{children}</span></span>;
}

function coverageGuidance(item: DashboardData["coverage"]["gaps"][number]): { summary: string; fix?: string } {
  const raw = item.detail?.trim() ?? "";
  const parsed = parseProviderError(raw);
  if (parsed.code === 7003 || /could not route/i.test(parsed.message)) {
    return { summary: "Cloudflare could not route this account inventory request.", fix: "Verify BROLLY_ACCOUNT_ID and reinstall Brolly into that same Cloudflare account." };
  }
  if (parsed.code === 9106 || /authentication failed/i.test(parsed.message)) {
    return { summary: "Cloudflare rejected Brolly's API credentials.", fix: "Reconnect the Cloudflare account or replace the expired/revoked token, then run an account scan." };
  }
  if (item.state === "permission_denied") {
    return { summary: parsed.message || "Brolly does not have permission to read this billing signal.", fix: "Grant the required account-read/analytics permission, then run an account scan." };
  }
  if (/no active fast-telemetry collector/i.test(parsed.message)) {
    return { summary: "No reliable fast telemetry collector is connected for this meter yet.", fix: "Keep the budget configured; enforcement activates when this collector is added. Use the daily billing reconciliation as the account-level backstop." };
  }
  if (parsed.message) return { summary: parsed.message, fix: item.state === "unavailable" ? "Check the Cloudflare account connection and retry the scan." : undefined };
  return { summary: item.state === "delayed" ? "Cloudflare returned a bounded or delayed result." : "Telemetry is currently unavailable.", fix: "Run an account scan again; if this persists, check the account connection and collector coverage." };
}

function connectionHealth(data: DashboardData): ConnectionHealth {
  const placeholder = /REPLACE_DURING_INSTALL|placeholder/i.test(data.account.id);
  const providerFailures = data.coverage.gaps.map(item => parseProviderError(item.detail ?? ""))
    .filter(item => item.code === 7003 || item.code === 9106 || /authentication failed|could not route/i.test(item.message));
  const errors = providerFailures.map(item => item.message).filter(Boolean);
  if (placeholder) return {
    kind: "local", label: "Local preview — Cloudflare not connected", title: "Local preview — no Cloudflare account connected",
    detail: "This local instance uses a placeholder account ID and sample state. Scans cannot read live inventory or usage until Brolly is installed into an account with valid Cloudflare credentials.", errors,
  };
  if (providerFailures.length > 0) return {
    kind: "disconnected", label: "Cloudflare connection needs attention", title: "Brolly cannot read this Cloudflare account",
    detail: "The account ID or credential was rejected. Live spend, inventory, incident detection, and shutdown actions may be incomplete until the connection is repaired.", errors,
  };
  return { kind: "connected", label: "Cloudflare connected", title: "Cloudflare telemetry is connected", detail: "Brolly can reach the configured account. Individual meter coverage may still be partial; review Coverage gaps below.", errors: [] };
}

function parseProviderError(raw: string): { code?: number; message: string } {
  if (!raw) return { message: "" };
  try {
    const value = JSON.parse(raw) as { errors?: Array<{ code?: number; message?: string }>; message?: string };
    const first = value.errors?.[0];
    return { code: first?.code, message: first?.message ?? value.message ?? "Cloudflare returned an unspecified API error." };
  } catch {
    const code = raw.match(/"code"\s*:\s*(\d+)/)?.[1];
    const message = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
    return { code: code ? Number(code) : undefined, message: message ?? raw.replace(/^Error:\s*/i, "") };
  }
}

function Umbrella() { return <svg viewBox="0 0 40 40" aria-hidden="true"><path d="M4 20a16 16 0 0 1 32 0c-3.5-2.5-7.2-2.5-10.8 0-3.4-2.5-7-2.5-10.4 0C11.2 17.5 7.6 17.5 4 20Z" fill="currentColor"/><path d="M20 7v23.5c0 3.6 5.5 3.6 5.5 0" fill="none" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round"/></svg>; }
type IconName = "alert" | "arrow" | "check" | "chevron" | "external" | "gauge" | "info" | "layers" | "radar" | "refresh" | "shield" | "sliders";
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    alert: <><path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4M12 17h.01"/></>, arrow: <path d="m9 5 7 7-7 7"/>, check: <path d="m5 12 4 4L19 6"/>, chevron: <path d="m6 9 6 6 6-6"/>, external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/></>, gauge: <><path d="M4 17a8 8 0 1 1 16 0"/><path d="m12 17 4-6"/></>, info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>, layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></>, radar: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="m12 12 6-6"/></>, refresh: <><path d="M20 11a8 8 0 1 0-2 6"/><path d="M20 4v7h-7"/></>, shield: <><path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-5"/></>, sliders: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></>,
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function LoadingScreen() { return <main className="loading-screen"><Brand large /><div className="loader"><span /><span /><span /></div><p>Opening the umbrella…</p></main>; }
function preparePolicy(policy: Policy, families: string[], scopedAssets: OnboardingData["scopedAssets"]): Policy {
  const next = structuredClone(policy);
  next.familyDailySpend ??= {};
  next.assetDailySpend ??= {};
  for (const family of families) next.familyDailySpend[family] ??= { warning: 1, critical: 5, emergency: 10 };
  for (const asset of scopedAssets) next.assetDailySpend[asset.key] ??= { ...(next.familyDailySpend[asset.family] ?? { warning: 1, critical: 5, emergency: 10 }) };
  for (const row of LIMIT_ROWS) next.thresholds = replaceThreshold(next.thresholds, findThreshold(next, row.metric, row.windowMs, row.defaults));
  return next;
}
function findThreshold(policy: Policy, metric: string, windowMs: number, defaults: readonly number[]): Threshold {
  const existing = policy.thresholds.find(item => item.metric === metric && item.windowMs === windowMs);
  return {
    ...existing, metric, windowMs,
    warning: existing?.warning ?? defaults[0],
    critical: existing?.critical ?? defaults[1],
    emergency: existing?.emergency ?? defaults[2],
  };
}
function replaceThreshold(thresholds: Threshold[], next: Threshold): Threshold[] { const found = thresholds.some(item => item.metric === next.metric && item.windowMs === next.windowMs); return found ? thresholds.map(item => item.metric === next.metric && item.windowMs === next.windowMs ? next : item) : [...thresholds, next]; }
function compactId(value: string): string { return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
function shortId(value: string): string { return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value; }
function categoryColor(family: string): string { const colors: Record<string, string> = { durable_objects: "#f48120", workers: "#f5a623", r2: "#6b7c93", d1: "#2f80ed", kv: "#27ae60", workers_ai: "#9b51e0" }; return colors[family] ?? "#7b8794"; }
function dataActionText(incident: Incident): string { if (incident.family === "durable_objects") return "Quarantine this exact object ID through its signed runtime."; if (incident.family === "queues") return "Pause the queue consumer and retain rollback state."; return "Disable the Worker trigger and retain rollback state."; }
function actionStateTitle(state: string): string {
  const titles: Record<string, string> = { prepared: "Ready for approval", approved: "Stop approved", running: "Change in progress", succeeded: "Service is stopped", failed: "Control needs attention", rolled_back: "Service restored" };
  return titles[state] ?? metricTitle(state);
}
function actionStateDescription(state: string): string {
  const descriptions: Record<string, string> = {
    prepared: "Brolly saved the requested action, but has not changed live service.",
    approved: "The operator approved the stop and Brolly is beginning the change.",
    running: "Brolly is applying or rolling back the control. Refresh before taking another action.",
    succeeded: "The stop completed and its rollback snapshot is available.",
    failed: "The last operation did not complete. Review the error and use rollback if any live state may have changed.",
    rolled_back: "Brolly restored the saved pre-action state and completed the rollback.",
  };
  return descriptions[state] ?? "Review the audit state before making another change.";
}
