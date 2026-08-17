import { useState, type ReactNode } from "react";
import { api } from "../api";
import { compactId, dateTime, measurement, metricTitle } from "../format";
import { tierDescription } from "../lib/meta";
import type { AssetTier, Incident } from "../types";
import { ObjectStopImpact } from "./protection";
import { Button, DetailBlock, Drawer, ExternalAction, Icon, KeyValueList, Notice, Select, SeverityBadge } from "./ui";

/** Backend reasons embed the raw metric key (e.g. "rows_written crossed…"); swap in the readable label. */
export function humanizeReason(reason: string, metric: string, metricLabel: string): string {
  return reason.replaceAll(metric, metricLabel);
}

function proposedControlText(incident: Incident): string {
  if (incident.family === "durable_objects") return "Deploy a fuse for this exact object ID and retain an explicit resume action.";
  if (incident.family === "queues") return "Pause the queue consumer and retain rollback state.";
  return incident.tags.brollyFuse === "true"
    ? "Deploy a whole-Worker fuse and retain an explicit resume action."
    : "This Worker is alert-only until the Brolly runtime fuse is installed and verified.";
}

export function IncidentDrawer({ incident, token, onClose, onChanged }: {
  incident: Incident;
  token: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [tier, setTier] = useState<AssetTier>(incident.tier);
  const owningWorker = incident.family === "workers" ? incident.assetId : incident.tags.cloudflareWorkerScript ?? "";
  const [fuseInstalled, setFuseInstalled] = useState(incident.tags.brollyFuse === "true");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function act(label: string, callback: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try {
      await callback();
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  }

  function classificationTags() {
    return { brollyFuse: fuseInstalled ? "true" : null };
  }

  async function classify() {
    await act("classify", () => api(`/api/assets/${encodeURIComponent(incident.family)}/${encodeURIComponent(incident.assetId)}`, token, {
      method: "PATCH",
      body: JSON.stringify({ tier, tags: classificationTags() }),
    }));
  }

  async function prepare() {
    await act("prepare", async () => {
      if (tier !== incident.tier || fuseInstalled !== (incident.tags.brollyFuse === "true")) {
        await api(`/api/assets/${encodeURIComponent(incident.family)}/${encodeURIComponent(incident.assetId)}`, token, {
          method: "PATCH",
          body: JSON.stringify({ tier, tags: classificationTags() }),
        });
      }
      return api("/api/actions", token, {
        method: "POST",
        body: JSON.stringify({ incidentId: incident.id }),
      });
    });
  }

  async function execute() {
    const warning = incident.family === "durable_objects"
      ? "Deploy quarantine for this exact Durable Object now?\n\nBrolly will publish a new secret-backed Worker version. Only this object ID will reject application work, but other live objects in the same Worker may restart during rollout. Stored data is preserved."
      : "Stop this asset now? Service traffic may be interrupted. The rollback state is stored and the action will be audited.";
    if (!incident.action || !window.confirm(warning)) return;
    await act("execute", () => api(`/api/actions/${incident.action!.id}/execute`, token, {
      method: "POST",
      body: JSON.stringify({}),
    }));
  }

  async function resume() {
    if (!incident.action || !window.confirm("Resume this asset using the stored rollback state?")) return;
    await act("resume", () => api(`/api/actions/${incident.action!.id}/resume`, token, {
      method: "POST",
      body: JSON.stringify({}),
    }));
  }

  const supported = ["durable_objects", "workers", "queues"].includes(incident.family);
  const fuseCapable = incident.family === "durable_objects" || incident.family === "workers";
  const runtimeRequired = incident.family === "durable_objects";
  const classified = tier === "standard" || tier === "disposable";

  const whatHappenedRows: Array<[ReactNode, ReactNode]> = [
    ["First detected", dateTime(incident.firstSeen)],
    ["Last detected", dateTime(incident.lastSeen)],
    ["Occurrences", incident.occurrences],
    [
      incident.scope === "object" ? "Object ID" : "Resource ID",
      <code className="font-mono text-[.92em] break-all">{incident.assetId}</code>,
    ],
  ];
  if (incident.parentId) whatHappenedRows.push(["Namespace", <code className="font-mono text-[.92em] break-all">{incident.parentId}</code>]);

  return (
    <Drawer
      onClose={onClose}
      labelledBy="incident-drawer-title"
      header={
        <div>
          <SeverityBadge severity={incident.severity} />
          <h2 id="incident-drawer-title">{incident.metricLabel}</h2>
          <p>{incident.familyLabel} / {incident.assetName ?? compactId(incident.assetId)}</p>
        </div>
      }
      footer={
        <>
          <Button
            variant="quiet"
            disabled={incident.status === "acknowledged" || Boolean(busy)}
            onClick={() => void act("ack", () => api(`/api/incidents/${incident.id}/ack`, token, { method: "POST" }))}
          >
            {incident.status === "acknowledged" ? "Acknowledged" : busy === "ack" ? "Acknowledging…" : "Acknowledge incident"}
          </Button>
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <section className="rounded-panel bg-[#181b1f] p-5 text-white">
        <span className="text-[12px] text-[#aab2bc]">Detected activity</span>
        <strong className="mt-1.5 mb-4 block text-[24px] tracking-[-.01em]">{measurement(incident.observed, incident.unit, incident.windowMs)}</strong>
        <div className="flex justify-between gap-3.5 border-t border-[#383c42] pt-3 text-[13px] text-[#bfc6ce]">
          <span>{incident.threshold == null ? "Trigger" : "Configured limit"}</span>
          <b>{incident.threshold == null ? "Dynamic anomaly vs. baseline" : measurement(incident.threshold, incident.unit, incident.windowMs)}</b>
        </div>
      </section>

      <DetailBlock>
        <h3 className="mb-2 text-[14.5px]">What happened</h3>
        <p className="mb-2.5 text-[13px] leading-[1.55] text-muted">{humanizeReason(incident.reason, incident.metric, incident.metricLabel)}.</p>
        <KeyValueList
          labelWidth="125px"
          className="my-3 [&>div]:text-[12.5px] [&>div:first-child]:border-t"
          rows={whatHappenedRows}
        />
        <ExternalAction href={incident.cloudflareUrl}>
          Open in Cloudflare <Icon name="external" />
        </ExternalAction>
      </DetailBlock>

      <DetailBlock>
        <h3 className="mb-2 text-[14.5px]">Response controls</h3>
        <p className="mb-2.5 text-[13px] leading-[1.55] text-muted">Classification prevents control-plane or critical assets from being stopped accidentally.</p>
        {runtimeRequired && <ObjectStopImpact compact />}
        <label className="my-[13px] flex flex-col gap-1.5 text-[13px] font-[680]">
          Asset protection tier
          <Select value={tier} onChange={event => setTier(event.target.value as AssetTier)}>
            <option value="unclassified">Unclassified — alert only</option>
            <option value="critical">Critical — alert only</option>
            <option value="standard">Standard — allow approved stop</option>
            <option value="disposable">Disposable — allow approved stop</option>
            <option value="control_plane">Control plane — never stop</option>
          </Select>
          <small className="font-[450] leading-[1.5] text-muted">{tierDescription(tier)}</small>
        </label>
        {fuseCapable && (
          <div>
            <strong>Owning Worker</strong>
            <p><code className="font-mono text-[.92em] break-all">{owningWorker || "Not reported by Cloudflare"}</code></p>
            <label className="inline-flex items-center gap-2 text-[12.5px] font-[650] whitespace-nowrap">
              <input type="checkbox" className="size-[15px] accent-orange" checked={fuseInstalled} disabled={!owningWorker} onChange={event => setFuseInstalled(event.target.checked)} /> Runtime fuse installed
            </label>
            <small>Brolly accepts only the ownership mapping returned by Cloudflare. Confirm this after installing the runtime and verify it on the Configuration page.</small>
          </div>
        )}
        <Button full disabled={busy === "classify"} onClick={() => void classify()}>
          {busy === "classify" ? "Saving…" : "Save classification"}
        </Button>

        {supported && incident.severity === "emergency" && (
          <div className="mt-4 rounded-field border border-warn-line bg-warn-soft p-3.5 dark:text-warn">
            <div className="mb-3 flex gap-2.5 text-[#9d4c06] dark:text-warn">
              <Icon name="shield" />
              <span className="flex flex-col gap-[3px]">
                <strong>Emergency control</strong>
                <small className="font-[450] text-[#7c5b40] dark:text-warn">{proposedControlText(incident)}</small>
              </span>
            </div>
            {!incident.action && (
              <Button
                variant="primary"
                full
                disabled={!classified || (fuseCapable && (!owningWorker || !fuseInstalled)) || Boolean(busy)}
                onClick={() => void prepare()}
              >
                {busy === "prepare" ? "Preparing…" : "Prepare reversible stop"}
              </Button>
            )}
            {incident.action?.state === "prepared" && (
              <Button variant="danger" full disabled={Boolean(busy)} onClick={() => void execute()}>
                {busy === "execute" ? "Executing…" : "Approve and stop"}
              </Button>
            )}
            {incident.action?.state === "succeeded" && (
              <Button variant="primary" full disabled={Boolean(busy)} onClick={() => void resume()}>
                {busy === "resume" ? "Resuming…" : "Resume from rollback"}
              </Button>
            )}
            {!classified && <small className="mt-[9px] block text-[12px] text-[#7c5b40] dark:text-warn">Set the tier to Standard or Disposable to enable a stop; control-plane and critical assets only alert.</small>}
          </div>
        )}
      </DetailBlock>

      {error && <Notice tone="error">{error}</Notice>}
    </Drawer>
  );
}
