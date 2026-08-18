import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { dateTime, number } from "../format";
import type { AlertInstanceView, DataQuality } from "../types";
import { Button, CellStack, EmptyState, Notice, Panel, PanelHead, SeverityBadge, Table, TableScroll, Td, Th, Tr } from "../components/ui";
import { QualityBadge } from "./UsagePage";
import { useAlertLevels } from "../onboarding/levels";

export function AlertInstancesPage({ token }: { token: string }) {
  const board = useAlertLevels(token);
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

  async function acknowledge(id: string) {
    setError("");
    try {
      await api(`/api/alerts/${encodeURIComponent(id)}/acknowledge`, token, { method: "POST" });
      await load();
    } catch (cause) { setError(message(cause)); }
  }

  return (
    <Panel>
      <PanelHead
        eyebrow="Threshold periods"
        title="Alert instances"
        sub="Each threshold crossing belongs to one local day or Cloudflare billing cycle. Acknowledgement stops repeat notifications for that instance."
        actions={
          <select
            className="min-h-9 rounded border border-line bg-panel px-3 text-sm text-ink"
            value={status}
            onChange={event => setStatus(event.target.value)}
          >
            <option value="">All states</option>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
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
                  <Td><CellStack title={<><SeverityBadge severity={severity(instance.priority, board.levels.length)} /> {instance.label}</>} sub={instance.metricDefinitionId} /></Td>
                  <Td><CellStack title={instance.displayName} sub={<>{instance.productFamily} · {instance.cloudflareId}</>} /></Td>
                  <Td numeric><strong>{number(instance.observedValue)}</strong><small className="block text-faint">line {number(instance.thresholdValue)}</small></Td>
                  <Td><QualityBadge quality={instance.dataQuality as DataQuality} />{instance.historical ? <small className="ml-2 text-faint">historical</small> : null}</Td>
                  <Td><CellStack title={new Date(instance.periodStartAt).toLocaleDateString()} sub={`through ${new Date(instance.periodEndAt).toLocaleDateString()}`} /></Td>
                  <Td><CellStack title={instance.notificationCount} sub={instance.nextNotificationAt ? `Next ${dateTime(instance.nextNotificationAt)}` : instance.status} /></Td>
                  <Td>{instance.status === "open" && <Button variant="secondary" onClick={() => void acknowledge(instance.id)}>Acknowledge</Button>}</Td>
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

function severity(priority: number, levelCount: number): string {
  if (levelCount === 0) return "warning";
  const position = Math.floor(priority / 10);
  if (position >= levelCount - 1) return "emergency";
  if (levelCount >= 3 && position >= levelCount - 2) return "critical";
  return "warning";
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
