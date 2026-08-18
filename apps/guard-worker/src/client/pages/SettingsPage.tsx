import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { NotificationSection } from "../components/notifications";
import { ControlCapabilities, RuntimeInstallGuide } from "../components/protection";
import { Button, Icon, Input, Notice, Panel, PanelHead } from "../components/ui";
import { money } from "../format";
import type { ConnectionHealth } from "../lib/health";
import { billingTokenTemplateUrl } from "../lib/billing";
import type { Route } from "../router";
import type { BillingAccessStatus, DashboardData, ReleaseStatus } from "../types";

/** Auto-fitting grid of small labelled facts under a settings panel head. */
function FactGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-2.5 px-5 pt-1 pb-4">{children}</div>;
}

/** One labelled fact: uppercase label, prominent value, explanatory note. */
function Fact({ label, value, mono = false, note, children }: {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  note: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article className="flex flex-col gap-1 rounded-field border border-line px-[15px] py-[13px]">
      <span className="text-[11.5px] font-[680] uppercase tracking-[.05em] text-muted">{label}</span>
      <strong className={mono ? "font-mono text-[12.5px] break-words" : "text-[15px] break-words"}>{value}</strong>
      <small className="text-[12px] leading-[1.45] text-faint">{note}</small>
      {children}
    </article>
  );
}

function spendSummary(limits: DashboardData["policy"]["accountDailySpend"], levels: DashboardData["alertLevels"]): string {
  const ordered = levels?.length
    ? levels
    : Object.keys(limits).map((id, position) => ({ id, label: id, position, entries: [] }));
  return ordered.map(level => `${level.label}: ${money(limits[level.id] ?? 0)}`).join(" · ");
}

/** Button-styled anchor (auto width) for links that open in a new tab. */
function ActionLink({ href, variant = "secondary", className = "", children }: {
  href: string;
  variant?: "primary" | "secondary";
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      className={`inline-flex min-h-9 cursor-pointer items-center justify-center gap-[7px] rounded-field border px-3.5 text-[13.5px] font-[620] transition-[background-color,border-color,box-shadow] duration-[130ms] [&>svg]:size-4 ${
        variant === "primary"
          ? "border-orange bg-orange text-white hover:border-orange-hover hover:bg-orange-hover"
          : "border-line-strong bg-panel text-ink hover:border-faint hover:bg-panel-soft dark:hover:bg-[#252a31]"
      } ${className}`}
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  );
}

export function SettingsPage({ data, connection, token, onNavigate, onBudgets, onLogout, release, onReleaseRefresh }: {
  data: DashboardData;
  connection: ConnectionHealth;
  token: string;
  onNavigate: (route: Route) => void;
  onBudgets: () => void;
  onLogout: () => void;
  release: ReleaseStatus | null;
  onReleaseRefresh: () => void;
}) {
  const [repository, setRepository] = useState(release?.repository ?? "");
  const [savingRepository, setSavingRepository] = useState(false);
  const [repositoryMessage, setRepositoryMessage] = useState("");
  const [repositoryError, setRepositoryError] = useState("");

  useEffect(() => setRepository(release?.repository ?? ""), [release?.repository]);

  async function saveRepository() {
    setSavingRepository(true);
    setRepositoryError("");
    setRepositoryMessage("");
    try {
      await api("/api/update-settings", token, { method: "PUT", body: JSON.stringify({ repository }) });
      setRepositoryMessage(repository.trim() ? "Update repository saved." : "Update repository cleared.");
      onReleaseRefresh();
    } catch (cause) {
      setRepositoryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingRepository(false);
    }
  }

  return (
    <>
      <Panel aria-label="Budgets and enforcement">
        <PanelHead
          title="Budgets & enforcement"
          sub="The audited policy the minute monitor evaluates on every pass."
          actions={<Button variant="primary" onClick={onBudgets}><Icon name="wallet" /> Edit budgets</Button>}
        />
        <FactGrid>
          <Fact
            label="Account daily limits"
            value={spendSummary(data.policy.accountDailySpend, data.alertLevels)}
            note="Per-level spend limits per rolling day"
          />
          <Fact
            label="Scoped budgets"
            value={Object.keys(data.policy.assetDailySpend).length}
            note="Per-Worker and per-namespace limits that override product defaults"
          />
          <Fact
            label="Policy version"
            value={data.policy.version}
            mono
            note="Every change is audited and used by the next monitor pass"
          />
        </FactGrid>
      </Panel>

      <BillingAccessSection accountId={data.account.id} token={token} />

      <NotificationSection token={token} />

      <Panel aria-label="Brolly updates">
        <PanelHead
          eyebrow="Updates"
          title="Review new Brolly releases"
          sub="While this dashboard is open, Brolly checks for a release at most once an hour. It never updates or deploys itself."
          actions={release?.updateUrl && (
            <ActionLink href={release.updateUrl}><Icon name="external" /> Open updater</ActionLink>
          )}
        />
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(320px,.9fr)] gap-6 px-5 pt-0.5 pb-[18px] max-md:grid-cols-[minmax(0,1fr)]">
          <div>
            <strong className="text-[14px]">{!release ? "Checking release status…" : release.error && !release.latestRelease ? "Release status unavailable" : release.available ? `${release.displayVersion ?? "A new release"} is available` : "This installation is current"}</strong>
            <p className="mt-[5px] text-[12.5px] leading-[1.55] text-muted">Save the GitHub repository created by Deploy to Cloudflare. When an update appears, Brolly links you to its manual updater workflow. The workflow opens a pull request for review; your D1 binding, secrets, and Worker settings stay untouched.</p>
            <p className="mt-[5px] text-[12.5px] leading-[1.55] text-muted"><strong>Private repository?</strong> That works normally. Brolly stores only this repository name—never a GitHub token. GitHub checks your access when you open the updater.</p>
          </div>
          <form className="flex flex-col gap-1.5" onSubmit={event => { event.preventDefault(); void saveRepository(); }}>
            <label className="text-[11.5px] font-[720] uppercase tracking-[.05em] text-muted" htmlFor="update-repository">Installation repository</label>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <Input className="min-h-[38px] min-w-0 text-[13px]" id="update-repository" value={repository} onChange={event => setRepository(event.target.value)} placeholder="owner/brolly-guard" autoComplete="off" spellCheck={false} />
              <Button type="submit" variant="primary" disabled={savingRepository}>{savingRepository ? "Saving…" : "Save"}</Button>
            </div>
            <small className="text-[11.5px] text-faint">Use the owner/repository name shown in GitHub. Clear it to disable update links.</small>
            {repositoryError && <Notice tone="error" className="mt-1 text-[12px]">{repositoryError}</Notice>}
            {repositoryMessage && <Notice tone="success" className="mt-1 text-[12px]" role="status">{repositoryMessage}</Notice>}
            {release?.error && <p className="mt-1 text-[12px] text-warn">The last release check could not finish: {release.error}</p>}
          </form>
        </div>
      </Panel>

      <Panel aria-label="Runtime integration">
        <PanelHead
          eyebrow="Runtime integration"
          title="Install the shutdown fuse"
          sub="Required for precise, zero-hot-path-I/O Worker and Durable Object quarantine. Verify each install on the Configuration page afterwards."
          actions={<Button onClick={() => onNavigate("configuration")}>Verify installs</Button>}
        />
        <div className="px-5 pt-1 pb-4">
          <RuntimeInstallGuide />
        </div>
      </Panel>

      <ControlCapabilities />

      <Panel aria-label="Account">
        <PanelHead title="Account" sub="This Brolly instance and your browser session." />
        <FactGrid>
          <Fact
            label="Cloudflare account"
            value={connection.kind === "local" ? "Not connected (local preview)" : data.account.id}
            note={connection.label}
          />
          <Fact
            label="Timezone"
            value={data.account.timezone}
            note="Used for the daily summary schedule"
          />
          <Fact
            label="Browser session"
            value="Cloudflare sign-in active"
            note="A hashed, 12-hour HttpOnly session cookie authenticates this browser; no admin token is stored in browser storage."
          >
            <Button className="mt-2 w-max" onClick={onLogout}><Icon name="logout" /> Sign out</Button>
          </Fact>
        </FactGrid>
      </Panel>
    </>
  );
}

function BillingAccessSection({ accountId, token }: { accountId: string; token: string }) {
  const [status, setStatus] = useState<BillingAccessStatus | null>(null);
  const [billingToken, setBillingToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const templateUrl = billingTokenTemplateUrl(accountId);

  async function load() {
    setError("");
    try {
      setStatus(await api<BillingAccessStatus>("/api/billing-access", token));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => { void load(); }, [token]);

  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/api/billing-access", token, { method: "PUT", body: JSON.stringify({ token: billingToken }) });
      setBillingToken("");
      setMessage(status?.configured ? "Replacement Billing Read token verified and saved." : "Billing Read access verified and saved.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const configured = status?.configured === true;
  const managedAsWorkerSecret = status?.source === "worker_secret";
  return (
    <Panel aria-label="Billing API access">
      <PanelHead
        eyebrow="Usage coverage"
        title="Daily billing access"
        sub="Highly recommended. Billing Read gives Brolly exact account-wide charges and greatly improves protection beyond fast service telemetry."
        actions={
          <span className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs font-bold ${configured ? "bg-good-bg text-good" : "bg-warn-bg text-warn"}`}>
            <span className="size-2 rounded-full bg-current" />{status ? configured ? "Connected" : "Setup needed" : "Checking…"}
          </span>
        }
      />

      <div className="mt-4 grid gap-4 rounded-field border border-line bg-panel-soft p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div>
          <strong className="text-sm">{configured ? "Generate a replacement whenever you need one" : "Add Billing Read access"}</strong>
          <p className="mt-1 max-w-[76ch] text-xs leading-5 text-muted">Cloudflare opens a prefilled user API-token form with Billing → Read and only this account selected. Create it, copy the token Cloudflare shows once, then verify it below.</p>
          {configured && <p className="mt-2 text-xs leading-5 text-muted">The current credential is {managedAsWorkerSecret ? "managed as the CLOUDFLARE_BILLING_TOKEN Worker secret. Create a replacement here, then replace that secret in Cloudflare" : `encrypted in this installation's D1${status?.updatedAt ? ` and was saved ${new Date(status.updatedAt).toLocaleString()}` : ""}. Saving another verified token replaces it`}.</p>}
        </div>
        <ActionLink href={templateUrl} variant="primary" className="shrink-0"><Icon name="external" /> {configured ? "Create replacement token" : "Create billing token"}</ActionLink>
      </div>

      <form className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label className="sr-only" htmlFor="settings-billing-token">Paste the new Cloudflare user API token</label>
        <Input id="settings-billing-token" className="min-w-0 px-3 text-sm" type="password" value={billingToken} onChange={event => setBillingToken(event.target.value)} autoComplete="off" spellCheck={false} disabled={managedAsWorkerSecret} placeholder={managedAsWorkerSecret ? "Replace the Worker secret in Cloudflare" : configured ? "Paste a replacement cfut_ token" : "Paste the cfut_ token Cloudflare shows"} />
        <Button type="submit" variant="primary" disabled={managedAsWorkerSecret || busy || !billingToken.trim()}><Icon name="check" /> {managedAsWorkerSecret ? "Managed in Cloudflare" : busy ? "Verifying…" : configured ? "Verify and replace" : "Verify and save"}</Button>
      </form>
      <p className="mt-2 text-xs leading-5 text-faint">Brolly verifies the token against Cloudflare before saving it, encrypts it at rest, and never displays it again.</p>
      {error && <Notice tone="error" className="mt-3"><strong>Billing access failed.</strong> {error}</Notice>}
      {message && <Notice tone="success" className="mt-3" role="status">{message}</Notice>}
    </Panel>
  );
}
