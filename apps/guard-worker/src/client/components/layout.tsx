import type { ReactNode } from "react";
import { relativeTime, shortId } from "../format";
import type { ConnectionHealth } from "../lib/health";
import { ROUTE_PATHS, ROUTE_TITLES, type Route } from "../router";
import type { DashboardData, ReleaseStatus } from "../types";
import { ScanInfoTip } from "./protection";
import { Brand, Icon, InfoTip, type IconName } from "./ui";

const NAV_GROUPS: Array<{ label: string; items: Array<{ route: Route; icon: IconName }> }> = [
  { label: "Monitor", items: [{ route: "overview", icon: "gauge" }, { route: "assets", icon: "layers" }] },
  { label: "Respond", items: [{ route: "incidents", icon: "alert" }] },
  { label: "Protect", items: [{ route: "configuration", icon: "shield" }, { route: "settings", icon: "sliders" }] },
];

export function AppShell({ route, onNavigate, data, connection, scanning, onScan, onBudgets, onLogout, release, children }: {
  route: Route;
  onNavigate: (route: Route) => void;
  data: DashboardData;
  connection: ConnectionHealth;
  scanning: boolean;
  onScan: () => void;
  onBudgets: () => void;
  onLogout: () => void;
  release: ReleaseStatus | null;
  children: ReactNode;
}) {
  const emergencies = data.incidents.filter(incident => incident.status === "open" && incident.severity === "emergency").length;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="sidebar">
        <div className="sidebar-brand"><Brand /></div>
        <nav className="sidebar-nav" aria-label="Primary">
          {NAV_GROUPS.map(group => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              {group.items.map(item => (
                <a
                  key={item.route}
                  href={ROUTE_PATHS[item.route]}
                  className={route === item.route ? "active" : ""}
                  aria-current={route === item.route ? "page" : undefined}
                  onClick={event => { event.preventDefault(); onNavigate(item.route); }}
                >
                  <Icon name={item.icon} />
                  <span>{ROUTE_TITLES[item.route]}</span>
                  {item.route === "incidents" && data.summary.openIncidents > 0 && (
                    <span className={`nav-badge ${emergencies ? "danger" : ""}`}>{data.summary.openIncidents}</span>
                  )}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className={`connection-chip ${connection.kind}`}>
            <span className="status-dot" aria-hidden="true" />
            <span>
              <strong>{connection.label}</strong>
              <small>
                {connection.kind === "connected"
                  ? data.summary.lastCheckAt ? `Scan ${relativeTime(data.summary.lastCheckAt)}` : "No scan yet"
                  : connection.kind === "local" ? "Sample data only" : "Live data incomplete"}
              </small>
            </span>
            <InfoTip label="What this connection status means" align="left">
              <h4>{connection.title}</h4>
              <p>{connection.detail}</p>
              <p>The automatic monitor attempts a bounded pass every minute. This status reflects Brolly's evidence, not whether the Cloudflare dashboard itself is reachable.</p>
            </InfoTip>
          </div>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-context">
            <h1>{ROUTE_TITLES[route]}</h1>
            <span className="topbar-account">
              {connection.kind === "local" ? "Local preview" : `Account ${shortId(data.account.id)}`} · {modeLabel(data.policy.mode)}
            </span>
          </div>
          <div className="topbar-actions">
            <div className="scan-control">
              <button type="button" className="button secondary" disabled={scanning} onClick={onScan}>
                <Icon name="refresh" /> {scanning ? "Scanning…" : "Scan now"}
              </button>
              <ScanInfoTip />
            </div>
            <button type="button" className="button quiet" onClick={onBudgets}><Icon name="wallet" /> Budgets</button>
            <button type="button" className="button quiet" onClick={onLogout} title="Sign out of Brolly" aria-label="Sign out of Brolly"><Icon name="logout" /></button>
          </div>
        </header>

        {emergencies > 0 && (
          <div className="emergency-banner" role="alert">
            <Icon name="alert" />
            <div>
              <strong>{emergencies} emergency incident{emergencies === 1 ? "" : "s"} — spend may be escalating right now.</strong>
              <span>Review the measurement and use a prepared, reversible stop where one exists.</span>
            </div>
            <button type="button" className="button danger" onClick={() => onNavigate("incidents")}>Respond</button>
          </div>
        )}

        {connection.kind === "disconnected" && (
          <div className="degraded-banner" role="status">
            <Icon name="alert" />
            <div>
              <strong>{connection.title}.</strong>
              <span> {connection.errors[0] ?? connection.detail} </span>
              <button type="button" className="link-button" onClick={() => onNavigate("configuration")}>See connection details</button>
            </div>
          </div>
        )}

        {release?.available && (
          <div className="update-banner" role="status">
            <Icon name="refresh" />
            <div>
              <strong>Brolly {release.displayVersion ?? "update"} is ready to review.</strong>
              <span>Your current installation stays unchanged until you merge its update pull request.</span>
            </div>
            {release.updateUrl ? (
              <a className="button update" href={release.updateUrl} target="_blank" rel="noreferrer">Review update</a>
            ) : (
              <button type="button" className="button update" onClick={() => onNavigate("settings")}>Set up updates</button>
            )}
          </div>
        )}

        <main id="main" className="page">{children}</main>
      </div>
    </div>
  );
}

function modeLabel(mode: DashboardData["policy"]["mode"]): string {
  const labels = {
    observe: "Observe mode (alerts only)",
    approval: "Approval mode (stops need sign-off)",
    automatic: "Automatic emergency quarantine",
  } as const;
  return labels[mode] ?? mode;
}
