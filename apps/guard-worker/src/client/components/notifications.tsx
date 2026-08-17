import { useCallback, useEffect, useState, type FormEvent, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { api } from "../api";
import { relativeTime } from "../format";
import type { NotificationKind, NotificationTarget, Severity } from "../types";
import { Button, ChannelLogo, CountBadge, Icon, InfoTip, Notice, Panel, PanelHead, Pill } from "./ui";

export const NOTIFICATION_CHANNELS: Array<{ kind: NotificationKind; label: string; description: string }> = [
  { kind: "discord", label: "Discord", description: "Post structured incident messages to a Discord channel webhook." },
  { kind: "slack", label: "Slack", description: "Send incident summaries to a Slack incoming webhook." },
  { kind: "resend", label: "Resend email", description: "Send incident email through a Resend account." },
  { kind: "postmark", label: "Postmark email", description: "Send incident email through a Postmark server." },
  { kind: "twilio", label: "Twilio SMS", description: "Text a phone number for high-urgency incidents through Twilio." },
  { kind: "webhook", label: "Generic webhook", description: "POST an incident payload to an HTTPS endpoint with an optional bearer token." },
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

/** Credential field inside a notification form: stacked label + text input. */
function TextField({ label, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="flex flex-col gap-[5px] text-[12.5px] font-[680]">
      {label}
      <input
        className="min-h-[38px] w-full rounded-field border border-field-line bg-field px-2.5 text-[13px] text-ink focus:border-orange focus:shadow-[0_0_0_3px_#f6821f1f] focus:outline-none"
        {...rest}
      />
    </label>
  );
}

/** Severity picker inside a notification form: stacked label + select. */
function SelectField({ label, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: ReactNode }) {
  return (
    <label className="flex flex-col gap-[5px] text-[12.5px] font-[680]">
      {label}
      <select
        className="min-h-[38px] w-full rounded-field border border-field-line bg-field px-2.5 text-[13px] text-ink focus:border-orange focus:shadow-[0_0_0_3px_#f6821f1f] focus:outline-none"
        {...rest}
      >
        {children}
      </select>
    </label>
  );
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

  const active = targets.filter(target => target.enabled).length;

  return (
    <Panel id="notifications" className="pb-4">
      <PanelHead
        eyebrow="Escalation"
        title="Incident notifications"
        titleExtra={
          <InfoTip label="When does Brolly send a notification?">
            <h4>Only new or materially escalated incidents</h4>
            <p>The minute monitor deduplicates repeated detections. Each target receives at most 20 deliveries per hour; Twilio also has a five-SMS-per-day safety cap.</p>
            <h4>Daily summaries</h4>
            <p>The configured daily summary hour is separate from immediate incident delivery. Coverage gaps are reported explicitly so missing telemetry cannot look like zero spend.</p>
            <h4>No test blast</h4>
            <p>Saving a target does not send a test message; delivery is only attempted for a qualifying incident.</p>
          </InfoTip>
        }
        sub="Route warnings and emergencies to the people who can respond."
        actions={<CountBadge tone={active ? "neutral" : "warning"}>{active} active</CountBadge>}
      />

      <div className={`mx-5 mt-1 mb-3 flex gap-[11px] rounded-field border px-3.5 py-3 ${
        credentialStorageReady ? "border-good-line bg-good-bg" : "border-danger-line bg-danger-bg"
      }`}>
        <Icon name={credentialStorageReady ? "shield" : "alert"} className="mt-px size-[18px]" />
        <div>
          <strong className="text-[13px]">{credentialStorageReady ? "Credentials are encrypted at rest" : "Credential encryption is not configured"}</strong>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {credentialStorageReady
              ? "Webhook URLs and Twilio secrets are sealed before D1 storage and are never returned to the browser."
              : "Set BROLLY_CREDENTIAL_KEY before saving a destination. Brolly refuses to store notification credentials in plaintext."}
          </p>
        </div>
      </div>

      {error && <Notice tone="error" className="mx-5 mb-3">{error}</Notice>}
      {saved && <Notice tone="success" className="mx-5 mb-3" role="status">{saved}</Notice>}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-2.5 px-5 pb-2 max-xl:grid-cols-1">
        {NOTIFICATION_CHANNELS.map(channel => {
          const target = targets.find(item => item.kind === channel.kind);
          return (
            <article key={channel.kind} className="flex flex-col gap-2.5 rounded-panel border border-line p-3.5">
              <header className="flex items-start gap-2.5">
                <ChannelLogo kind={channel.kind} />
                <div className="min-w-0 flex-1">
                  <strong className="block text-[13.5px]">{channel.label}</strong>
                  <p className="mt-0.5 text-[12px] leading-[1.45] text-muted">{channel.description}</p>
                </div>
                <Pill tone={target?.enabled ? "good" : "neutral"} className="ml-auto">
                  {target?.enabled ? "Active" : target ? "Paused" : "Not configured"}
                </Pill>
              </header>
              {target && (
                <div className="grid grid-cols-[1fr_auto] items-end gap-2 border-t border-line-soft pt-2.5">
                  <label className="flex flex-col gap-1 text-[11.5px] font-bold text-muted">
                    Notify at
                    <select
                      value={target.minimumSeverity}
                      onChange={event => void severity(target, event.target.value as Severity)}
                      className="min-h-[34px] w-full rounded-field border border-field-line bg-field px-2 text-[12.5px] text-ink"
                    >
                      <option value="info">Info and above</option>
                      <option value="warning">Warning and above</option>
                      <option value="critical">Critical and emergency</option>
                      <option value="emergency">Emergency only</option>
                    </select>
                  </label>
                  <Button variant="secondary" onClick={() => void toggle(target)}>
                    {target.enabled ? "Pause" : "Enable"}
                  </Button>
                  <small className="col-span-full text-[11.5px] text-faint">
                    {target.lastDeliveryAt ? `${target.lastDeliveryOk ? "Delivered" : "Failed"} ${relativeTime(target.lastDeliveryAt)}` : "No delivery attempts yet"}
                  </small>
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
      {loading && <p className="py-2.5 text-[13px] text-muted">Loading notification destinations…</p>}
    </Panel>
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
        : channel.kind === "resend" || channel.kind === "postmark"
          ? { token: fields.token, from: fields.from, to: fields.to }
          : channel.kind === "webhook"
            ? { url: fields.url, token: fields.token || undefined }
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
    <div className="mt-auto border-t border-line-soft pt-2">
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent px-0 py-0.5 text-[13px] font-[650] text-blue disabled:cursor-not-allowed disabled:text-faint [&>svg]:size-3.5"
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {existing ? "Replace credentials" : "Configure channel"} <Icon name="chevron" />
      </button>
      {open && (
        <form className="mt-2.5 flex flex-col gap-2.5" onSubmit={submit}>
          {channel.kind === "twilio" ? (
            <>
              <TextField label="Account SID" required autoComplete="off" value={fields.accountSid ?? ""} onChange={event => set("accountSid", event.target.value)} placeholder="AC…" />
              <TextField label="Auth token" required type="password" autoComplete="new-password" value={fields.token ?? ""} onChange={event => set("token", event.target.value)} />
              <div className="grid grid-cols-2 gap-2 max-md:grid-cols-1">
                <TextField label="From number" required value={fields.from ?? ""} onChange={event => set("from", event.target.value)} placeholder="+15551234567" />
                <TextField label="Destination number" required value={fields.to ?? ""} onChange={event => set("to", event.target.value)} placeholder="+15557654321" />
              </div>
            </>
          ) : channel.kind === "resend" || channel.kind === "postmark" ? (
            <>
              <TextField label="API token" required type="password" autoComplete="new-password" value={fields.token ?? ""} onChange={event => set("token", event.target.value)} />
              <TextField label="From address" required type="email" value={fields.from ?? ""} onChange={event => set("from", event.target.value)} placeholder="alerts@example.com" />
              <TextField label="Destination address" required type="email" value={fields.to ?? ""} onChange={event => set("to", event.target.value)} placeholder="operator@example.com" />
            </>
          ) : (
            <>
              <TextField
                label={`${channel.label} webhook URL`}
                required
                type="url"
                autoComplete="off"
                value={fields.url ?? ""}
                onChange={event => set("url", event.target.value)}
                placeholder={channel.kind === "discord" ? "https://discord.com/api/webhooks/…" : channel.kind === "slack" ? "https://hooks.slack.com/services/…" : "https://alerts.example.com/brolly"}
              />
              {channel.kind === "webhook" && (
                <TextField label="Bearer token (optional)" type="password" autoComplete="new-password" value={fields.token ?? ""} onChange={event => set("token", event.target.value)} />
              )}
            </>
          )}
          <SelectField label="Minimum severity" value={minimumSeverity} onChange={event => setMinimumSeverity(event.target.value as Severity)}>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
            <option value="emergency">Emergency only</option>
          </SelectField>
          <p className="m-0 flex items-center gap-[7px] text-[12px] text-muted">
            <Icon name="shield" className="size-3.5" /> Brolly stores this secret encrypted and never displays it again.
          </p>
          {error && <Notice tone="error">{error}</Notice>}
          <Button type="submit" variant="primary" full disabled={busy}>{busy ? "Encrypting and saving…" : "Save notification channel"}</Button>
        </form>
      )}
    </div>
  );
}
