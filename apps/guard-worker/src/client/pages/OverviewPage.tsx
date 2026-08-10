import { useEffect, useState } from "react";
import { api } from "../api";
import { SpendChart, spendDelta } from "../components/SpendChart";
import { EmptyState, Icon, InfoTip, ProductIcon, SeverityBadge } from "../components/ui";
import { actionKindLabel, actionStateTitle } from "../components/ActionDrawer";
import { compactId, measurement, money, relativeTime } from "../format";
import type { ConnectionHealth } from "../lib/health";
import { categoryColor } from "../lib/meta";
import type { Route } from "../router";
import type { ConfigurationData, DashboardData, Incident } from "../types";

export function OverviewPage({ data, connection, token, scanError, onNavigate, onOpenIncident, onBudgets }: {
  data: DashboardData;
  connection: ConnectionHealth;
  token: string;
  scanError: string;
  onNavigate: (route: Route) => void;
  onOpenIncident: (incident: Incident) => void;
  onBudgets: () => void;
}) {
  const [readiness, setReadiness] = useState<ConfigurationData["summary"] | null>(null);
  const preview = connection.kind !== "connected";
  const attention = buildAttentionQueue(data);

  useEffect(() => {
    let cancelled = false;
    void api<ConfigurationData>("/api/configuration", token)
      .then(result => { if (!cancelled) setReadiness(result.summary); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [token, data.generatedAt]);

  return (
    <>
      {connection.kind === "local" && <LocalPreviewPanel connection={connection} scanError={scanError} onNavigate={onNavigate} />}
      {scanError && connection.kind !== "local" && (
        <p className="form-error page-error" role="alert">Account scan failed: {scanError}</p>
      )}

      <section className="stat-row" aria-label="Account status">
        <SpendStat data={data} preview={preview} />
        <button type="button" className={`stat-tile ${data.summary.openIncidents ? (data.summary.emergencyIncidents ? "danger" : "warning") : "good"}`} onClick={() => onNavigate("incidents")}>
          <span className="stat-label">Open incidents <Icon name="arrow" /></span>
          <strong>{data.summary.openIncidents}</strong>
          <small>
            {data.summary.openIncidents === 0
              ? "Nothing needs a response"
              : [data.summary.emergencyIncidents && `${data.summary.emergencyIncidents} emergency`, data.summary.criticalIncidents && `${data.summary.criticalIncidents} critical`]
                  .filter(Boolean).join(" · ") || "Review the response queue"}
          </small>
        </button>
        <button type="button" className={`stat-tile ${data.summary.coverageGaps ? "warning" : "good"}`} onClick={() => onNavigate("configuration")}>
          <span className="stat-label">Coverage gaps <Icon name="arrow" /></span>
          <strong>{data.summary.coverageGaps}</strong>
          <small>{data.summary.coverageGaps ? "Meters without trustworthy telemetry" : "Every cataloged meter is reporting"}</small>
        </button>
        <button type="button" className={`stat-tile ${readiness && readiness.needsAttention ? "danger" : readiness && readiness.configuredWorkers < readiness.workers ? "warning" : "neutral"}`} onClick={() => onNavigate("configuration")}>
          <span className="stat-label">Runtime protection <Icon name="arrow" /></span>
          <strong>{readiness ? `${readiness.configuredWorkers}/${readiness.workers}` : "—"}</strong>
          <small>
            {readiness
              ? `Workers fuse-ready · ${readiness.configuredNamespaces}/${readiness.namespaces} namespaces`
              : "Loading readiness…"}
          </small>
        </button>
      </section>

      <section className="spend-panel panel" aria-label="Spend detail">
        <div className="panel-head">
          <div>
            <h2 className="heading-with-info">
              {preview ? "Example daily spend — not live" : "Estimated daily spend"}
              <InfoTip label="How the spend estimate is calculated">
                <h4>Operational estimate</h4>
                <p>Brolly prices the latest five-minute Cloudflare analytics window and projects that rate across a day. Every 15 minutes it also requests a direct rolling 24-hour Durable Objects total.</p>
                <p>It is intentionally conservative and does not subtract included usage, credits, discounts, or contract pricing. The once-daily Billing API reconciliation is the authoritative comparison when a Billing Read token is installed.</p>
                {preview && <p><strong>This screen is not connected.</strong> Values shown here must not be used as a live account total.</p>}
              </InfoTip>
            </h2>
            <p className="panel-sub">{preview ? "Retained sample/stale data, shown only to preview the dashboard." : data.spend.label}</p>
          </div>
          <span className="estimate-pill">Estimate, not invoice</span>
        </div>
        <div className="spend-body">
          <div className="spend-chart-column">
            <SpendChart points={data.spend.history} />
          </div>
          <div className="spend-side">
            <table className="category-table">
              <caption className="visually-hidden">Estimated daily spend by product category</caption>
              <thead>
                <tr><th scope="col">Category</th><th scope="col">Estimate</th><th scope="col">Daily limit</th></tr>
              </thead>
              <tbody>
                {data.spend.categories.length ? data.spend.categories.map(category => {
                  const limits = data.policy.familyDailySpend[category.family];
                  const used = limits ? Math.min(1, category.estimatedUsd / Math.max(limits.emergency, 0.01)) : 0;
                  const tone = !limits ? "" : category.estimatedUsd >= limits.critical ? "danger" : category.estimatedUsd >= limits.warning ? "warning" : "good";
                  return (
                    <tr key={category.family}>
                      <td>
                        <span className="category-name">
                          <i style={{ background: categoryColor(category.family) }} aria-hidden="true" />
                          {category.label}
                          {category.coverage !== "healthy" && <em className="partial-tag" title="One or more billing signals for this product lack a collector">partial</em>}
                        </span>
                      </td>
                      <td className="numeric">{money(category.estimatedUsd)}</td>
                      <td className="numeric limit-cell">
                        {limits ? (
                          <span className={`limit-meter ${tone}`}>
                            <span>{money(limits.emergency)}</span>
                            <i aria-hidden="true"><b style={{ width: `${Math.max(3, used * 100)}%` }} /></i>
                          </span>
                        ) : "—"}
                      </td>
                    </tr>
                  );
                }) : (
                  <tr><td colSpan={3} className="empty-cell">The first aggregate spend snapshot will appear after the next scan.</td></tr>
                )}
              </tbody>
            </table>
            <div className="spend-side-links">
              <button type="button" className="link-button" onClick={onBudgets}>Adjust daily limits</button>
              <button type="button" className="link-button" onClick={() => onNavigate("configuration")}>See what is and isn't measured</button>
            </div>
          </div>
        </div>
        <footer className="panel-foot">
          <Icon name="info" />
          <span>{data.spend.note}</span>
          <span>{data.spend.updatedAt ? `Updated ${relativeTime(data.spend.updatedAt)}` : "Snapshot pending"}</span>
        </footer>
      </section>

      <div className="overview-columns">
        <section className="panel" aria-label="Needs attention">
          <div className="panel-head">
            <div>
              <h2>Needs attention</h2>
              <p className="panel-sub">Usage incidents and failed controls, most urgent first.</p>
            </div>
            {attention.incidents.length > 0 && (
              <button type="button" className="link-button" onClick={() => onNavigate("incidents")}>All incidents <Icon name="arrow" /></button>
            )}
          </div>
          {attention.incidents.length === 0 && attention.failedActions.length === 0 ? (
            <EmptyState title="All quiet" compact>
              {[
                "No usage incidents are open",
                data.summary.acknowledgedIncidents ? `${data.summary.acknowledgedIncidents} acknowledged incident${data.summary.acknowledgedIncidents === 1 ? " is" : "s are"} still tracked under Incidents & controls` : "",
                data.summary.coverageGaps ? `${data.summary.coverageGaps} telemetry coverage gap${data.summary.coverageGaps === 1 ? "" : "s"} still limit what Brolly can vouch for` : "every cataloged meter is reporting",
              ].filter(Boolean).join(". ") + "."}
            </EmptyState>
          ) : (
            <ul className="attention-list">
              {attention.failedActions.map(action => (
                <li key={action.id}>
                  <button type="button" className="attention-row" onClick={() => onNavigate("incidents")}>
                    <span className="severity failed"><i />failed</span>
                    <span className="attention-main">
                      <strong>{actionKindLabel(action.kind)} — {actionStateTitle(action.state)}</strong>
                      <small>{action.family} / {compactId(action.assetId)} · review and roll back if live state changed</small>
                    </span>
                    <Icon name="arrow" />
                  </button>
                </li>
              ))}
              {attention.incidents.map(incident => (
                <li key={incident.id}>
                  <button type="button" className="attention-row" onClick={() => onOpenIncident(incident)}>
                    <SeverityBadge severity={incident.severity} />
                    <span className="attention-main">
                      <strong>{incident.familyLabel} / {incident.assetName ?? compactId(incident.assetId)}</strong>
                      <small>{incident.metricLabel} · {measurement(incident.observed, incident.unit, incident.windowMs)} · {relativeTime(incident.lastSeen)}</small>
                    </span>
                    <Icon name="arrow" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel" aria-label="Recent control actions">
          <div className="panel-head">
            <div>
              <h2>Recent actions</h2>
              <p className="panel-sub">Reversible controls and their audit state.</p>
            </div>
            <button type="button" className="link-button" onClick={() => onNavigate("incidents")}>All actions <Icon name="arrow" /></button>
          </div>
          {data.actions.length ? (
            <ul className="attention-list">
              {data.actions.slice(0, 5).map(action => (
                <li key={action.id}>
                  <button type="button" className="attention-row" onClick={() => onNavigate("incidents")}>
                    <span className={`action-state ${action.state}`}>{action.state.replaceAll("_", " ")}</span>
                    <span className="attention-main">
                      <strong>{actionKindLabel(action.kind)}</strong>
                      <small>{action.family} / {compactId(action.assetId)} · {relativeTime(action.updatedAt)}</small>
                    </span>
                    <Icon name="arrow" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="shield" title="No control actions yet" compact>
              Emergency incidents can prepare reversible actions after the asset is classified.
            </EmptyState>
          )}
        </section>
      </div>

      <section className="panel monitor-note" aria-label="Monitoring cadence">
        <Icon name="clock" />
        <p>
          The bounded monitor runs every minute (~13 Cloudflare API calls for a one-page account), adds one rolling-24-hour
          Durable Objects query every 15 minutes, and reconciles the Billing API daily when a Billing Read token is installed.
          {data.summary.lastCheckAt ? ` Last pass ${relativeTime(data.summary.lastCheckAt)}.` : " No pass has completed yet."}
        </p>
        <button type="button" className="link-button" onClick={() => onNavigate("configuration")}>Monitoring details</button>
      </section>
    </>
  );
}

function SpendStat({ data, preview }: { data: DashboardData; preview: boolean }) {
  const delta = spendDelta(data.spend.history);
  const hours = delta ? Math.max(1, Math.round(delta.sinceMs / 3_600_000)) : 0;
  return (
    <div className="stat-tile hero">
      <span className="stat-label">{preview ? "Example spend (not live)" : "Estimated spend · rolling 24 h"}</span>
      <strong>{data.spend.updatedAt ? money(data.spend.estimatedTotalUsd) : "—"}</strong>
      {delta && Math.abs(delta.deltaUsd) >= 0.01 ? (
        <small className={delta.deltaUsd > 0 ? "trend-up" : "trend-down"}>
          <Icon name="trend" /> {delta.deltaUsd > 0 ? "+" : "−"}{money(Math.abs(delta.deltaUsd))} vs {hours} h ago
        </small>
      ) : (
        <small>{data.spend.updatedAt ? "Rate is steady across recent scans" : "Waiting for the first snapshot"}</small>
      )}
    </div>
  );
}

function LocalPreviewPanel({ connection, scanError, onNavigate }: {
  connection: ConnectionHealth;
  scanError: string;
  onNavigate: (route: Route) => void;
}) {
  return (
    <section className="local-preview panel" aria-label="Local preview status">
      <div className="local-preview-head">
        <span className="local-pill">Local preview</span>
        <p>{connection.detail}</p>
      </div>
      <div className="local-preview-grid">
        <div>
          <strong>Works now</strong>
          <p>Explore the sample UI, set budgets, configure encrypted notification targets, and read the control runbooks.</p>
        </div>
        <div>
          <strong>Needs a connected account</strong>
          <p>Live inventory, spend estimates, incident detection, Cloudflare shutdown actions, and alert delivery for new incidents.</p>
        </div>
        <div>
          <strong>To connect</strong>
          <p>Deploy Brolly, open its URL, and choose <em>Continue with Cloudflare</em> to authorize exactly one account, then use <em>Scan now</em>.</p>
        </div>
      </div>
      {(connection.errors.length > 0 || scanError) && (
        <ul className="local-preview-errors">
          {[...new Set([...connection.errors, scanError].filter(Boolean))].slice(0, 3).map(message => <li key={message}>{message}</li>)}
        </ul>
      )}
      <button type="button" className="link-button" onClick={() => onNavigate("configuration")}>Review connection details <Icon name="arrow" /></button>
    </section>
  );
}

function buildAttentionQueue(data: DashboardData) {
  return {
    incidents: data.incidents.filter(incident => incident.status === "open").slice(0, 6),
    failedActions: data.actions.filter(action => action.state === "failed").slice(0, 3),
  };
}
