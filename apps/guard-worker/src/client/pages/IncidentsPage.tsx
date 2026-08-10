import { useEffect, useState } from "react";
import { ActionDrawer, actionKindLabel } from "../components/ActionDrawer";
import { IncidentDrawer } from "../components/IncidentDrawer";
import { EmptyState, Icon, InfoTip, Segmented, SeverityBadge } from "../components/ui";
import { compactId, measurement, money, number, relativeTime } from "../format";
import type { ControlActionRow, DashboardData, Incident } from "../types";

type StatusFilter = "open" | "acknowledged" | "all";

export function IncidentsPage({ data, token, onRefresh, focusIncidentId, onFocusHandled }: {
  data: DashboardData;
  token: string;
  onRefresh: () => Promise<DashboardData>;
  focusIncidentId: string | null;
  onFocusHandled: () => void;
}) {
  const [filter, setFilter] = useState<StatusFilter>("open");
  const [selected, setSelected] = useState<Incident | null>(null);
  const [selectedAction, setSelectedAction] = useState<ControlActionRow | null>(null);

  useEffect(() => {
    if (!focusIncidentId) return;
    const incident = data.incidents.find(item => item.id === focusIncidentId);
    if (incident) {
      setSelected(incident);
      if (incident.status !== "open") setFilter("all");
    }
    onFocusHandled();
  }, [focusIncidentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const incidents = data.incidents.filter(item => filter === "all" || item.status === filter);
  const actionIncident = selectedAction ? data.incidents.find(item => item.id === selectedAction.incidentId) ?? null : null;

  return (
    <>
      <section className="panel" aria-label="Usage incidents">
        <div className="panel-head">
          <div>
            <h2 className="heading-with-info">
              Usage incidents
              <InfoTip label="What counts as an incident?">
                <h4>A limit or anomaly needs review</h4>
                <p>Incidents represent observed usage that crossed a configured warning, critical, or emergency boundary. They are separate from connection and telemetry failures, which are tracked as coverage gaps on the Configuration page.</p>
                <p>Open incidents still need review. Acknowledging an incident removes it from the active queue but does not change limits or stop the resource.</p>
              </InfoTip>
            </h2>
            <p className="panel-sub">Spend or activity crossed a limit. Open a row to inspect the measurement and respond.</p>
          </div>
          <Segmented
            ariaLabel="Filter incidents by status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "open", label: "Open" },
              { value: "acknowledged", label: "Acknowledged" },
              { value: "all", label: `All ${data.incidents.length}` },
            ]}
          />
        </div>
        {incidents.length ? (
          <div className="table-scroll">
            <table className="data-table incident-table">
              <thead>
                <tr>
                  <th scope="col">Severity</th>
                  <th scope="col">Asset</th>
                  <th scope="col">Observed</th>
                  <th scope="col">Limit</th>
                  <th scope="col">Last detected</th>
                  <th scope="col"><span className="visually-hidden">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {incidents.map(incident => (
                  <tr key={incident.id} className="clickable" onClick={() => setSelected(incident)}>
                    <td><SeverityBadge severity={incident.severity} /></td>
                    <td>
                      <span className="cell-main">
                        <strong>{incident.familyLabel} / {incident.assetName ?? compactId(incident.assetId)}</strong>
                        <small>{incident.metricLabel}{incident.status === "acknowledged" ? " · acknowledged" : ""}</small>
                      </span>
                    </td>
                    <td className="numeric">{measurement(incident.observed, incident.unit, incident.windowMs)}</td>
                    <td className="numeric">{incident.threshold == null ? "Anomaly vs. baseline" : incident.unit === "usd" ? money(incident.threshold) : number(incident.threshold)}</td>
                    <td>{relativeTime(incident.lastSeen)}</td>
                    <td className="row-open">
                      <button type="button" className="link-button" onClick={event => { event.stopPropagation(); setSelected(incident); }}>
                        Review <Icon name="arrow" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No incidents in this view">
            Telemetry coverage gaps are tracked separately on the Configuration page so missing data never hides here.
          </EmptyState>
        )}
      </section>

      <section className="panel" aria-label="Control actions">
        <div className="panel-head">
          <div>
            <h2 className="heading-with-info">
              Control actions
              <InfoTip label="What is recorded here?">
                <h4>Every stage of enforcement</h4>
                <p>Prepared means Brolly computed a safe action but has not changed service. Succeeded means the stop was applied. Rolled back means the stored pre-change configuration was restored. Failed actions retain their error and audit record.</p>
                <p>Rollback state is snapshotted to the database and audited before Brolly touches Cloudflare.</p>
              </InfoTip>
            </h2>
            <p className="panel-sub">Open an action to inspect its impact, execute a prepared control, or restore service.</p>
          </div>
          <span className={`mode-pill ${data.policy.mode}`}>{data.policy.mode} mode</span>
        </div>
        {data.actions.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">State</th>
                  <th scope="col">Control</th>
                  <th scope="col">Target</th>
                  <th scope="col">Last change</th>
                  <th scope="col"><span className="visually-hidden">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {data.actions.map(action => (
                  <tr key={action.id} className="clickable" onClick={() => setSelectedAction(action)}>
                    <td><span className={`action-state ${action.state}`}>{action.state.replaceAll("_", " ")}</span></td>
                    <td><strong>{actionKindLabel(action.kind)}</strong></td>
                    <td><code className="soft-code">{action.family}/{compactId(action.assetId)}</code></td>
                    <td>{relativeTime(action.updatedAt)}</td>
                    <td className="row-open">
                      <button type="button" className="link-button" onClick={event => { event.stopPropagation(); setSelectedAction(action); }}>
                        Inspect <Icon name="arrow" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon="shield" title="No control actions yet">
            Emergency incidents can prepare reversible actions after the asset is classified.
          </EmptyState>
        )}
      </section>

      {selected && (
        <IncidentDrawer
          incident={selected}
          token={token}
          onClose={() => setSelected(null)}
          onChanged={async () => {
            const next = await onRefresh();
            setSelected(next.incidents.find(item => item.id === selected.id) ?? null);
          }}
        />
      )}
      {selectedAction && (
        <ActionDrawer
          action={selectedAction}
          incident={actionIncident}
          token={token}
          onClose={() => setSelectedAction(null)}
          onChanged={async () => {
            const next = await onRefresh();
            setSelectedAction(next.actions.find(item => item.id === selectedAction.id) ?? null);
          }}
        />
      )}
    </>
  );
}
