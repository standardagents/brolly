import type { ReactNode } from "react";
import { relativeTime, shortId } from "../format";
import type { ConnectionHealth } from "../lib/health";
import { ROUTE_PATHS, ROUTE_TITLES, type Route } from "../router";
import type { DashboardData, ReleaseStatus } from "../types";
import { ScanInfoTip } from "./protection";
import { Brand, Button, Icon, InfoTip, type IconName } from "./ui";

const NAV_GROUPS: Array<{ label: string; items: Array<{ route: Route; icon: IconName }> }> = [
  { label: "Monitor", items: [{ route: "overview", icon: "gauge" }, { route: "usage", icon: "trend" }, { route: "assets", icon: "layers" }, { route: "monitoring", icon: "pulse" }] },
  { label: "Protect", items: [{ route: "limits", icon: "wallet" }, { route: "alerts", icon: "bell" }, { route: "incidents", icon: "shield" }] },
  { label: "Operate", items: [{ route: "configuration", icon: "radar" }, { route: "notifications", icon: "bell" }, { route: "backfill", icon: "clock" }, { route: "settings", icon: "sliders" }] },
];

/** Sidebar destination. Desktop: rail row with an active edge bar. Below 1024px: wrapped chip. */
function NavLink({ href, active, icon, badge, onNavigate, children }: {
  href: string;
  active: boolean;
  icon: IconName;
  badge?: ReactNode;
  onNavigate: () => void;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      onClick={event => { event.preventDefault(); onNavigate(); }}
      className={[
        "relative my-px flex items-center gap-2.5 rounded-field px-2.5 py-2 text-[13.5px] font-[620]",
        "max-lg:m-0 max-lg:whitespace-nowrap max-lg:rounded-full max-lg:border max-lg:border-line max-lg:bg-panel max-lg:px-[11px] max-lg:py-[7px]",
        active
          ? "bg-orange-soft text-orange-deep before:absolute before:top-1.5 before:bottom-1.5 before:-left-2.5 before:w-[3px] before:rounded-r-[3px] before:bg-orange before:content-[''] max-lg:border-orange max-lg:before:hidden"
          : "text-[#444c58] hover:bg-[#f0f2f4] hover:text-ink dark:text-[#c0c7cf] dark:hover:bg-[#22272e]",
      ].join(" ")}
    >
      <Icon name={icon} className={`size-[17px] ${active ? "text-orange-deep" : "text-faint"}`} />
      <span>{children}</span>
      {badge}
    </a>
  );
}

/** Open-incident count on the Actions destination. */
function NavBadge({ danger, children }: { danger: boolean; children: ReactNode }) {
  return (
    <span className={`ml-auto rounded-full px-[7px] py-px text-[11.5px] font-[750] max-lg:ml-0.5 ${danger ? "bg-danger-bg text-danger" : "bg-chip text-chip-ink"}`}>
      {children}
    </span>
  );
}

const DOT_TONE: Record<ConnectionHealth["kind"], string> = {
  connected: "bg-[#18a35d] shadow-[0_0_0_3px_#18a35d22]",
  local: "bg-[#7f8ca0] dark:bg-[#87929f]",
  disconnected: "bg-danger",
};

/**
 * Update-banner action. It is an anchor when the release links to a pull
 * request and a button otherwise, so both states carry the same geometry.
 */
function UpdateAction({ href, onClick, children }: { href?: string; onClick?: () => void; children: ReactNode }) {
  const className = "inline-flex min-h-9 cursor-pointer items-center justify-center gap-[7px] rounded-field border border-orange bg-orange px-3.5 text-[13.5px] font-[620] whitespace-nowrap text-white transition-[background-color,border-color,box-shadow] duration-[130ms] hover:border-orange-hover hover:bg-orange-hover";
  if (href) return <a className={className} href={href} target="_blank" rel="noreferrer">{children}</a>;
  return <button type="button" className={className} onClick={onClick}>{children}</button>;
}

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
  const disconnected = connection.kind === "disconnected";
  return (
    <div className="grid min-h-screen grid-cols-[232px_minmax(0,1fr)] max-lg:grid-cols-[minmax(0,1fr)]">
      <a
        className="absolute -top-12 left-3 z-[200] rounded-field bg-ink px-3.5 py-2 font-[650] text-white focus-visible:top-2.5"
        href="#main"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 flex h-screen flex-col self-start border-r border-line bg-panel max-lg:static max-lg:h-auto max-lg:min-w-0 max-lg:border-r-0 max-lg:border-b max-lg:border-b-line">
        <div className="border-b border-line-soft px-[18px] pt-[18px] pb-3.5 max-lg:border-b-0 max-lg:pb-1.5"><Brand /></div>
        <nav
          className="flex-1 overflow-y-auto px-2.5 pt-2.5 pb-4 max-lg:flex max-lg:min-w-0 max-lg:flex-wrap max-lg:gap-[5px] max-lg:overflow-visible max-lg:pt-1 max-lg:pb-2.5"
          aria-label="Primary"
        >
          {NAV_GROUPS.map(group => (
            <div className="mt-[14px] first:mt-1 max-lg:contents" key={group.label}>
              <span className="block px-2.5 pb-[5px] text-[10.5px] font-[780] tracking-[.11em] uppercase text-faint max-lg:hidden">{group.label}</span>
              {group.items.map(item => (
                <NavLink
                  key={item.route}
                  href={ROUTE_PATHS[item.route]}
                  active={route === item.route}
                  icon={item.icon}
                  onNavigate={() => onNavigate(item.route)}
                  badge={item.route === "incidents" && data.summary.openIncidents > 0
                    ? <NavBadge danger={emergencies > 0}>{data.summary.openIncidents}</NavBadge>
                    : undefined}
                >
                  {ROUTE_TITLES[item.route]}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-line-soft p-3 max-lg:hidden">
          <div className={`flex items-center gap-[9px] rounded-field border px-2.5 py-[9px] text-[12px] ${disconnected ? "border-danger-line bg-danger-bg" : "border-line bg-panel-soft"}`}>
            <span className={`size-2 flex-none rounded-full ${DOT_TONE[connection.kind]}`} aria-hidden="true" />
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <strong className={`overflow-hidden text-[12px] text-ellipsis whitespace-nowrap ${disconnected ? "text-danger" : ""}`}>{connection.label}</strong>
              <small className="overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-faint">
                {connection.kind === "connected"
                  ? data.summary.lastCheckAt ? `Scan ${relativeTime(data.summary.lastCheckAt)}` : "No scan yet"
                  : connection.kind === "local" ? "Sample data only" : "Live data incomplete"}
              </small>
            </span>
            <InfoTip label="What this connection status means" align="left" flip>
              <h4>{connection.title}</h4>
              <p>{connection.detail}</p>
              <p>The automatic monitor attempts a bounded pass every minute. This status reflects Brolly's evidence, not whether the Cloudflare dashboard itself is reachable.</p>
            </InfoTip>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex min-h-[58px] items-center justify-between gap-4 border-b border-line bg-[#fffffff2] px-6 py-2 backdrop-blur-[6px] max-lg:static max-md:flex-wrap max-md:px-3.5 dark:bg-[#171a1ff0]">
          <div className="flex min-w-0 flex-wrap items-baseline gap-3">
            <h1 className="m-0 text-[17px] tracking-[-.01em]">{ROUTE_TITLES[route]}</h1>
            <span className="text-[12.5px] whitespace-nowrap text-faint">
              {connection.kind === "local" ? "Local preview" : `Account ${shortId(data.account.id)}`} · {modeLabel(data.policy.mode)}
            </span>
          </div>
          <div className="flex items-center gap-1.5 max-md:flex-wrap">
            <div className="inline-flex items-center gap-1.5">
              <Button variant="secondary" disabled={scanning} onClick={onScan}>
                <Icon name="refresh" /> {scanning ? "Scanning…" : "Scan now"}
              </Button>
              <ScanInfoTip />
            </div>
            <Button variant="quiet" onClick={onBudgets}><Icon name="wallet" /> Budgets</Button>
            <Button variant="quiet" onClick={onLogout} title="Sign out of Brolly" aria-label="Sign out of Brolly"><Icon name="logout" /></Button>
          </div>
        </header>

        {emergencies > 0 && (
          <div className="flex items-center gap-[13px] bg-[#b62525] px-6 py-3 text-white max-md:flex-wrap max-md:px-3.5" role="alert">
            <Icon name="alert" className="size-[22px] flex-none" />
            <div className="flex min-w-0 flex-1 flex-col gap-px">
              <strong className="text-[14px]">{emergencies} emergency incident{emergencies === 1 ? "" : "s"} — spend may be escalating right now.</strong>
              <span className="text-[12.5px] text-[#ffd9d4]">Review the measurement and use a prepared, reversible stop where one exists.</span>
            </div>
            {/* White-on-red action: the shared danger Button paints its own red fill, so this one carries the button geometry inline. */}
            <button
              type="button"
              className="inline-flex min-h-9 cursor-pointer items-center justify-center gap-[7px] rounded-field border border-white bg-white px-3.5 text-[13.5px] font-[620] text-[#b62525] transition-[background-color,border-color,box-shadow] duration-[130ms] hover:bg-[#ffe6e2]"
              onClick={() => onNavigate("alerts")}
            >
              Review alerts
            </button>
          </div>
        )}

        {disconnected && (
          <div className="flex items-start gap-2.5 border-b border-warn-line bg-warn-bg px-6 py-2.5 text-[13px] text-warn-ink max-md:flex-wrap max-md:px-3.5" role="status">
            <Icon name="alert" className="mt-px size-[17px] flex-none" />
            <div>
              <strong>{connection.title}.</strong>
              <span> {connection.errors[0] ?? connection.detail} </span>
              {/* Amber-on-amber link: the shared LinkButton is blue, which fails contrast inside this banner. */}
              <button
                type="button"
                className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[13px] font-[620] text-warn-ink underline"
                onClick={() => onNavigate("configuration")}
              >
                See connection details
              </button>
            </div>
          </div>
        )}

        {release?.available && (
          <div className="flex items-center gap-3 border-b border-[#f1c394] bg-[#fff3e8] px-6 py-2.5 text-[#6d3508] max-md:flex-wrap max-md:px-3.5 dark:border-[#694121] dark:bg-[#322115] dark:text-[#ffd0a8]" role="status">
            <Icon name="refresh" className="size-[18px] flex-none text-orange-deep" />
            <div className="flex min-w-0 flex-1 flex-col gap-px">
              <strong className="text-[13.5px]">Brolly {release.displayVersion ?? "update"} is ready to review.</strong>
              <span className="text-[12.5px] text-[#86532c] dark:text-[#d5a77f]">Your current installation stays unchanged until you merge its update pull request.</span>
            </div>
            {release.updateUrl ? (
              <UpdateAction href={release.updateUrl}>Review update</UpdateAction>
            ) : (
              <UpdateAction onClick={() => onNavigate("settings")}>Set up updates</UpdateAction>
            )}
          </div>
        )}

        <main id="main" className="mx-auto w-full max-w-[1240px] flex-1 px-6 pt-5 pb-20 max-md:px-3.5 max-md:pt-3.5 max-md:pb-[60px]">{children}</main>
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
