import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { dateTime, number } from "../format";
import type { AlertInstanceView, DataQuality } from "../types";
import { Button, CellStack, EmptyState, Notice, Panel, PanelHead, SeverityBadge, Table, TableScroll, Td, Th, Tr } from "../components/ui";
import { QualityBadge } from "./UsagePage";

export function AlertInstancesPage({ token }: { token: string }) {
  const [instances, setInstances] = useState<AlertInstanceView[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    const result = await api<{ instances: AlertInstanceView[] }>(`/api/alert-instances?${params}`, token);
    setInstances(result.instances);
  }, [status, token]);

  useEffect(() => { void load().catch(cause => setError(message(cause))); }, [load]);

  async function silence(id: string) {
    setError("");
    try {
      await api(`/api/alert-instances/${encodeURIComponent(id)}/silence`, token, { method: "POST" });
      await load();
    } catch (cause) { setError(message(cause)); }
  }

  return (
    <Panel>
      <PanelHead
        eyebrow="Threshold periods"
        title="Alert instances"
        sub="Every line crossing belongs to one local day or Cloudflare billing cycle. Silencing applies to this instance and preserves its rule and future periods."
        actions={
          <select
            className="min-h-9 rounded border border-line bg-panel px-3 text-sm text-ink"
            value={status}
            onChange={event => setStatus(event.target.value)}
          >
            <option value="">All states</option>
            <option value="open">Open</option>
            <option value="silenced">Silenced</option>
            <option value="resolved">Resolved</option>
            <option value="expired">Expired</option>
          </select>
        }
      />
      {instances.length ? (
        <TableScroll>
          <Table>
            <thead><tr><Th>Line</Th><Th>Target</Th><Th>Observed</Th><Th>Evidence</Th><Th>Period</Th><Th>Notifications</Th><Th /></tr></thead>
            <tbody>
              {instances.map(instance => (
                <Tr key={instance.id}>
                  <Td><CellStack title={<><SeverityBadge severity={severity(instance.label, instance.priority)} /> {instance.label}</>} sub={instance.metricDefinitionId} /></Td>
                  <Td><CellStack title={instance.displayName} sub={<>{instance.productFamily} · {instance.cloudflareId}</>} /></Td>
                  <Td numeric><strong>{number(instance.observedValue)}</strong><small className="block text-faint">line {number(instance.thresholdValue)}</small></Td>
                  <Td><QualityBadge quality={instance.dataQuality as DataQuality} />{instance.historical ? <small className="ml-2 text-faint">historical</small> : null}</Td>
                  <Td><CellStack title={new Date(instance.periodStartAt).toLocaleDateString()} sub={`through ${new Date(instance.periodEndAt).toLocaleDateString()}`} /></Td>
                  <Td><CellStack title={instance.notificationCount} sub={instance.nextNotificationAt ? `Next ${dateTime(instance.nextNotificationAt)}` : instance.status} /></Td>
                  <Td>{instance.status === "open" && <Button variant="secondary" onClick={() => void silence(instance.id)}>Silence period</Button>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      ) : <EmptyState icon="bell" title="No alert instances in this view">Threshold crossings appear here with their evidence and notification cadence.</EmptyState>}
      {error && <Notice tone="error" className="m-5">{error}</Notice>}
    </Panel>
  );
}

function severity(label: string, priority: number): string {
  if (label.toLowerCase() === "emergency" || priority >= 100) return "emergency";
  if (label.toLowerCase() === "critical" || priority >= 75) return "critical";
  return "warning";
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
