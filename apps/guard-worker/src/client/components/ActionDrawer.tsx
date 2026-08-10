import { useState } from "react";
import { api } from "../api";
import { compactId, dateTime, metricTitle } from "../format";
import { humanizeReason } from "./IncidentDrawer";
import type { ControlActionRow, Incident } from "../types";
import { ObjectStopImpact } from "./protection";
import { Drawer, Icon } from "./ui";

export function actionStateTitle(state: string): string {
  const titles: Record<string, string> = {
    prepared: "Ready for approval",
    approved: "Stop approved",
    running: "Change in progress",
    succeeded: "Service is stopped",
    failed: "Control needs attention",
    rolled_back: "Service restored",
  };
  return titles[state] ?? metricTitle(state);
}

export function actionStateDescription(state: string): string {
  const descriptions: Record<string, string> = {
    prepared: "Brolly saved the requested action, but has not changed live service.",
    approved: "The operator approved the stop and Brolly is beginning the change.",
    running: "Brolly is applying or rolling back the control. Refresh before taking another action.",
    succeeded: "The stop completed and its rollback snapshot is available.",
    failed: "The last operation did not complete. Review the error and Cloudflare's live state before preparing another action.",
    rolled_back: "Brolly restored the saved pre-action state and completed the rollback.",
  };
  return descriptions[state] ?? "Review the audit state before making another change.";
}

export function actionKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    runtime_quarantine: "Runtime quarantine",
    disable_trigger: "Retired Worker ingress control",
    pause_consumer: "Pause queue consumer",
  };
  return labels[kind] ?? metricTitle(kind);
}

export function ActionDrawer({ action, incident, token, onClose, onChanged }: {
  action: ControlActionRow;
  incident: Incident | null;
  token: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const stopped = action.state === "succeeded";
  const canExecute = action.state === "prepared" || action.state === "failed";
  const canRestore = action.state === "succeeded";

  async function run(kind: "execute" | "resume") {
    const restoring = kind === "resume";
    const warning = restoring
      ? `Restore service for ${actionKindLabel(action.kind)}?\n\nBrolly will use the rollback state saved before this action. For a Durable Object, this clears quarantine and allows work to run again.`
      : `${action.state === "failed" ? "Retry" : "Execute"} this ${actionKindLabel(action.kind)} control now?\n\nThis may change live service. Brolly will retain the desired state so the action can be retried or reversed.`;
    if (!window.confirm(warning)) return;
    setBusy(kind);
    setError("");
    try {
      await api(`/api/actions/${encodeURIComponent(action.id)}/${kind}`, token, { method: "POST", body: "{}" });
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  }

  return (
    <Drawer
      onClose={onClose}
      labelledBy="action-drawer-title"
      header={
        <div>
          <span className={`action-state ${action.state}`}>{metricTitle(action.state)}</span>
          <h2 id="action-drawer-title">{actionKindLabel(action.kind)}</h2>
          <p>{incident?.assetName ?? compactId(action.assetId)}</p>
        </div>
      }
      footer={<button type="button" className="button secondary" onClick={onClose}>Done</button>}
    >
      <section className={`action-status-card ${stopped ? "stopped" : action.state}`}>
        <Icon name={stopped ? "alert" : action.state === "rolled_back" ? "check" : "shield"} />
        <div>
          <span>Current control state</span>
          <strong>{actionStateTitle(action.state)}</strong>
          <p>{actionStateDescription(action.state)}</p>
        </div>
      </section>

      <section className="detail-block">
        <h3>Action details</h3>
        <p>{incident ? humanizeReason(action.reason, incident.metric, incident.metricLabel) : action.reason}.</p>
        <dl>
          <div><dt>Action ID</dt><dd><code>{action.id}</code></dd></div>
          <div><dt>Target</dt><dd><code>{action.family}/{action.assetId}</code></dd></div>
          <div><dt>Prepared</dt><dd>{dateTime(action.createdAt)}</dd></div>
          <div><dt>Last changed</dt><dd>{dateTime(action.updatedAt)}</dd></div>
          {action.error && <div><dt>Last error</dt><dd className="error-text">{action.error}</dd></div>}
        </dl>
        <p className="audit-note"><Icon name="clock" /> Every prepare, execute, resume, and failure on this action is written to the audit log with its rollback snapshot before Cloudflare is touched.</p>
        {incident && (
          <a className="button secondary full" href={incident.cloudflareUrl} target="_blank" rel="noreferrer">
            Open target in Cloudflare <Icon name="external" />
          </a>
        )}
      </section>

      {action.kind === "runtime_quarantine" && (
        <section className="detail-block"><ObjectStopImpact compact /></section>
      )}

      <section className="detail-block">
        <h3>Available control</h3>
        {canExecute && (
          <>
            <p>{action.state === "failed" ? "The previous Cloudflare request did not complete conclusively. Retrying reapplies the same desired fuse state; inspect Cloudflare first if the target status is uncertain." : "This action is only prepared. No live service change has happened yet."}</p>
            <button type="button" className="button danger full" disabled={Boolean(busy)} onClick={() => void run("execute")}>
              {busy === "execute" ? "Stopping…" : action.state === "failed" ? "Retry stop" : "Approve and stop service"}
            </button>
          </>
        )}
        {canRestore && (
          <>
            <p>This control is active. Restore the pre-action configuration to return the resource to service.</p>
            <button type="button" className="button primary full" disabled={Boolean(busy)} onClick={() => void run("resume")}>
              {busy === "resume" ? "Restoring…" : action.kind === "runtime_quarantine" ? "Release quarantine and resume" : "Restore service from rollback"}
            </button>
          </>
        )}
        {!canExecute && !canRestore && <p>No operator action is needed. This control has already been rolled back or is currently changing state.</p>}
      </section>

      {error && <p className="form-error">{error}</p>}
    </Drawer>
  );
}
