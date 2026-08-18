import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useNotificationTargets } from "../components/notifications";
import { Button, CellStack, ChannelLogo, CountBadge, EmptyState, Icon, InfoTip, KeyValueList, Notice, Panel, PanelFoot, PanelHead, Pill, ProductIcon, Segmented } from "../components/ui";
import { dateTime, metricTitle, relativeTime, shortId } from "../format";
import { coverageGuidance, type ConnectionHealth } from "../lib/health";
import type { Route } from "../router";
import type { ConfigurationCheck, ConfigurationData, ConfigurationStatus, DashboardData } from "../types";

/** Collapsible row shell shared by the coverage families and the runtime rows. */
const SUMMARY_BASE = "grid cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden";
const CHEVRON = "size-[15px] text-faint transition-transform duration-[130ms] group-open:rotate-180";

export function ConfigurationPage({ data, connection, token, onNavigate, onEditInstall }: {
  data: DashboardData;
  connection: ConnectionHealth;
  token: string;
  onNavigate: (route: Route) => void;
  onEditInstall: () => void;
}) {
  const [config, setConfig] = useState<ConfigurationData | null>(null);
  const [busy, setBusy] = useState<string[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void api<ConfigurationData>("/api/configuration", token)
      .then(setConfig)
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [token]);

  async function refresh(workerScripts: string[]) {
    setBusy(workerScripts);
    setError("");
    try {
      let next = config;
      for (let index = 0; index < workerScripts.length; index += 5) {
        next = await api<ConfigurationData>("/api/configuration/verify", token, {
          method: "POST",
          body: JSON.stringify({ workerScripts: workerScripts.slice(index, index + 5) }),
        });
      }
      if (next) setConfig(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy([]);
    }
  }

  return (
    <>
      <ConnectionSection data={data} connection={connection} />
      <TelemetrySection data={data} />
      <RuntimeSection
        config={config}
        busy={busy}
        error={error}
        onRefresh={refresh}
        onEditInstall={onEditInstall}
      />
      <NotificationStatusSection token={token} onNavigate={onNavigate} />
    </>
  );
}

/** Cloudflare connection state pill (outlined, with a colored status dot). */
function StatusPill({ connection }: { connection: ConnectionHealth }) {
  const dot = connection.kind === "connected"
    ? "bg-[#18a35d] shadow-[0_0_0_3px_#18a35d22]"
    : connection.kind === "local"
      ? "bg-[#7f8ca0] dark:bg-[#87929f]"
      : connection.kind === "disconnected"
        ? "bg-danger"
        : "bg-faint";
  return (
    <span className={`inline-flex items-center gap-[7px] rounded-full border bg-panel px-[11px] py-1.5 text-[12.5px] font-[680] ${
      connection.kind === "disconnected" ? "border-danger-line text-danger" : "border-line"
    }`}>
      <i className={`size-2 rounded-full ${dot}`} />
      {connection.label}
    </span>
  );
}

function ConnectionSection({ data, connection }: { data: DashboardData; connection: ConnectionHealth }) {
  return (
    <Panel aria-label="Cloudflare connection">
      <PanelHead
        title="Cloudflare connection"
        sub="The account credential every collector and control depends on."
        actions={<StatusPill connection={connection} />}
      />
      <div className="grid grid-cols-[minmax(280px,380px)_1fr] gap-[22px] px-5 pt-1 pb-4 max-xl:grid-cols-1">
        <KeyValueList
          rows={[
            ["Account", connection.kind === "local" ? "Placeholder (not installed)" : <code className="font-mono text-[.92em] break-all">{shortId(data.account.id)}</code>],
            ["Timezone", data.account.timezone],
            ["Last monitor pass", data.summary.lastCheckAt ? `${dateTime(data.summary.lastCheckAt)} (${relativeTime(data.summary.lastCheckAt)})` : "Never"],
          ]}
        />
        <div>
          <p className="mb-2.5 text-[13px] leading-[1.55] text-muted">{connection.detail}</p>
          {connection.errors.length > 0 && (
            <ul className="mx-5 mt-2 mb-1 list-disc pl-[18px] text-[12.5px] text-muted">
              {[...new Set(connection.errors)].slice(0, 3).map(message => (
                <li key={message} className="mb-[3px] [overflow-wrap:anywhere]">{message}</li>
              ))}
            </ul>
          )}
          {connection.kind !== "connected" && (
            <p className="mb-2.5 border-l-[3px] border-orange py-0.5 pl-3 text-[13px] leading-[1.55] text-muted">
              <strong className="text-ink">To repair:</strong> {connection.kind === "local"
                ? <>deploy Brolly, open its URL, and choose <em>Login with Cloudflare</em> to authorize exactly one account, then scan.</>
                : "reconnect the Cloudflare account or replace the expired/revoked credential, then run an account scan."}
            </p>
          )}
        </div>
      </div>
      <PanelFoot icon="clock">
        Bounded monitor: every minute, ~13 API calls for a one-page account, hard caps of 150 API calls / 25,000 D1 rows /
        20,000 samples / 45 s per pass. A 15-minute rolling-24h query and an optional daily Billing reconciliation are added on top.
      </PanelFoot>
    </Panel>
  );
}

function TelemetrySection({ data }: { data: DashboardData }) {
  const families = useMemo(() => {
    const byFamily = new Map<string, typeof data.coverage.all>();
    for (const item of data.coverage.all) {
      byFamily.set(item.family, [...(byFamily.get(item.family) ?? []), item]);
    }
    return [...byFamily.entries()]
      .map(([family, items]) => ({
        family,
        label: data.assets.families.find(item => item.family === family)?.label ?? metricTitle(family),
        items,
        gaps: items.filter(item => item.state !== "healthy"),
      }))
      .sort((a, b) => b.gaps.length - a.gaps.length || a.label.localeCompare(b.label));
  }, [data.coverage.all, data.assets.families]);

  return (
    <Panel aria-label="Telemetry collectors">
      <PanelHead
        title="Telemetry collectors"
        titleExtra={
          <InfoTip label="What is a coverage gap?">
            <h4>Missing evidence, not excess spend</h4>
            <p>A gap means Brolly lacks a current, trustworthy signal for one billable meter. It does not mean the meter is zero, and it does not count as a usage incident.</p>
            <p><strong>Permission needed</strong> means Cloudflare rejected the credential or account scope. <strong>Collector pending</strong> means the product is cataloged but Brolly does not yet have a reliable fast collector for that meter.</p>
          </InfoTip>
        }
        sub="Every cataloged billing meter and whether Brolly currently trusts its signal."
        actions={
          <CountBadge tone={data.summary.coverageGaps ? "warning" : "neutral"}>
            {data.summary.coverageGaps ? `${data.summary.coverageGaps} gaps` : "All healthy"}
          </CountBadge>
        }
      />
      {families.length === 0 ? (
        <EmptyState icon="radar" title="No collector results yet">
          Coverage states appear after the first monitor pass.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 px-5 pt-1 pb-4 max-xl:grid-cols-1">
          {families.map(group => {
            const denied = group.gaps.some(item => item.state === "permission_denied");
            const state = group.gaps.length === 0 ? "healthy" : denied ? "denied" : "pending";
            return (
              <details key={group.family} className="group overflow-hidden rounded-field border border-line bg-panel" open={group.gaps.length > 0}>
                <summary className={`${SUMMARY_BASE} grid-cols-[34px_minmax(0,1fr)_auto_16px] gap-[11px] px-[13px] py-[11px]`}>
                  <ProductIcon family={group.family} />
                  <CellStack title={group.label} sub={`${group.items.length - group.gaps.length}/${group.items.length} meters healthy`} />
                  <span className={`whitespace-nowrap rounded-full px-2 py-1 text-[10.5px] font-[750] ${
                    state === "healthy" ? "bg-good-bg text-good" : state === "denied" ? "bg-danger-bg text-danger" : "bg-warn-bg text-warn"
                  }`}>
                    {state === "healthy" ? "Healthy" : state === "denied" ? "Permission needed" : "Collector pending"}
                  </span>
                  <Icon name="chevron" className={CHEVRON} />
                </summary>
                <div className="border-t border-line-soft bg-panel-soft px-[13px] py-0.5">
                  {group.items.map(item => {
                    const guidance = item.state === "healthy" ? null : coverageGuidance(item);
                    return (
                      <div key={`${item.family}:${item.metric}`} className="flex justify-between gap-[18px] border-t border-line-soft py-2.5 first:border-t-0">
                        <span className="flex min-w-0 flex-col gap-[3px]">
                          <strong className="inline-flex flex-wrap items-center gap-[7px] text-[13px]">
                            <i className={`inline-block size-2 flex-none rounded-full ${item.state === "healthy" ? "bg-[#1b9e5a]" : "bg-[#e79021]"}`} aria-hidden="true" />
                            {metricTitle(item.metric)}
                            <em className="rounded-[3px] bg-[#edf0f3] px-1.5 py-px text-[10px] font-bold tracking-[.04em] text-muted uppercase not-italic dark:bg-[#252b32] dark:text-[#aab3bd]">
                              {item.scope.replaceAll("_", " ")} scope
                            </em>
                          </strong>
                          {guidance && <small className="text-[12px] break-words text-muted">{guidance.summary}</small>}
                          {guidance?.fix && (
                            <small className="text-[12px] leading-[1.45] break-words text-[#56616d] dark:text-[#b5bdc6]">
                              <b className="text-ink">How to fix:</b> {guidance.fix}
                            </small>
                          )}
                        </span>
                        <time className="text-[11px] whitespace-nowrap text-faint">{relativeTime(item.checkedAt)}</time>
                      </div>
                    );
                  })}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function RuntimeSection({ config, busy, error, onRefresh, onEditInstall }: {
  config: ConfigurationData | null;
  busy: string[];
  error: string;
  onRefresh: (workerScripts: string[]) => Promise<void>;
  onEditInstall: () => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | ConfigurationStatus>("all");

  const normalizedSearch = search.trim().toLowerCase();
  const visibleWorkers = config?.workers.filter(item =>
    (filter === "all" || item.status === filter)
    && (!normalizedSearch || `${item.name} ${item.id}`.toLowerCase().includes(normalizedSearch))) ?? [];
  const visibleNamespaces = config?.namespaces.filter(item =>
    (filter === "all" || item.status === filter)
    && (!normalizedSearch || `${item.name} ${item.id} ${item.ownerWorker ?? ""} ${item.className ?? ""}`.toLowerCase().includes(normalizedSearch))) ?? [];
  const allScripts = config?.workers.map(worker => worker.id) ?? [];

  return (
    <Panel aria-label="Runtime protection readiness">
      <PanelHead
        title="Runtime protection readiness"
        titleExtra={
          <InfoTip label="What does configuration refresh check?">
            <h4>Bounded live verification</h4>
            <p>For each selected Worker, Brolly checks Cloudflare API access, the BROLLY_FUSE secret, the active deployment, and a marker in the deployed bundle.</p>
            <p>It does not invoke the Worker, wake a Durable Object, deploy code, read object storage, or apply a quarantine. Results are cached until you refresh again, and refresh is never part of the automatic minute monitor.</p>
          </InfoTip>
        }
        sub="Each Worker and namespace is verified independently — installing Brolly on one script never makes others look protected."
        actions={
          <>
            <Button variant="quiet" onClick={onEditInstall}><Icon name="shield" /> Edit install declarations</Button>
            <Button
              variant="secondary"
              disabled={!config?.connected || !allScripts.length || busy.length > 0}
              onClick={() => void onRefresh(allScripts)}
            >
              <Icon name="refresh" /> {busy.length > 1 ? "Refreshing all…" : "Refresh all statuses"}
            </Button>
          </>
        }
      />

      {config && !config.connected && (
        <div className="mx-5 mb-3 flex items-start gap-[9px] rounded-field border border-line bg-panel-soft px-3 py-2.5 text-[12.5px] text-muted">
          <Icon name="info" className="mt-px size-[15px]" />
          <span>Live verification is unavailable in local preview. Inventory declarations are shown; refresh unlocks once real Cloudflare credentials are installed.</span>
        </div>
      )}
      {error && <Notice tone="error" className="mb-3.5 [overflow-wrap:anywhere]">{error}</Notice>}

      {!config ? (
        <p className="py-2.5 text-[13px] text-muted">Loading configuration inventory…</p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2.5 px-5 pt-1 pb-3 max-xl:grid-cols-2 max-md:grid-cols-1">
            <ConfigurationStat label="Workers configured" value={`${config.summary.configuredWorkers} / ${config.summary.workers}`} tone={config.summary.configuredWorkers === config.summary.workers && config.summary.workers > 0 ? "good" : "warning"} />
            <ConfigurationStat label="Namespaces configured" value={`${config.summary.configuredNamespaces} / ${config.summary.namespaces}`} tone={config.summary.configuredNamespaces === config.summary.namespaces && config.summary.namespaces > 0 ? "good" : "warning"} />
            <ConfigurationStat label="Partial installs" value={String(config.summary.partial)} tone={config.summary.partial ? "warning" : "good"} />
            <ConfigurationStat label="Needs attention" value={String(config.summary.needsAttention)} tone={config.summary.needsAttention ? "danger" : "good"} />
          </div>

          <div className="flex flex-wrap items-center gap-3 px-5 pb-3">
            <label className="flex min-h-9 items-center gap-[7px] rounded-field border border-field-line bg-panel px-2.5 focus-within:border-orange focus-within:shadow-[0_0_0_3px_#f6821f1f]">
              <Icon name="search" className="size-[15px] text-faint" />
              <input
                type="search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search Worker, namespace, or class"
                aria-label="Search runtime resources"
                className="min-w-[190px] border-0 bg-transparent text-[13px] outline-0"
              />
            </label>
            <Segmented
              ariaLabel="Filter by readiness"
              value={filter}
              onChange={setFilter}
              options={(["all", "configured", "partial", "not_configured", "error"] as const).map(value => ({
                value,
                label: value === "all" ? "All" : value === "not_configured" ? "Not configured" : value === "error" ? "Needs attention" : metricTitle(value),
              }))}
            />
            <span className="ml-auto text-[12px] whitespace-nowrap text-faint max-md:ml-0">
              Last live verification: {config.summary.lastVerifiedAt ? relativeTime(config.summary.lastVerifiedAt) : "never"}
            </span>
          </div>

          <ConfigurationGroup title="Worker scripts" description="Each Worker independently carries its own fuse secret and deployment evidence." count={visibleWorkers.length}>
            {visibleWorkers.length ? visibleWorkers.map(worker => (
              <details className={`group rounded-field border bg-panel ${ROW_BORDER[worker.status]}`} key={worker.id}>
                <summary className={`${SUMMARY_BASE} grid-cols-[34px_minmax(180px,1.4fr)_auto_minmax(0,1fr)_auto_16px] gap-3 px-[13px] py-2.5 max-xl:grid-cols-[34px_minmax(0,1fr)_auto_16px]`}>
                  <ProductIcon family="workers" tone="orange" />
                  <CellStack
                    title={worker.name}
                    sub={<>{worker.namespaceCount} mapped namespace{worker.namespaceCount === 1 ? "" : "s"} · inventory {relativeTime(worker.seenAt)}</>}
                  />
                  <ConfigurationBadge status={worker.status} />
                  <span className="flex flex-wrap justify-end gap-1.5 max-xl:hidden">
                    <MiniCheck check={worker.checks.fuseSecret} />
                    <MiniCheck check={worker.checks.runtimeBundle} />
                  </span>
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={!config.connected || busy.includes(worker.id)}
                    onClick={event => { event.preventDefault(); event.stopPropagation(); void onRefresh([worker.id]); }}
                  >
                    <Icon name="refresh" /> {busy.includes(worker.id) ? "Checking…" : "Refresh"}
                  </Button>
                  <Icon name="chevron" className={CHEVRON} />
                </summary>
                <div className="grid gap-3.5 border-t border-line-soft bg-panel-soft p-3.5">
                  <CheckGrid checks={worker.checks} />
                  <KeyValueList
                    rows={[
                      ["Worker script", <code className="font-mono text-[.92em] break-all">{worker.id}</code>],
                      ["Active deployment", worker.deploymentId ? <code className="font-mono text-[.92em] break-all">{worker.deploymentId}</code> : "Not verified"],
                      ["Active version", worker.versionId ? <code className="font-mono text-[.92em] break-all">{worker.versionId}</code> : "Not verified"],
                      ["Last checked", worker.checkedAt ? dateTime(worker.checkedAt) : "Never"],
                    ]}
                  />
                  <ConfigurationGuidance status={worker.status} kind="worker" onEdit={onEditInstall} />
                </div>
              </details>
            )) : <ConfigurationEmpty search={search} />}
          </ConfigurationGroup>

          <ConfigurationGroup title="Durable Object namespaces" description="A namespace is configured only when its constructor guard is confirmed and its own owning Worker has current successful evidence." count={visibleNamespaces.length}>
            {visibleNamespaces.length ? visibleNamespaces.map(namespace => (
              <details className={`group rounded-field border bg-panel ${ROW_BORDER[namespace.status]}`} key={namespace.id}>
                <summary className={`${SUMMARY_BASE} grid-cols-[34px_minmax(180px,1.4fr)_auto_minmax(0,1fr)_auto_16px] gap-3 px-[13px] py-2.5 max-xl:grid-cols-[34px_minmax(0,1fr)_auto_16px]`}>
                  <ProductIcon family="durable_objects" tone="orange" />
                  <CellStack
                    title={namespace.name}
                    sub={<>{namespace.className ?? "Class unavailable"} · {namespace.storage ?? "storage type unavailable"}</>}
                  />
                  <ConfigurationBadge status={namespace.status} />
                  <span className="flex min-w-0 flex-col gap-px max-xl:hidden">
                    <small className="text-[10.5px] font-bold tracking-[.05em] text-faint uppercase">Owning Worker</small>
                    <strong className="overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap">{namespace.ownerWorker ?? "Not mapped"}</strong>
                  </span>
                  {namespace.ownerWorker ? (
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={!config.connected || busy.includes(namespace.ownerWorker)}
                      onClick={event => { event.preventDefault(); event.stopPropagation(); void onRefresh([namespace.ownerWorker!]); }}
                    >
                      <Icon name="refresh" /> {busy.includes(namespace.ownerWorker) ? "Checking…" : "Refresh owner"}
                    </Button>
                  ) : (
                    <Button variant="secondary" size="small" onClick={event => { event.preventDefault(); event.stopPropagation(); onEditInstall(); }}>
                      Map owner
                    </Button>
                  )}
                  <Icon name="chevron" className={CHEVRON} />
                </summary>
                <div className="grid gap-3.5 border-t border-line-soft bg-panel-soft p-3.5">
                  <CheckGrid checks={namespace.checks} />
                  <KeyValueList
                    rows={[
                      ["Namespace ID", <code className="font-mono text-[.92em] break-all">{namespace.id}</code>],
                      ["Cloudflare owner", namespace.discoveredOwner ?? "Not returned"],
                      ["Configured owner", namespace.declaredOwner ?? "Inherited from Cloudflare"],
                      ["Protection tier", metricTitle(namespace.tier)],
                    ]}
                  />
                  <ConfigurationGuidance status={namespace.status} kind="namespace" onEdit={onEditInstall} />
                </div>
              </details>
            )) : <ConfigurationEmpty search={search} />}
          </ConfigurationGroup>

          <div className="mx-5 mt-1 mb-2 flex gap-[11px] rounded-field border border-line bg-panel-soft px-[15px] py-[13px]">
            <Icon name="shield" className="mt-px size-[19px] text-muted" />
            <div>
              <strong className="text-[13px]">What "configured" means here</strong>
              <p className="mt-[3px] text-[12.5px] leading-[1.5] text-muted">Brolly found the resource, the installation was explicitly confirmed, and the owning Worker passed the latest passive Cloudflare checks. This is not a destructive shutdown drill: Brolly does not claim that an exact constructor path was exercised unless a future canary test says so.</p>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

function NotificationStatusSection({ token, onNavigate }: { token: string; onNavigate: (route: Route) => void }) {
  const { targets, credentialStorageReady, loading } = useNotificationTargets(token);
  return (
    <Panel aria-label="Notification channels">
      <PanelHead
        title="Notification channels"
        sub="Where incident alerts and the daily summary are delivered."
        actions={<Button variant="secondary" onClick={() => onNavigate("settings")}>Manage in Settings</Button>}
      />
      {loading ? (
        <p className="py-2.5 text-[13px] text-muted">Loading destinations…</p>
      ) : targets.length === 0 ? (
        <div className="mx-5 mb-3 flex items-start gap-[9px] rounded-field border border-warn-line bg-warn-bg px-3 py-2.5 text-[12.5px] text-warn-ink">
          <Icon name="bell" className="mt-px size-[15px]" />
          <span>
            No notification destinations are configured{credentialStorageReady ? "" : " and automatic credential-key setup did not complete"}.
            Without one, incidents are only visible in this dashboard and the CLI.
          </span>
        </div>
      ) : (
        <ul className="m-0 list-none p-0 pb-2">
          {targets.map(target => (
            <li key={target.id} className="flex items-center gap-3 border-t border-line-soft px-5 py-2.5">
              <ChannelLogo kind={target.kind} />
              <CellStack
                title={metricTitle(target.kind)}
                sub={<>
                  {target.lastDeliveryAt
                    ? `${target.lastDeliveryOk ? "delivered" : "delivery failed"} ${relativeTime(target.lastDeliveryAt)}`
                    : "no delivery attempts yet"}
                </>}
              />
              <Pill tone={target.enabled ? "good" : "neutral"} className="ml-auto">{target.enabled ? "Active" : "Paused"}</Pill>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ConfigurationStat({ label, value, tone }: { label: string; value: string; tone: "good" | "warning" | "danger" }) {
  return (
    <article className={`flex flex-col gap-[3px] rounded-field border border-line px-[13px] py-[11px] ${
      tone === "warning" ? "border-l-[3px] border-l-[#e0a53a]" : tone === "danger" ? "border-l-[3px] border-l-danger" : ""
    }`}>
      <span className="text-[11.5px] font-[650] text-muted">{label}</span>
      <strong className={`text-[19px] tabular-nums ${tone === "good" ? "text-good" : tone === "danger" ? "text-danger" : ""}`}>{value}</strong>
    </article>
  );
}

const ROW_BORDER: Record<ConfigurationStatus, string> = {
  configured: "border-good-line",
  partial: "border-line",
  not_configured: "border-line",
  error: "border-danger-line",
};

function ConfigurationGroup({ title, description, count, children }: {
  title: string;
  description: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="px-5 pt-1 pb-3.5">
      <div className="flex items-start justify-between gap-3 py-2">
        <div>
          <h3 className="m-0 text-[14.5px]">{title}</h3>
          <p className="mt-[3px] max-w-[76ch] text-[12.5px] text-muted">{description}</p>
        </div>
        <CountBadge>{count}</CountBadge>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

const BADGE_TONE = {
  configured: "good",
  partial: "warn",
  not_configured: "neutral",
  error: "danger",
} as const;

function ConfigurationBadge({ status }: { status: ConfigurationStatus }) {
  const labels: Record<ConfigurationStatus, string> = {
    configured: "Configured",
    partial: "Partial",
    not_configured: "Not configured",
    error: "Needs attention",
  };
  return <Pill tone={BADGE_TONE[status]} dot>{labels[status]}</Pill>;
}

function MiniCheck({ check }: { check: ConfigurationCheck }) {
  const dot = check.state === "pass" ? "bg-[#1b9e5a]" : check.state === "fail" || check.state === "error" ? "bg-danger" : "bg-faint";
  return (
    <span className="inline-flex items-center gap-[5px] rounded border border-line-soft bg-panel-soft px-[7px] py-[3px] text-[11px] whitespace-nowrap text-muted" title={check.detail}>
      <i className={`size-1.5 rounded-full ${dot}`} />{check.label}
    </span>
  );
}

function CheckGrid({ checks }: { checks: Record<string, ConfigurationCheck> }) {
  return (
    <div className="grid grid-cols-2 gap-2 max-xl:grid-cols-1">
      {Object.entries(checks).map(([key, check]) => (
        <article className="flex gap-[9px] rounded-field border border-line-soft bg-panel p-2.5" key={key}>
          <span className={`grid size-5 flex-none place-items-center rounded-full text-[11px] font-[850] ${
            check.state === "pass" ? "bg-good-bg text-good"
              : check.state === "fail" || check.state === "error" ? "bg-danger-bg text-danger"
                : "bg-chip text-muted dark:text-chip-ink"
          }`}>
            {check.state === "pass" ? "✓" : check.state === "unknown" ? "?" : "!"}
          </span>
          <div>
            <strong className="block text-[12.5px]">{check.label}</strong>
            <p className="mt-0.5 text-[12px] leading-[1.45] text-muted">{check.detail}</p>
          </div>
        </article>
      ))}
    </div>
  );
}

function ConfigurationGuidance({ status, kind, onEdit }: { status: ConfigurationStatus; kind: "worker" | "namespace"; onEdit: () => void }) {
  if (status === "configured") {
    return (
      <div className="rounded-field border border-good-line bg-good-bg px-[13px] py-[11px] dark:text-warn">
        <strong className="text-[13px]">Ready for precise protection</strong>
        <p className="mt-0.5 text-[12.5px] text-muted">{kind === "worker"
          ? "This Worker can receive whole-script fuse generations."
          : "Objects in this namespace inherit the verified owning Worker and are eligible for exact-ID quarantine when policy permits."}</p>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3.5 rounded-field border border-warn-line bg-warn-soft px-[13px] py-[11px] max-md:flex-col max-md:items-start dark:text-warn">
      <div>
        <strong className="text-[13px]">{status === "error" ? "Resolve the failed check" : "Finish this installation"}</strong>
        <p className="mt-0.5 text-[12.5px] text-muted">{kind === "worker"
          ? "Install and confirm the ingress guard, initialize BROLLY_FUSE, then refresh live status."
          : "Confirm the constructor guard and correct owning Worker, then refresh that Worker."}</p>
      </div>
      <Button variant="secondary" size="small" onClick={onEdit}>Edit declaration</Button>
    </div>
  );
}

function ConfigurationEmpty({ search }: { search: string }) {
  return (
    <EmptyState icon="search" title="No matching resources" compact>
      {search ? "Try a different search or status filter." : "Run an account scan to discover resources."}
    </EmptyState>
  );
}
