import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { SpendChart, spendDelta } from "../components/SpendChart";
import { ActionStatePill, EmptyState, Icon, InfoTip, LinkButton, Panel, PanelFoot, PanelHead, SeverityBadge } from "../components/ui";
import { actionKindLabel, actionStateTitle } from "../components/ActionDrawer";
import { compactId, measurement, money, relativeTime } from "../format";
import type { ConnectionHealth } from "../lib/health";
import { categoryColor } from "../lib/meta";
import type { Route } from "../router";
import type { AlertLevel, ConfigurationData, DashboardData, Incident, SpendLimits } from "../types";

export function OverviewPage({ data, connection, token, scanError, scanSummary, onNavigate, onOpenIncident, onBudgets }: {
  data: DashboardData;
  connection: ConnectionHealth;
  token: string;
  scanError: string;
  scanSummary: string;
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
        <p
          className="mb-3.5 rounded-field border border-danger-line bg-danger-bg px-3 py-[9px] text-[13px] text-danger-ink [overflow-wrap:anywhere]"
          role="alert"
        >
          Account scan failed: {scanError}
        </p>
      )}
      {scanSummary && (
        <p className="mx-5 mb-3 flex items-start gap-[9px] rounded-field border border-line bg-panel-soft px-3 py-2.5 text-[12.5px] text-muted" role="status">
          <Icon name="check" className="mt-px size-[15px] flex-none" />
          <span>{scanSummary}</span>
        </p>
      )}

      <section className="mb-[18px] grid grid-cols-[1.3fr_1fr_1fr_1fr] gap-3 max-xl:grid-cols-2 max-md:grid-cols-1" aria-label="Account status">
        <SpendStat data={data} preview={preview} />
        <StatTile
          tone={data.summary.openIncidents ? (data.summary.emergencyIncidents ? "danger" : "warning") : "good"}
          label="Open incidents"
          value={data.summary.openIncidents}
          onClick={() => onNavigate("incidents")}
        >
          {data.summary.openIncidents === 0
            ? "Nothing needs a response"
            : [data.summary.emergencyIncidents && `${data.summary.emergencyIncidents} emergency`, data.summary.criticalIncidents && `${data.summary.criticalIncidents} critical`]
                .filter(Boolean).join(" · ") || "Review the response queue"}
        </StatTile>
        <StatTile
          tone={data.summary.coverageGaps ? "warning" : "good"}
          label="Coverage gaps"
          value={data.summary.coverageGaps}
          onClick={() => onNavigate("configuration")}
        >
          {data.summary.coverageGaps ? "Meters without trustworthy telemetry" : "Every cataloged meter is reporting"}
        </StatTile>
        <StatTile
          tone={readiness && readiness.needsAttention ? "danger" : readiness && readiness.configuredWorkers < readiness.workers ? "warning" : "neutral"}
          label="Runtime protection"
          value={readiness ? `${readiness.configuredWorkers}/${readiness.workers}` : "—"}
          onClick={() => onNavigate("configuration")}
        >
          {readiness
            ? `Workers fuse-ready · ${readiness.configuredNamespaces}/${readiness.namespaces} namespaces`
            : "Loading readiness…"}
        </StatTile>
      </section>

      <Panel aria-label="Spend detail">
        <PanelHead
          title={preview ? "Example daily spend — not live" : "Estimated daily spend"}
          titleExtra={
            <InfoTip label="How the spend estimate is calculated">
              <h4>Operational estimate</h4>
              <p>Brolly stores overlapping five-minute Cloudflare analytics windows in correction-safe daily accumulators. Sealed daily history stays available for charts while live totals continue to update.</p>
              <p>Hourly Billing Read reconciliation supplies authoritative aggregate charges and billing-cycle boundaries. Granular values remain labeled as modeled estimates or proportional allocations.</p>
              {preview && <p><strong>This screen is not connected.</strong> Values shown here must not be used as a live account total.</p>}
            </InfoTip>
          }
          sub={preview ? "Retained sample/stale data, shown only to preview the dashboard." : data.spend.label}
          actions={
            <span className="inline-flex flex-none items-center gap-[7px] rounded-full border border-line bg-panel-soft px-[11px] py-1.5 text-[12px] font-[650] text-muted">
              Estimate, not invoice
            </span>
          }
        />
        <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-[22px] px-5 pt-1 pb-4 max-xl:grid-cols-[minmax(0,1fr)]">
          <div className="min-w-0">
            <SpendChart points={data.spend.history} />
          </div>
          <div className="flex flex-col border-l border-line-soft pl-[22px] max-xl:border-l-0 max-xl:pl-0">
            <table className="w-full border-collapse text-[13px]">
              <caption className="sr-only">Estimated daily spend by product category</caption>
              <thead>
                <tr>
                  <th scope="col" className="px-0 pt-1 pb-2 text-left text-[10.5px] font-[780] uppercase tracking-[.08em] text-faint">Category</th>
                  <th scope="col" className="px-0 pt-1 pb-2 text-right text-[10.5px] font-[780] uppercase tracking-[.08em] text-faint">Estimate</th>
                  <th scope="col" className="px-0 pt-1 pb-2 text-right text-[10.5px] font-[780] uppercase tracking-[.08em] text-faint">Daily limit</th>
                </tr>
              </thead>
              <tbody>
                {data.spend.categories.length ? data.spend.categories.map(category => {
                  const limits = data.policy.familyDailySpend[category.family];
                  const levels = limits ? spendLevels(data, limits) : [];
                  const highest = levels[levels.length - 1];
                  const highestValue = highest ? limits?.[highest.id] ?? 0 : 0;
                  const crossed = limits ? levels.reduce((index, level, levelIndex) => category.estimatedUsd >= (limits[level.id] ?? Number.POSITIVE_INFINITY) ? levelIndex : index, -1) : -1;
                  const used = limits ? Math.min(1, category.estimatedUsd / Math.max(highestValue, 0.01)) : 0;
                  const tone = !limits ? "neutral" : crossed === levels.length - 1 && crossed >= 0 ? "danger" : crossed >= 0 ? "warning" : "good";
                  return (
                    <tr key={category.family}>
                      <td className="border-t border-line-soft py-2">
                        <span className="inline-flex items-center gap-2">
                          <i className="size-[9px] flex-none rounded-[2px]" style={{ background: categoryColor(category.family) }} aria-hidden="true" />
                          {category.label}
                          {category.coverage !== "healthy" && (
                            <em className="rounded-[3px] bg-warn-bg px-[5px] py-px text-[10px] font-[750] uppercase not-italic text-warn" title="One or more billing signals for this product lack a collector">partial</em>
                          )}
                        </span>
                      </td>
                      <td className="border-t border-line-soft py-2 text-right whitespace-nowrap tabular-nums">{money(category.estimatedUsd)}</td>
                      <td className="min-w-[108px] border-t border-line-soft py-2 text-right whitespace-nowrap tabular-nums">
                        {limits ? (
                          <span className="inline-flex flex-col items-end gap-[3px] text-[12px] text-faint">
                            <span>{highest ? `${money(highestValue)} ${highest.label}` : "Unset"}</span>
                            <i aria-hidden="true" className="block h-1 w-[84px] overflow-hidden rounded-[3px] bg-line-soft">
                              <b className={`block h-full rounded-[3px] ${METER_FILL[tone]}`} style={{ width: `${Math.max(3, used * 100)}%` }} />
                            </i>
                          </span>
                        ) : "—"}
                      </td>
                    </tr>
                  );
                }) : (
                  <tr><td colSpan={3} className="border-t border-line-soft py-2 text-faint">The first aggregate spend snapshot will appear after the next scan.</td></tr>
                )}
              </tbody>
            </table>
            <div className="mt-auto flex flex-col items-start gap-[7px] pt-3">
              <LinkButton onClick={onBudgets}>Adjust daily limits</LinkButton>
              <LinkButton onClick={() => onNavigate("configuration")}>Review collection coverage</LinkButton>
            </div>
          </div>
        </div>
        <PanelFoot icon="info" aside={data.spend.updatedAt ? `Updated ${relativeTime(data.spend.updatedAt)}` : "Snapshot pending"}>
          {data.spend.note}
        </PanelFoot>
      </Panel>

      <div className="grid grid-cols-[1.35fr_1fr] items-start gap-3 max-xl:grid-cols-[minmax(0,1fr)]">
        <Panel aria-label="Needs attention">
          <PanelHead
            title="Needs attention"
            sub="Usage incidents and failed controls, most urgent first."
            actions={attention.incidents.length > 0
              ? <LinkButton onClick={() => onNavigate("incidents")}>All incidents <Icon name="arrow" /></LinkButton>
              : undefined}
          />
          {attention.incidents.length === 0 && attention.failedActions.length === 0 ? (
            <EmptyState title="All quiet" compact>
              {[
                "No usage incidents are open",
                data.summary.acknowledgedIncidents ? `${data.summary.acknowledgedIncidents} acknowledged incident${data.summary.acknowledgedIncidents === 1 ? " is" : "s are"} still tracked under Incidents & controls` : "",
                data.summary.coverageGaps ? `${data.summary.coverageGaps} telemetry coverage gap${data.summary.coverageGaps === 1 ? "" : "s"} still limit what Brolly can vouch for` : "every cataloged meter is reporting",
              ].filter(Boolean).join(". ") + "."}
            </EmptyState>
          ) : (
            <ul className="m-0 list-none p-0 pb-1.5">
              {attention.failedActions.map(action => (
                <li key={action.id}>
                  <AttentionRow
                    lead={<SeverityBadge severity="failed" />}
                    title={`${actionKindLabel(action.kind)} — ${actionStateTitle(action.state)}`}
                    detail={`${action.family} / ${compactId(action.assetId)} · review and roll back if live state changed`}
                    onClick={() => onNavigate("incidents")}
                  />
                </li>
              ))}
              {attention.incidents.map(incident => (
                <li key={incident.id}>
                  <AttentionRow
                    lead={<SeverityBadge severity={incident.severity} />}
                    title={`${incident.familyLabel} / ${incident.assetName ?? compactId(incident.assetId)}`}
                    detail={`${incident.metricLabel} · ${measurement(incident.observed, incident.unit, incident.windowMs)} · ${relativeTime(incident.lastSeen)}`}
                    onClick={() => onOpenIncident(incident)}
                  />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel aria-label="Recent control actions">
          <PanelHead
            title="Recent actions"
            sub="Reversible controls and their audit state."
            actions={<LinkButton onClick={() => onNavigate("incidents")}>All actions <Icon name="arrow" /></LinkButton>}
          />
          {data.actions.length ? (
            <ul className="m-0 list-none p-0 pb-1.5">
              {data.actions.slice(0, 5).map(action => (
                <li key={action.id}>
                  <AttentionRow
                    lead={<ActionStatePill state={action.state} />}
                    title={actionKindLabel(action.kind)}
                    detail={`${action.family} / ${compactId(action.assetId)} · ${relativeTime(action.updatedAt)}`}
                    onClick={() => onNavigate("incidents")}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="shield" title="No control actions yet" compact>
              Emergency incidents can prepare reversible actions after the asset is classified.
            </EmptyState>
          )}
        </Panel>
      </div>

      <Panel className="flex items-start gap-2.5 px-5 py-[13px]" aria-label="Monitoring cadence">
        <Icon name="clock" className="mt-0.5 size-[17px] flex-none text-faint" />
        <p className="m-0 flex-1 text-[12.5px] text-muted">
          The bounded monitor runs every minute (~13 Cloudflare API calls for a one-page account), adds one rolling-24-hour
          Durable Objects query every 15 minutes, and reconciles the Billing API daily when a Billing Read token is installed.
          {data.summary.lastCheckAt ? ` Last pass ${relativeTime(data.summary.lastCheckAt)}.` : " No pass has completed yet."}
        </p>
        <LinkButton className="mt-0.5 whitespace-nowrap" onClick={() => onNavigate("configuration")}>Monitoring details</LinkButton>
      </Panel>
    </>
  );
}

type StatTone = "hero" | "good" | "warning" | "danger" | "neutral";

const TILE_BASE = "flex min-h-[104px] flex-col items-start gap-1 rounded-panel border border-line bg-panel px-4 py-3.5 text-left shadow-panel";
const TILE_ACCENT: Record<StatTone, string> = {
  hero: "border-l-[3px] border-l-orange",
  good: "",
  warning: "border-l-[3px] border-l-[#e0a53a]",
  danger: "border-l-[3px] border-l-danger",
  neutral: "",
};
const TILE_VALUE: Record<StatTone, string> = {
  hero: "",
  good: "text-good",
  warning: "text-warn",
  danger: "text-danger",
  neutral: "",
};
const METER_FILL: Record<"neutral" | "good" | "warning" | "danger", string> = {
  neutral: "bg-[#9aa4b0] dark:bg-[#7c8793]",
  good: "bg-[#24a468]",
  warning: "bg-[#e0a53a]",
  danger: "bg-danger",
};
/** Stat label line: muted caption plus the faint affordance arrow. */
function StatLabel({ children, arrow = true }: { children: ReactNode; arrow?: boolean }) {
  return (
    <span className="inline-flex items-center gap-[5px] text-[12px] font-[680] text-muted">
      {children}
      {arrow && <Icon name="arrow" className="size-[13px] text-faint" />}
    </span>
  );
}

/** Clickable summary tile in the account status row. */
function StatTile({ tone, label, value, children, onClick }: {
  tone: StatTone;
  label: string;
  value: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${TILE_BASE} ${TILE_ACCENT[tone]} cursor-pointer transition-[border-color,box-shadow] duration-[130ms] hover:border-[#b9c1ca] hover:shadow-[0_6px_18px_#10182812] dark:hover:border-[#59626d]`}
      onClick={onClick}
    >
      <StatLabel>{label}</StatLabel>
      <strong className={`text-[27px] leading-[1.1] tracking-[-.02em] tabular-nums ${TILE_VALUE[tone]}`}>{value}</strong>
      <small className="inline-flex items-center gap-[5px] text-[12px] text-faint">{children}</small>
    </button>
  );
}

/** One row in the attention / recent actions lists. */
function AttentionRow({ lead, title, detail, onClick }: { lead: ReactNode; title: string; detail: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="grid w-full cursor-pointer grid-cols-[92px_minmax(0,1fr)_16px] items-center gap-3 border-0 border-t border-line-soft bg-transparent px-5 py-[11px] text-left [font:inherit] hover:bg-hover"
      onClick={onClick}
    >
      {lead}
      <span className="flex min-w-0 flex-col gap-[3px]">
        <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px]">{title}</strong>
        <small className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-faint">{detail}</small>
      </span>
      <Icon name="arrow" className="size-[15px] text-faint" />
    </button>
  );
}

function SpendStat({ data, preview }: { data: DashboardData; preview: boolean }) {
  const delta = spendDelta(data.spend.history);
  const hours = delta ? Math.max(1, Math.round(delta.sinceMs / 3_600_000)) : 0;
  return (
    <div className={`${TILE_BASE} ${TILE_ACCENT.hero} cursor-default`}>
      <StatLabel arrow={false}>{preview ? "Example spend (not live)" : "Estimated spend · rolling 24 h"}</StatLabel>
      <strong className="text-[27px] leading-[1.1] tracking-[-.02em] tabular-nums">{data.spend.updatedAt ? money(data.spend.estimatedTotalUsd) : "—"}</strong>
      {delta && Math.abs(delta.deltaUsd) >= 0.01 ? (
        <small className={`inline-flex items-center gap-[5px] text-[12px] font-[680] ${delta.deltaUsd > 0 ? "text-danger" : "text-good [&>svg]:-scale-y-100"}`}>
          <Icon name="trend" className="size-[13px]" /> {delta.deltaUsd > 0 ? "+" : "−"}{money(Math.abs(delta.deltaUsd))} vs {hours} h ago
        </small>
      ) : (
        <small className="inline-flex items-center gap-[5px] text-[12px] text-faint">{data.spend.updatedAt ? "Rate is steady across recent scans" : "Waiting for the first snapshot"}</small>
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
    <Panel className="pb-3.5" aria-label="Local preview status">
      <div className="flex flex-wrap items-start gap-3 px-5 pt-4 pb-1">
        <span className="flex-none rounded-full border border-dashed border-[#aab3bd] bg-[#eceff2] px-[11px] py-[5px] text-[12px] font-[750] text-[#4d5560] dark:border-[#59626d] dark:bg-[#252a31] dark:text-chip-ink">Local preview</span>
        <p className="mt-0.5 max-w-[84ch] text-[13px] text-muted">{connection.detail}</p>
      </div>
      <div className="grid grid-cols-3 gap-3 px-5 pt-3 pb-1 max-md:grid-cols-1">
        <div>
          <strong className="mb-[3px] block text-[12.5px]">Works now</strong>
          <p className="m-0 text-[12.5px] leading-[1.55] text-muted">Explore the sample UI, set budgets, configure encrypted notification targets, and read the control runbooks.</p>
        </div>
        <div>
          <strong className="mb-[3px] block text-[12.5px]">Needs a connected account</strong>
          <p className="m-0 text-[12.5px] leading-[1.55] text-muted">Live inventory, spend estimates, incident detection, Cloudflare shutdown actions, and alert delivery for new incidents.</p>
        </div>
        <div>
          <strong className="mb-[3px] block text-[12.5px]">To connect</strong>
          <p className="m-0 text-[12.5px] leading-[1.55] text-muted">Deploy Brolly, open its URL, and choose <em>Login with Cloudflare</em> to authorize exactly one account, then use <em>Scan now</em>.</p>
        </div>
      </div>
      {(connection.errors.length > 0 || scanError) && (
        <ul className="mx-5 mt-2 mb-1 list-disc pl-[18px] text-[12.5px] text-muted">
          {[...new Set([...connection.errors, scanError].filter(Boolean))].slice(0, 3).map(message => (
            <li key={message} className="mb-[3px] [overflow-wrap:anywhere]">{message}</li>
          ))}
        </ul>
      )}
      <LinkButton className="mt-2 mb-1 ml-5" onClick={() => onNavigate("configuration")}>Review connection details <Icon name="arrow" /></LinkButton>
    </Panel>
  );
}

function buildAttentionQueue(data: DashboardData) {
  return {
    incidents: data.incidents.filter(incident => incident.status === "open").slice(0, 6),
    failedActions: data.actions.filter(action => action.state === "failed").slice(0, 3),
  };
}

function spendLevels(data: DashboardData, limits: SpendLimits): AlertLevel[] {
  return data.alertLevels?.length
    ? data.alertLevels
    : Object.keys(limits).map((id, position) => ({ id, position, label: id, entries: [] }));
}
