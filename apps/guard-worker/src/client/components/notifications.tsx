import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { relativeTime } from "../format";
import type { NotificationKind, NotificationTarget, Severity } from "../types";
import { ChannelLogo, Icon, InfoTip } from "./ui";

export const NOTIFICATION_CHANNELS: Array<{ kind: NotificationKind; label: string; description: string }> = [
  { kind: "discord", label: "Discord", description: "Post structured incident messages to a Discord channel webhook." },
  { kind: "slack", label: "Slack", description: "Send incident summaries to a Slack incoming webhook." },
  { kind: "twilio", label: "Twilio SMS", description: "Text a phone number for high-urgency incidents through Twilio." },
];

export interface TargetsResponse {
  targets: NotificationTarget[];
  credentialStorageReady: boolean;
}

export function useNotificationTargets(token: string) {
  const [targets, setTargets] = useState<NotificationTarget[]>([]);
  const [credentialStorageReady, setCredentialStorageReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api<TargetsResponse>("/api/targets", token);
      setTargets(result.targets.filter(target => NOTIFICATION_CHANNELS.some(channel => channel.kind === target.kind)));
      setCredentialStorageReady(result.credentialStorageReady);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);
  return { targets, credentialStorageReady, loading, error, setError, load };
}

export function NotificationSection({ token }: { token: string }) {
  const { targets, credentialStorageReady, loading, error, setError, load } = useNotificationTargets(token);
  const [saved, setSaved] = useState("");

  async function toggle(target: NotificationTarget) {
    setError("");
    try {
      await api(`/api/targets/${encodeURIComponent(target.id)}`, token, { method: "PATCH", body: JSON.stringify({ enabled: !target.enabled }) });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function severity(target: NotificationTarget, minimumSeverity: Severity) {
    setError("");
    try {
      await api(`/api/targets/${encodeURIComponent(target.id)}`, token, { method: "PATCH", body: JSON.stringify({ minimumSeverity }) });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <section id="notifications" className="panel-section notification-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Escalation</p>
          <h2 className="heading-with-info">
            Incident notifications
            <InfoTip label="When does Brolly send a notification?">
              <h4>Only new or materially escalated incidents</h4>
              <p>The minute monitor deduplicates repeated detections. Each target receives at most 20 deliveries per hour; Twilio also has a five-SMS-per-day safety cap.</p>
              <h4>Daily summaries</h4>
              <p>The configured daily summary hour is separate from immediate incident delivery. Coverage gaps are reported explicitly so missing telemetry cannot look like zero spend.</p>
              <h4>No test blast</h4>
              <p>Saving a target does not send a test message; delivery is only attempted for a qualifying incident.</p>
            </InfoTip>
          </h2>
          <p>Route warnings and emergencies to the people who can respond.</p>
        </div>
        <span className={`count-badge ${targets.some(target => target.enabled) ? "" : "warning"}`}>
          {targets.filter(target => target.enabled).length} active
        </span>
      </div>

      <div className={`credential-callout ${credentialStorageReady ? "ready" : "missing"}`}>
        <Icon name={credentialStorageReady ? "shield" : "alert"} />
        <div>
          <strong>{credentialStorageReady ? "Credentials are encrypted at rest" : "Credential encryption is not configured"}</strong>
          <p>
            {credentialStorageReady
              ? "Webhook URLs and Twilio secrets are sealed before D1 storage and are never returned to the browser."
              : "Set BROLLY_CREDENTIAL_KEY before saving a destination. Brolly refuses to store notification credentials in plaintext."}
          </p>
        </div>
      </div>

      {error && <p className="form-error notification-error">{error}</p>}
      {saved && <p className="form-success" role="status">{saved}</p>}

      <div className="notification-grid">
        {NOTIFICATION_CHANNELS.map(channel => {
          const target = targets.find(item => item.kind === channel.kind);
          return (
            <article key={channel.kind} className="notification-card">
              <header>
                <ChannelLogo kind={channel.kind} />
                <div>
                  <strong>{channel.label}</strong>
                  <p>{channel.description}</p>
                </div>
                <span className={`target-status ${target?.enabled ? "active" : "inactive"}`}>
                  {target?.enabled ? "Active" : target ? "Paused" : "Not configured"}
                </span>
              </header>
              {target && (
                <div className="target-controls">
                  <label>
                    Notify at
                    <select value={target.minimumSeverity} onChange={event => void severity(target, event.target.value as Severity)}>
                      <option value="info">Info and above</option>
                      <option value="warning">Warning and above</option>
                      <option value="critical">Critical and emergency</option>
                      <option value="emergency">Emergency only</option>
                    </select>
                  </label>
                  <button type="button" className="button secondary" onClick={() => void toggle(target)}>
                    {target.enabled ? "Pause" : "Enable"}
                  </button>
                  <small>{target.lastDeliveryAt ? `${target.lastDeliveryOk ? "Delivered" : "Failed"} ${relativeTime(target.lastDeliveryAt)}` : "No delivery attempts yet"}</small>
                </div>
              )}
              <NotificationForm
                channel={channel}
                token={token}
                existing={target}
                disabled={!credentialStorageReady}
                onSaved={async () => {
                  setSaved(`${channel.label} notification settings saved.`);
                  await load();
                }}
              />
            </article>
          );
        })}
      </div>
      {loading && <p className="loading-inline">Loading notification destinations…</p>}
    </section>
  );
}

function NotificationForm({ channel, token, existing, disabled, onSaved }: {
  channel: typeof NOTIFICATION_CHANNELS[number];
  token: string;
  existing?: NotificationTarget;
  disabled: boolean;
  onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [minimumSeverity, setMinimumSeverity] = useState<Severity>(existing?.minimumSeverity ?? (channel.kind === "twilio" ? "critical" : "warning"));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key: string, value: string) => setFields(current => ({ ...current, [key]: value }));

  useEffect(() => {
    if (!open && existing) setMinimumSeverity(existing.minimumSeverity);
  }, [existing?.minimumSeverity, open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const config = channel.kind === "twilio"
        ? { accountSid: fields.accountSid, token: fields.token, from: fields.from, to: fields.to }
        : { url: fields.url };
      await api("/api/targets", token, { method: "POST", body: JSON.stringify({ id: existing?.id, kind: channel.kind, config, enabled: true, minimumSeverity }) });
      setFields({});
      setOpen(false);
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="notification-form-wrap">
      <button type="button" className="configure-link" disabled={disabled} onClick={() => setOpen(!open)}>
        {existing ? "Replace credentials" : "Configure channel"} <Icon name="chevron" />
      </button>
      {open && (
        <form className="notification-form" onSubmit={submit}>
          {channel.kind === "twilio" ? (
            <>
              <label>Account SID<input required autoComplete="off" value={fields.accountSid ?? ""} onChange={event => set("accountSid", event.target.value)} placeholder="AC…" /></label>
              <label>Auth token<input required type="password" autoComplete="new-password" value={fields.token ?? ""} onChange={event => set("token", event.target.value)} /></label>
              <div className="field-pair">
                <label>From number<input required value={fields.from ?? ""} onChange={event => set("from", event.target.value)} placeholder="+15551234567" /></label>
                <label>Destination number<input required value={fields.to ?? ""} onChange={event => set("to", event.target.value)} placeholder="+15557654321" /></label>
              </div>
            </>
          ) : (
            <label>
              {channel.label} webhook URL
              <input
                required
                type="url"
                autoComplete="off"
                value={fields.url ?? ""}
                onChange={event => set("url", event.target.value)}
                placeholder={channel.kind === "discord" ? "https://discord.com/api/webhooks/…" : "https://hooks.slack.com/services/…"}
              />
            </label>
          )}
          <label>
            Minimum severity
            <select value={minimumSeverity} onChange={event => setMinimumSeverity(event.target.value as Severity)}>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
              <option value="emergency">Emergency only</option>
            </select>
          </label>
          <p className="secret-note"><Icon name="shield" /> Brolly stores this secret encrypted and never displays it again.</p>
          {error && <p className="form-error">{error}</p>}
          <button className="button primary full" disabled={busy}>{busy ? "Encrypting and saving…" : "Save notification channel"}</button>
        </form>
      )}
    </div>
  );
}
