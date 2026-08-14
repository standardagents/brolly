import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { dateTime, number } from "../format";
import type { AlertInstanceView, DataQuality } from "../types";
import { EmptyState, SeverityBadge } from "../components/ui";
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
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Threshold periods</p>
          <h2>Alert instances</h2>
          <p className="panel-sub">Every line crossing belongs to one local day or Cloudflare billing cycle. Silencing applies to this instance and preserves its rule and future periods.</p>
        </div>
        <select className="min-h-9 rounded border border-[var(--line)] bg-white px-3 text-sm" value={status} onChange={event => setStatus(event.target.value)}>
          <option value="">All states</option>
          <option value="open">Open</option>
          <option value="silenced">Silenced</option>
          <option value="resolved">Resolved</option>
          <option value="expired">Expired</option>
        </select>
      </div>
      {instances.length ? (
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Line</th><th>Target</th><th>Observed</th><th>Evidence</th><th>Period</th><th>Notifications</th><th /></tr></thead>
            <tbody>
              {instances.map(instance => (
                <tr key={instance.id}>
                  <td><span className="cell-main"><strong><SeverityBadge severity={severity(instance.label, instance.priority)} /> {instance.label}</strong><small>{instance.metricDefinitionId}</small></span></td>
                  <td><span className="cell-main"><strong>{instance.displayName}</strong><small>{instance.productFamily} · {instance.cloudflareId}</small></span></td>
                  <td className="numeric"><strong>{number(instance.observedValue)}</strong><small className="block text-[var(--faint)]">line {number(instance.thresholdValue)}</small></td>
                  <td><QualityBadge quality={instance.dataQuality as DataQuality} />{instance.historical ? <small className="ml-2 text-[var(--faint)]">historical</small> : null}</td>
                  <td><span className="cell-main"><strong>{new Date(instance.periodStartAt).toLocaleDateString()}</strong><small>through {new Date(instance.periodEndAt).toLocaleDateString()}</small></span></td>
                  <td><span className="cell-main"><strong>{instance.notificationCount}</strong><small>{instance.nextNotificationAt ? `Next ${dateTime(instance.nextNotificationAt)}` : instance.status}</small></span></td>
                  <td>{instance.status === "open" && <button className="button secondary" type="button" onClick={() => void silence(instance.id)}>Silence period</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyState icon="bell" title="No alert instances in this view">Threshold crossings appear here with their evidence and notification cadence.</EmptyState>}
      {error && <p className="form-error m-5" role="alert">{error}</p>}
    </section>
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
