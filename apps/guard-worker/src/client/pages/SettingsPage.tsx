import { NotificationSection } from "../components/notifications";
import { ControlCapabilities, RuntimeInstallGuide } from "../components/protection";
import { Icon } from "../components/ui";
import { money } from "../format";
import type { ConnectionHealth } from "../lib/health";
import type { Route } from "../router";
import type { DashboardData, ReleaseStatus } from "../types";

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
      <section className="panel" aria-label="Budgets and enforcement">
        <div className="panel-head">
          <div>
            <h2>Budgets & enforcement</h2>
            <p className="panel-sub">The audited policy the minute monitor evaluates on every pass.</p>
          </div>
          <button type="button" className="button primary" onClick={onBudgets}><Icon name="wallet" /> Edit budgets</button>
        </div>
        <div className="settings-facts">
          <article>
            <span>Account daily limits</span>
            <strong>{money(data.policy.accountDailySpend.warning)} / {money(data.policy.accountDailySpend.critical)} / {money(data.policy.accountDailySpend.emergency)}</strong>
            <small>Warning / critical / emergency per rolling day</small>
          </article>
          <article>
            <span>Control mode</span>
            <strong>{data.policy.mode === "observe" ? "Observe" : data.policy.mode === "approval" ? "Approval" : "Automatic"}</strong>
            <small>
              {data.policy.mode === "observe" && "Brolly records incidents and alerts, but never prepares or executes a stop."}
              {data.policy.mode === "approval" && "Stops require explicit operator approval; nothing is stopped automatically."}
              {data.policy.mode === "automatic" && "Standard/disposable assets with a tested fuse can be quarantined at an emergency threshold. Recovery stays manual."}
            </small>
          </article>
          <article>
            <span>Scoped budgets</span>
            <strong>{Object.keys(data.policy.assetDailySpend).length}</strong>
            <small>Per-Worker and per-namespace limits that override product defaults</small>
          </article>
          <article>
            <span>Policy version</span>
            <strong className="settings-version">{data.policy.version}</strong>
            <small>Every change is audited and used by the next monitor pass</small>
          </article>
        </div>
      </section>

      <NotificationSection token={token} />

      <section className="panel" aria-label="Brolly updates">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Updates</p>
            <h2>Review new Brolly releases</h2>
            <p className="panel-sub">While this dashboard is open, Brolly checks for a release at most once an hour. It never updates or deploys itself.</p>
          </div>
          {release?.updateUrl && <a className="button secondary" href={release.updateUrl} target="_blank" rel="noreferrer"><Icon name="external" /> Open updater</a>}
        </div>
        <div className="update-settings">
          <div className="update-settings-copy">
            <strong>{!release ? "Checking release status…" : release.error && !release.latestRelease ? "Release status unavailable" : release.available ? `${release.displayVersion ?? "A new release"} is available` : "This installation is current"}</strong>
            <p>Save the GitHub repository created by Deploy to Cloudflare. When an update appears, Brolly links you to its manual updater workflow. The workflow opens a pull request for review; your D1 binding, secrets, and Worker settings stay untouched.</p>
            <p><strong>Private repository?</strong> That works normally. Brolly stores only this repository name—never a GitHub token. GitHub checks your access when you open the updater.</p>
          </div>
          <form className="update-repository-form" onSubmit={event => { event.preventDefault(); void saveRepository(); }}>
            <label htmlFor="update-repository">Installation repository</label>
            <div>
              <input id="update-repository" value={repository} onChange={event => setRepository(event.target.value)} placeholder="owner/brolly-guard" autoComplete="off" spellCheck={false} />
              <button type="submit" className="button primary" disabled={savingRepository}>{savingRepository ? "Saving…" : "Save"}</button>
            </div>
            <small>Use the owner/repository name shown in GitHub. Clear it to disable update links.</small>
            {repositoryError && <p className="form-error" role="alert">{repositoryError}</p>}
            {repositoryMessage && <p className="form-success" role="status">{repositoryMessage}</p>}
            {release?.error && <p className="inline-update-error">The last release check could not finish: {release.error}</p>}
          </form>
        </div>
      </section>

      <section className="panel" aria-label="Runtime integration">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Runtime integration</p>
            <h2>Install the shutdown fuse</h2>
            <p className="panel-sub">Required for precise, zero-hot-path-I/O Worker and Durable Object quarantine. Verify each install on the Configuration page afterwards.</p>
          </div>
          <button type="button" className="button secondary" onClick={() => onNavigate("configuration")}>Verify installs</button>
        </div>
        <RuntimeInstallGuide />
      </section>

      <ControlCapabilities />

      <section className="panel" aria-label="Account">
        <div className="panel-head">
          <div>
            <h2>Account</h2>
            <p className="panel-sub">This Brolly instance and your browser session.</p>
          </div>
        </div>
        <div className="settings-facts">
          <article>
            <span>Cloudflare account</span>
            <strong>{connection.kind === "local" ? "Not connected (local preview)" : data.account.id}</strong>
            <small>{connection.label}</small>
          </article>
          <article>
            <span>Timezone</span>
            <strong>{data.account.timezone}</strong>
            <small>Used for the daily summary schedule</small>
          </article>
          <article className="session-card">
            <span>Browser session</span>
            <strong>Cloudflare sign-in active</strong>
            <small>A hashed, 12-hour HttpOnly session cookie authenticates this browser; no admin token is stored in browser storage.</small>
            <button type="button" className="button secondary" onClick={onLogout}><Icon name="logout" /> Sign out</button>
          </article>
        </div>
      </section>
    </>
  );
}
import { useEffect, useState } from "react";
import { api } from "../api";
