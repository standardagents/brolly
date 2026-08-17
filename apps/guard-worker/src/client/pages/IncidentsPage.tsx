import { useEffect, useState } from "react";
import { ActionDrawer, actionKindLabel } from "../components/ActionDrawer";
import { IncidentDrawer } from "../components/IncidentDrawer";
import { ActionStatePill, EmptyState, Icon, InfoTip, LinkButton, Panel, PanelHead, Pill, Segmented, SeverityBadge, Table, TableScroll, Td, Th, Tr, type Tone } from "../components/ui";
import { compactId, measurement, money, number, relativeTime } from "../format";
import type { ControlActionRow, DashboardData, Incident } from "../types";

type StatusFilter = "open" | "acknowledged" | "all";

const MODE_TONE: Record<string, Tone> = {
  approval: "warn",
  automatic: "danger",
};

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
      <Panel aria-label="Usage incidents">
        <PanelHead
          title="Usage incidents"
          titleExtra={
            <InfoTip label="What counts as an incident?">
              <h4>A limit or anomaly needs review</h4>
              <p>Incidents represent observed usage that crossed a configured warning, critical, or emergency boundary. They are separate from connection and telemetry failures, which are tracked as coverage gaps on the Configuration page.</p>
              <p>Open incidents still need review. Acknowledging an incident removes it from the active queue but does not change limits or stop the resource.</p>
            </InfoTip>
          }
          sub="Spend or activity crossed a limit. Open a row to inspect the measurement and respond."
          actions={
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
          }
        />
        {incidents.length ? (
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th scope="col">Severity</Th>
                  <Th scope="col">Asset</Th>
                  <Th scope="col">Observed</Th>
                  <Th scope="col">Limit</Th>
                  <Th scope="col">Last detected</Th>
                  <Th scope="col"><span className="sr-only">Open</span></Th>
                </tr>
              </thead>
              <tbody>
                {incidents.map(incident => (
                  <Tr key={incident.id} clickable onClick={() => setSelected(incident)}>
                    <Td><SeverityBadge severity={incident.severity} /></Td>
                    <Td>
                      <span className="flex min-w-0 flex-col gap-[3px]">
                        <strong className="max-w-[46ch] truncate">{incident.familyLabel} / {incident.assetName ?? compactId(incident.assetId)}</strong>
                        <small className="text-[12px] text-faint">{incident.metricLabel}{incident.status === "acknowledged" ? " · acknowledged" : ""}</small>
                      </span>
                    </Td>
                    <Td numeric>{measurement(incident.observed, incident.unit, incident.windowMs)}</Td>
                    <Td numeric>{incident.threshold == null ? "Anomaly vs. baseline" : incident.unit === "usd" ? money(incident.threshold) : number(incident.threshold)}</Td>
                    <Td>{relativeTime(incident.lastSeen)}</Td>
                    <Td className="whitespace-nowrap text-right">
                      <LinkButton onClick={event => { event.stopPropagation(); setSelected(incident); }}>
                        Review <Icon name="arrow" />
                      </LinkButton>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        ) : (
          <EmptyState title="No incidents in this view">
            Telemetry coverage gaps are tracked separately on the Configuration page so missing data never hides here.
          </EmptyState>
        )}
      </Panel>

      <Panel aria-label="Control actions">
        <PanelHead
          title="Control actions"
          titleExtra={
            <InfoTip label="What is recorded here?">
              <h4>Every stage of enforcement</h4>
              <p>Prepared means Brolly computed a safe action but has not changed service. Succeeded means the stop was applied. Rolled back means the stored pre-change configuration was restored. Failed actions retain their error and audit record.</p>
              <p>Rollback state is snapshotted to the database and audited before Brolly touches Cloudflare.</p>
            </InfoTip>
          }
          sub="Open an action to inspect its impact, execute a prepared control, or restore service."
          actions={
            <Pill tone={MODE_TONE[data.policy.mode] ?? "neutral"} className="px-2.5 py-1.5 text-[12px] font-bold capitalize">
              {data.policy.mode} mode
            </Pill>
          }
        />
        {data.actions.length ? (
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th scope="col">State</Th>
                  <Th scope="col">Control</Th>
                  <Th scope="col">Target</Th>
                  <Th scope="col">Last change</Th>
                  <Th scope="col"><span className="sr-only">Open</span></Th>
                </tr>
              </thead>
              <tbody>
                {data.actions.map(action => (
                  <Tr key={action.id} clickable onClick={() => setSelectedAction(action)}>
                    <Td>
                      <ActionStatePill state={action.state} className="font-[780]" />
                    </Td>
                    <Td><strong>{actionKindLabel(action.kind)}</strong></Td>
                    <Td><code className="text-muted">{action.family}/{compactId(action.assetId)}</code></Td>
                    <Td>{relativeTime(action.updatedAt)}</Td>
                    <Td className="whitespace-nowrap text-right">
                      <LinkButton onClick={event => { event.stopPropagation(); setSelectedAction(action); }}>
                        Inspect <Icon name="arrow" />
                      </LinkButton>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        ) : (
          <EmptyState icon="shield" title="No control actions yet">
            Emergency incidents can prepare reversible actions after the asset is classified.
          </EmptyState>
        )}
      </Panel>

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
