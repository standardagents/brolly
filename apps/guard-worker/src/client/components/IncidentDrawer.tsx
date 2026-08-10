import { useState } from "react";
import { api } from "../api";
import { compactId, dateTime, measurement, metricTitle } from "../format";
import { tierDescription } from "../lib/meta";
import type { AssetTier, Incident } from "../types";
import { ObjectStopImpact } from "./protection";
import { Drawer, Icon, SeverityBadge } from "./ui";

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
          <button
            type="button"
            className="button quiet"
            disabled={incident.status === "acknowledged" || Boolean(busy)}
            onClick={() => void act("ack", () => api(`/api/incidents/${incident.id}/ack`, token, { method: "POST" }))}
          >
            {incident.status === "acknowledged" ? "Acknowledged" : busy === "ack" ? "Acknowledging…" : "Acknowledge incident"}
          </button>
          <button type="button" className="button secondary" onClick={onClose}>Done</button>
        </>
      }
    >
      <section className="measurement-card">
        <span>Detected activity</span>
        <strong>{measurement(incident.observed, incident.unit, incident.windowMs)}</strong>
        <div>
          <span>{incident.threshold == null ? "Trigger" : "Configured limit"}</span>
          <b>{incident.threshold == null ? "Dynamic anomaly vs. baseline" : measurement(incident.threshold, incident.unit, incident.windowMs)}</b>
        </div>
      </section>

      <section className="detail-block">
        <h3>What happened</h3>
        <p>{humanizeReason(incident.reason, incident.metric, incident.metricLabel)}.</p>
        <dl>
          <div><dt>First detected</dt><dd>{dateTime(incident.firstSeen)}</dd></div>
          <div><dt>Last detected</dt><dd>{dateTime(incident.lastSeen)}</dd></div>
          <div><dt>Occurrences</dt><dd>{incident.occurrences}</dd></div>
          <div><dt>{incident.scope === "object" ? "Object ID" : "Resource ID"}</dt><dd><code>{incident.assetId}</code></dd></div>
          {incident.parentId && <div><dt>Namespace</dt><dd><code>{incident.parentId}</code></dd></div>}
        </dl>
        <a className="button secondary full" href={incident.cloudflareUrl} target="_blank" rel="noreferrer">
          Open in Cloudflare <Icon name="external" />
        </a>
      </section>

      <section className="detail-block">
        <h3>Response controls</h3>
        <p>Classification prevents control-plane or critical assets from being stopped accidentally.</p>
        {runtimeRequired && <ObjectStopImpact compact />}
        <label>
          Asset protection tier
          <select value={tier} onChange={event => setTier(event.target.value as AssetTier)}>
            <option value="unclassified">Unclassified — alert only</option>
            <option value="critical">Critical — alert only</option>
            <option value="standard">Standard — allow approved stop</option>
            <option value="disposable">Disposable — allow approved stop</option>
            <option value="control_plane">Control plane — never stop</option>
          </select>
          <small>{tierDescription(tier)}</small>
        </label>
        {fuseCapable && (
          <div>
            <strong>Owning Worker</strong>
            <p><code>{owningWorker || "Not reported by Cloudflare"}</code></p>
            <label className="runtime-confirm"><input type="checkbox" checked={fuseInstalled} disabled={!owningWorker} onChange={event => setFuseInstalled(event.target.checked)} /> Runtime fuse installed</label>
            <small>Brolly accepts only the ownership mapping returned by Cloudflare. Confirm this after installing the runtime and verify it on the Configuration page.</small>
          </div>
        )}
        <button type="button" className="button secondary full" disabled={busy === "classify"} onClick={() => void classify()}>
          {busy === "classify" ? "Saving…" : "Save classification"}
        </button>

        {supported && incident.severity === "emergency" && (
          <div className="control-zone">
            <div>
              <Icon name="shield" />
              <span>
                <strong>Emergency control</strong>
                <small>{proposedControlText(incident)}</small>
              </span>
            </div>
            {!incident.action && (
              <button
                type="button"
                className="button primary full"
                disabled={!classified || (fuseCapable && (!owningWorker || !fuseInstalled)) || Boolean(busy)}
                onClick={() => void prepare()}
              >
                {busy === "prepare" ? "Preparing…" : "Prepare reversible stop"}
              </button>
            )}
            {incident.action?.state === "prepared" && (
              <button type="button" className="button danger full" disabled={Boolean(busy)} onClick={() => void execute()}>
                {busy === "execute" ? "Executing…" : "Approve and stop"}
              </button>
            )}
            {incident.action?.state === "succeeded" && (
              <button type="button" className="button primary full" disabled={Boolean(busy)} onClick={() => void resume()}>
                {busy === "resume" ? "Resuming…" : "Resume from rollback"}
              </button>
            )}
            {!classified && <small className="control-hint">Set the tier to Standard or Disposable to enable a stop; control-plane and critical assets only alert.</small>}
          </div>
        )}
      </section>

      {error && <p className="form-error">{error}</p>}
    </Drawer>
  );
}
