import { NotificationSection } from "../components/notifications";
import { ControlCapabilities, RuntimeInstallGuide } from "../components/protection";
import { Icon } from "../components/ui";
import { money } from "../format";
import type { ConnectionHealth } from "../lib/health";
import type { Route } from "../router";
import type { DashboardData } from "../types";

export function SettingsPage({ data, connection, token, onNavigate, onBudgets, onLogout }: {
  data: DashboardData;
  connection: ConnectionHealth;
  token: string;
  onNavigate: (route: Route) => void;
  onBudgets: () => void;
  onLogout: () => void;
}) {
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
