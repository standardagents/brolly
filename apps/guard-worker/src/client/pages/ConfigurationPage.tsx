import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useNotificationTargets } from "../components/notifications";
import { ChannelLogo, EmptyState, Icon, InfoTip, ProductIcon } from "../components/ui";
import { dateTime, metricTitle, relativeTime, shortId } from "../format";
import { coverageGuidance, type ConnectionHealth } from "../lib/health";
import type { Route } from "../router";
import type { ConfigurationCheck, ConfigurationData, ConfigurationStatus, DashboardData } from "../types";

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

function ConnectionSection({ data, connection }: { data: DashboardData; connection: ConnectionHealth }) {
  return (
    <section className="panel" aria-label="Cloudflare connection">
      <div className="panel-head">
        <div>
          <h2>Cloudflare connection</h2>
          <p className="panel-sub">The account credential every collector and control depends on.</p>
        </div>
        <span className={`status-pill ${connection.kind}`}><i />{connection.label}</span>
      </div>
      <div className="connection-grid">
        <dl className="kv-list">
          <div><dt>Account</dt><dd>{connection.kind === "local" ? "Placeholder (not installed)" : <code>{shortId(data.account.id)}</code>}</dd></div>
          <div><dt>Timezone</dt><dd>{data.account.timezone}</dd></div>
          <div><dt>Last monitor pass</dt><dd>{data.summary.lastCheckAt ? `${dateTime(data.summary.lastCheckAt)} (${relativeTime(data.summary.lastCheckAt)})` : "Never"}</dd></div>
          <div><dt>Control mode</dt><dd>{metricTitle(data.policy.mode)}</dd></div>
        </dl>
        <div className="connection-copy">
          <p>{connection.detail}</p>
          {connection.errors.length > 0 && (
            <ul className="local-preview-errors">
              {[...new Set(connection.errors)].slice(0, 3).map(message => <li key={message}>{message}</li>)}
            </ul>
          )}
          {connection.kind !== "connected" && (
            <p className="recovery-note">
              <strong>To repair:</strong> {connection.kind === "local"
                ? <>deploy Brolly, open its URL, and choose <em>Continue with Cloudflare</em> to authorize exactly one account, then scan.</>
                : "reconnect the Cloudflare account or replace the expired/revoked credential, then run an account scan."}
            </p>
          )}
        </div>
      </div>
      <footer className="panel-foot">
        <Icon name="clock" />
        <span>
          Bounded monitor: every minute, ~13 API calls for a one-page account, hard caps of 150 API calls / 25,000 D1 rows /
          20,000 samples / 45 s per pass. A 15-minute rolling-24h query and an optional daily Billing reconciliation are added on top.
        </span>
      </footer>
    </section>
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
    <section className="panel" aria-label="Telemetry collectors">
      <div className="panel-head">
        <div>
          <h2 className="heading-with-info">
            Telemetry collectors
            <InfoTip label="What is a coverage gap?">
              <h4>Missing evidence, not excess spend</h4>
              <p>A gap means Brolly lacks a current, trustworthy signal for one billable meter. It does not mean the meter is zero, and it does not count as a usage incident.</p>
              <p><strong>Permission needed</strong> means Cloudflare rejected the credential or account scope. <strong>Collector pending</strong> means the product is cataloged but Brolly does not yet have a reliable fast collector for that meter.</p>
            </InfoTip>
          </h2>
          <p className="panel-sub">Every cataloged billing meter and whether Brolly currently trusts its signal.</p>
        </div>
        <span className={`count-badge ${data.summary.coverageGaps ? "warning" : ""}`}>
          {data.summary.coverageGaps ? `${data.summary.coverageGaps} gaps` : "All healthy"}
        </span>
      </div>
      {families.length === 0 ? (
        <EmptyState icon="radar" title="No collector results yet">
          Coverage states appear after the first monitor pass.
        </EmptyState>
      ) : (
        <div className="coverage-grid">
          {families.map(group => (
            <details key={group.family} className="coverage-family" open={group.gaps.length > 0}>
              <summary>
                <ProductIcon family={group.family} />
                <span className="cell-main">
                  <strong>{group.label}</strong>
                  <small>
                    {group.items.length - group.gaps.length}/{group.items.length} meters healthy
                  </small>
                </span>
                <span className={`coverage-state ${group.gaps.length === 0 ? "healthy" : group.gaps.some(item => item.state === "permission_denied") ? "denied" : "pending"}`}>
                  {group.gaps.length === 0 ? "Healthy" : group.gaps.some(item => item.state === "permission_denied") ? "Permission needed" : "Collector pending"}
                </span>
                <Icon name="chevron" />
              </summary>
              <div className="coverage-details">
                {group.items.map(item => {
                  const guidance = item.state === "healthy" ? null : coverageGuidance(item);
                  return (
                    <div key={`${item.family}:${item.metric}`}>
                      <span>
                        <strong>
                          <i className={`coverage-dot ${item.state === "healthy" ? "active" : "gap"}`} aria-hidden="true" />
                          {metricTitle(item.metric)}
                          <em className="scope-tag">{item.scope.replaceAll("_", " ")} scope</em>
                        </strong>
                        {guidance && <small>{guidance.summary}</small>}
                        {guidance?.fix && <small className="coverage-fix"><b>How to fix:</b> {guidance.fix}</small>}
                      </span>
                      <time>{relativeTime(item.checkedAt)}</time>
                    </div>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
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
    <section className="panel" aria-label="Runtime protection readiness">
      <div className="panel-head">
        <div>
          <h2 className="heading-with-info">
            Runtime protection readiness
            <InfoTip label="What does configuration refresh check?">
              <h4>Bounded live verification</h4>
              <p>For each selected Worker, Brolly checks Cloudflare API access, the BROLLY_FUSE secret, the active deployment, and a marker in the deployed bundle.</p>
              <p>It does not invoke the Worker, wake a Durable Object, deploy code, read object storage, or apply a quarantine. Results are cached until you refresh again, and refresh is never part of the automatic minute monitor.</p>
            </InfoTip>
          </h2>
          <p className="panel-sub">Each Worker and namespace is verified independently — installing Brolly on one script never makes others look protected.</p>
        </div>
        <div className="panel-actions">
          <button type="button" className="button quiet" onClick={onEditInstall}><Icon name="shield" /> Edit install declarations</button>
          <button
            type="button"
            className="button secondary"
            disabled={!config?.connected || !allScripts.length || busy.length > 0}
            onClick={() => void onRefresh(allScripts)}
          >
            <Icon name="refresh" /> {busy.length > 1 ? "Refreshing all…" : "Refresh all statuses"}
          </button>
        </div>
      </div>

      {config && !config.connected && (
        <div className="inline-note">
          <Icon name="info" />
          <span>Live verification is unavailable in local preview. Inventory declarations are shown; refresh unlocks once real Cloudflare credentials are installed.</span>
        </div>
      )}
      {error && <p className="form-error page-error">{error}</p>}

      {!config ? (
        <p className="loading-inline">Loading configuration inventory…</p>
      ) : (
        <>
          <div className="configuration-summary">
            <ConfigurationStat label="Workers configured" value={`${config.summary.configuredWorkers} / ${config.summary.workers}`} tone={config.summary.configuredWorkers === config.summary.workers && config.summary.workers > 0 ? "good" : "warning"} />
            <ConfigurationStat label="Namespaces configured" value={`${config.summary.configuredNamespaces} / ${config.summary.namespaces}`} tone={config.summary.configuredNamespaces === config.summary.namespaces && config.summary.namespaces > 0 ? "good" : "warning"} />
            <ConfigurationStat label="Partial installs" value={String(config.summary.partial)} tone={config.summary.partial ? "warning" : "good"} />
            <ConfigurationStat label="Needs attention" value={String(config.summary.needsAttention)} tone={config.summary.needsAttention ? "danger" : "good"} />
          </div>

          <div className="configuration-toolbar">
            <label className="search-field">
              <Icon name="search" />
              <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search Worker, namespace, or class" aria-label="Search runtime resources" />
            </label>
            <div className="segmented" role="group" aria-label="Filter by readiness">
              {(["all", "configured", "partial", "not_configured", "error"] as const).map(value => (
                <button key={value} type="button" className={filter === value ? "active" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>
                  {value === "all" ? "All" : value === "not_configured" ? "Not configured" : value === "error" ? "Needs attention" : metricTitle(value)}
                </button>
              ))}
            </div>
            <span className="toolbar-meta">Last live verification: {config.summary.lastVerifiedAt ? relativeTime(config.summary.lastVerifiedAt) : "never"}</span>
          </div>

          <ConfigurationGroup title="Worker scripts" description="Each Worker independently carries its own fuse secret and deployment evidence." count={visibleWorkers.length}>
            {visibleWorkers.length ? visibleWorkers.map(worker => (
              <details className={`configuration-row ${worker.status}`} key={worker.id}>
                <summary>
                  <ProductIcon family="workers" tone="orange" />
                  <span className="cell-main">
                    <strong>{worker.name}</strong>
                    <small>{worker.namespaceCount} mapped namespace{worker.namespaceCount === 1 ? "" : "s"} · inventory {relativeTime(worker.seenAt)}</small>
                  </span>
                  <ConfigurationBadge status={worker.status} />
                  <span className="configuration-check-preview">
                    <MiniCheck check={worker.checks.fuseSecret} />
                    <MiniCheck check={worker.checks.runtimeBundle} />
                  </span>
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={!config.connected || busy.includes(worker.id)}
                    onClick={event => { event.preventDefault(); event.stopPropagation(); void onRefresh([worker.id]); }}
                  >
                    <Icon name="refresh" /> {busy.includes(worker.id) ? "Checking…" : "Refresh"}
                  </button>
                  <Icon name="chevron" />
                </summary>
                <div className="configuration-details">
                  <CheckGrid checks={worker.checks} />
                  <dl className="kv-list">
                    <div><dt>Worker script</dt><dd><code>{worker.id}</code></dd></div>
                    <div><dt>Active deployment</dt><dd>{worker.deploymentId ? <code>{worker.deploymentId}</code> : "Not verified"}</dd></div>
                    <div><dt>Active version</dt><dd>{worker.versionId ? <code>{worker.versionId}</code> : "Not verified"}</dd></div>
                    <div><dt>Last checked</dt><dd>{worker.checkedAt ? dateTime(worker.checkedAt) : "Never"}</dd></div>
                  </dl>
                  <ConfigurationGuidance status={worker.status} kind="worker" onEdit={onEditInstall} />
                </div>
              </details>
            )) : <ConfigurationEmpty search={search} />}
          </ConfigurationGroup>

          <ConfigurationGroup title="Durable Object namespaces" description="A namespace is configured only when its constructor guard is confirmed and its own owning Worker has current successful evidence." count={visibleNamespaces.length}>
            {visibleNamespaces.length ? visibleNamespaces.map(namespace => (
              <details className={`configuration-row ${namespace.status}`} key={namespace.id}>
                <summary>
                  <ProductIcon family="durable_objects" tone="orange" />
                  <span className="cell-main">
                    <strong>{namespace.name}</strong>
                    <small>{namespace.className ?? "Class unavailable"} · {namespace.storage ?? "storage type unavailable"}</small>
                  </span>
                  <ConfigurationBadge status={namespace.status} />
                  <span className="configuration-owner">
                    <small>Owning Worker</small>
                    <strong>{namespace.ownerWorker ?? "Not mapped"}</strong>
                  </span>
                  {namespace.ownerWorker ? (
                    <button
                      type="button"
                      className="button secondary small"
                      disabled={!config.connected || busy.includes(namespace.ownerWorker)}
                      onClick={event => { event.preventDefault(); event.stopPropagation(); void onRefresh([namespace.ownerWorker!]); }}
                    >
                      <Icon name="refresh" /> {busy.includes(namespace.ownerWorker) ? "Checking…" : "Refresh owner"}
                    </button>
                  ) : (
                    <button type="button" className="button secondary small" onClick={event => { event.preventDefault(); event.stopPropagation(); onEditInstall(); }}>
                      Map owner
                    </button>
                  )}
                  <Icon name="chevron" />
                </summary>
                <div className="configuration-details">
                  <CheckGrid checks={namespace.checks} />
                  <dl className="kv-list">
                    <div><dt>Namespace ID</dt><dd><code>{namespace.id}</code></dd></div>
                    <div><dt>Cloudflare owner</dt><dd>{namespace.discoveredOwner ?? "Not returned"}</dd></div>
                    <div><dt>Configured owner</dt><dd>{namespace.declaredOwner ?? "Inherited from Cloudflare"}</dd></div>
                    <div><dt>Protection tier</dt><dd>{metricTitle(namespace.tier)}</dd></div>
                  </dl>
                  <ConfigurationGuidance status={namespace.status} kind="namespace" onEdit={onEditInstall} />
                </div>
              </details>
            )) : <ConfigurationEmpty search={search} />}
          </ConfigurationGroup>

          <div className="trust-note">
            <Icon name="shield" />
            <div>
              <strong>What "configured" means here</strong>
              <p>Brolly found the resource, the installation was explicitly confirmed, and the owning Worker passed the latest passive Cloudflare checks. This is not a destructive shutdown drill: Brolly does not claim that an exact constructor path was exercised unless a future canary test says so.</p>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function NotificationStatusSection({ token, onNavigate }: { token: string; onNavigate: (route: Route) => void }) {
  const { targets, credentialStorageReady, loading } = useNotificationTargets(token);
  return (
    <section className="panel" aria-label="Notification channels">
      <div className="panel-head">
        <div>
          <h2>Notification channels</h2>
          <p className="panel-sub">Where incident alerts and the daily summary are delivered.</p>
        </div>
        <button type="button" className="button secondary" onClick={() => onNavigate("settings")}>Manage in Settings</button>
      </div>
      {loading ? (
        <p className="loading-inline">Loading destinations…</p>
      ) : targets.length === 0 ? (
        <div className="inline-note warning">
          <Icon name="bell" />
          <span>
            No notification destinations are configured{credentialStorageReady ? "" : " and automatic credential-key setup did not complete"}.
            Without one, incidents are only visible in this dashboard and the CLI.
          </span>
        </div>
      ) : (
        <ul className="channel-status-list">
          {targets.map(target => (
            <li key={target.id}>
              <ChannelLogo kind={target.kind} />
              <span className="cell-main">
                <strong>{metricTitle(target.kind)}</strong>
                <small>
                  Notifies at {target.minimumSeverity} and above ·{" "}
                  {target.lastDeliveryAt
                    ? `${target.lastDeliveryOk ? "delivered" : "delivery failed"} ${relativeTime(target.lastDeliveryAt)}`
                    : "no delivery attempts yet"}
                </small>
              </span>
              <span className={`target-status ${target.enabled ? "active" : "inactive"}`}>{target.enabled ? "Active" : "Paused"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConfigurationStat({ label, value, tone }: { label: string; value: string; tone: "good" | "warning" | "danger" }) {
  return (
    <article className={`configuration-stat ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function ConfigurationGroup({ title, description, count, children }: {
  title: string;
  description: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="configuration-group">
      <div className="configuration-group-head">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <span className="count-badge">{count}</span>
      </div>
      <div className="configuration-list">{children}</div>
    </div>
  );
}

function ConfigurationBadge({ status }: { status: ConfigurationStatus }) {
  const labels: Record<ConfigurationStatus, string> = {
    configured: "Configured",
    partial: "Partial",
    not_configured: "Not configured",
    error: "Needs attention",
  };
  return <span className={`configuration-badge ${status}`}><i />{labels[status]}</span>;
}

function MiniCheck({ check }: { check: ConfigurationCheck }) {
  return <span className={`mini-check ${check.state}`} title={check.detail}><i />{check.label}</span>;
}

function CheckGrid({ checks }: { checks: Record<string, ConfigurationCheck> }) {
  return (
    <div className="configuration-check-grid">
      {Object.entries(checks).map(([key, check]) => (
        <article className={check.state} key={key}>
          <span>{check.state === "pass" ? "✓" : check.state === "unknown" ? "?" : "!"}</span>
          <div>
            <strong>{check.label}</strong>
            <p>{check.detail}</p>
          </div>
        </article>
      ))}
    </div>
  );
}

function ConfigurationGuidance({ status, kind, onEdit }: { status: ConfigurationStatus; kind: "worker" | "namespace"; onEdit: () => void }) {
  if (status === "configured") {
    return (
      <div className="configuration-guidance good">
        <strong>Ready for precise protection</strong>
        <p>{kind === "worker"
          ? "This Worker can receive whole-script fuse generations."
          : "Objects in this namespace inherit the verified owning Worker and are eligible for exact-ID quarantine when policy permits."}</p>
      </div>
    );
  }
  return (
    <div className="configuration-guidance">
      <div>
        <strong>{status === "error" ? "Resolve the failed check" : "Finish this installation"}</strong>
        <p>{kind === "worker"
          ? "Install and confirm the ingress guard, initialize BROLLY_FUSE, then refresh live status."
          : "Confirm the constructor guard and correct owning Worker, then refresh that Worker."}</p>
      </div>
      <button type="button" className="button secondary small" onClick={onEdit}>Edit declaration</button>
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
