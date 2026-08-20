import { useState, type ReactNode } from "react";
import { api } from "../api";
import { compactId, dateTime, metricTitle } from "../format";
import { humanizeReason } from "./IncidentDrawer";
import type { ControlActionRow, Incident } from "../types";
import { ObjectStopImpact } from "./protection";
import { ActionStatePill, Button, DetailBlock, Drawer, ExternalAction, Icon, KeyValueList, Notice } from "./ui";

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

  const statusCard = stopped
    ? "border-danger-line bg-danger-bg text-[#7c1f1a] dark:text-danger"
    : action.state === "rolled_back"
      ? "border-good-line bg-good-bg text-[#135a36] dark:text-good"
      : action.state === "failed"
        ? "border-danger-line bg-danger-bg"
        : "border-line bg-[#eef1f4] dark:bg-[#252a31]";
  const statusSub = stopped ? "text-[#8c4440] dark:text-[#e49a96]" : "text-muted";

  const detailRows: Array<[ReactNode, ReactNode]> = [
    ["Action ID", <code className="font-mono text-[.92em] break-all">{action.id}</code>],
    ["Target", <code className="font-mono text-[.92em] break-all">{action.family}/{action.assetId}</code>],
    ["Prepared", dateTime(action.createdAt)],
    ["Last changed", dateTime(action.updatedAt)],
  ];
  if (action.error) detailRows.push(["Last error", <span className="text-danger">{action.error}</span>]);

  return (
    <Drawer
      onClose={onClose}
      labelledBy="action-drawer-title"
      header={
        <div>
          <ActionStatePill state={action.state} />
          <h2 id="action-drawer-title">{actionKindLabel(action.kind)}</h2>
          <p>{incident?.assetName ?? compactId(action.assetId)}</p>
        </div>
      }
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <section className={`flex items-start gap-[13px] rounded-panel border p-4 ${statusCard}`}>
        <Icon name={stopped ? "alert" : action.state === "rolled_back" ? "check" : "shield"} className="mt-0.5 size-[22px]" />
        <div>
          <span className={`block text-[11px] font-[750] uppercase tracking-[.07em] ${statusSub}`}>Current control state</span>
          <strong className="mt-[3px] mb-1 block text-[15.5px]">{actionStateTitle(action.state)}</strong>
          <p className={`m-0 text-[12.5px] ${statusSub}`}>{actionStateDescription(action.state)}</p>
        </div>
      </section>

      <DetailBlock>
        <h3 className="mb-2 text-[14.5px]">Action details</h3>
        <p className="mb-2.5 text-[13px] leading-[1.55] text-muted">{incident ? humanizeReason(action.reason, incident.metric, incident.metricLabel) : action.reason}.</p>
        <KeyValueList
          labelWidth="125px"
          className="my-3 [&>div]:text-[12.5px] [&>div:first-child]:border-t"
          rows={detailRows}
        />
        <p className="my-2.5 flex items-start gap-2 text-[12.5px] text-muted"><Icon name="clock" className="mt-0.5 size-[15px]" /> Every prepare, execute, resume, and failure on this action is written to the audit log with its rollback snapshot before Cloudflare is touched.</p>
        {incident && (
          <ExternalAction href={incident.cloudflareUrl}>
            Open target in Cloudflare <Icon name="external" />
          </ExternalAction>
        )}
      </DetailBlock>

      {action.kind === "runtime_quarantine" && (
        <DetailBlock><ObjectStopImpact compact /></DetailBlock>
      )}

      <DetailBlock>
        <h3 className="mb-2 text-[14.5px]">Available control</h3>
        {canExecute && (
          <>
            <p className="mb-2.5 text-[13px] leading-[1.55] text-muted">{action.state === "failed" ? "The previous Cloudflare request did not complete conclusively. Retrying reapplies the same desired breaker state; inspect Cloudflare first if the target status is uncertain." : "This action is only prepared. No live service change has happened yet."}</p>
            <Button variant="danger" full disabled={Boolean(busy)} onClick={() => void run("execute")}>
              {busy === "execute" ? "Stopping…" : action.state === "failed" ? "Retry stop" : "Approve and stop service"}
            </Button>
          </>
        )}
        {canRestore && (
          <>
            <p className="mb-2.5 text-[13px] leading-[1.55] text-muted">This control is active. Restore the pre-action configuration to return the resource to service.</p>
            <Button variant="primary" full disabled={Boolean(busy)} onClick={() => void run("resume")}>
              {busy === "resume" ? "Restoring…" : action.kind === "runtime_quarantine" ? "Release quarantine and resume" : "Restore service from rollback"}
            </Button>
          </>
        )}
        {!canExecute && !canRestore && <p className="mb-2.5 text-[13px] leading-[1.55] text-muted">No operator action is needed. This control has already been rolled back or is currently changing state.</p>}
      </DetailBlock>

      {error && <Notice tone="error">{error}</Notice>}
    </Drawer>
  );
}
