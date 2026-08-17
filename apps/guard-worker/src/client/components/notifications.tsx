import { useCallback, useEffect, useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { api } from "../api";
import { relativeTime } from "../format";
import type { NotificationKind, NotificationTarget, Severity } from "../types";
import { Button, ChannelLogo, CountBadge, Icon, InfoTip, Notice, Panel, PanelHead } from "./ui";
import { useOutsideClose } from "../lib/outside-close";

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

export type NotificationChannel = typeof NOTIFICATION_CHANNELS[number];
export type NotificationTargetsState = ReturnType<typeof useNotificationTargets>;

export function channelLabel(kind: NotificationKind): string {
  return NOTIFICATION_CHANNELS.find(channel => channel.kind === kind)?.label ?? kind;
}

/** Display name for a target: its friendly label, or the channel name. */
export function targetName(target: NotificationTarget): string {
  return target.label?.trim() || channelLabel(target.kind);
}

export function NotificationSection({ token }: { token: string }) {
  const state = useNotificationTargets(token);
  const active = state.targets.length;

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
        actions={<CountBadge tone={active ? "neutral" : "warning"}>{active} configured</CountBadge>}
      />
      <div className="px-5"><ChannelList token={token} state={state} showSeverity /></div>
    </Panel>
  );
}

/**
 * The list of configured alert channels. It starts empty with one hollow
 * "add" row. Several targets of one kind are allowed; each gets a label.
 */
export function ChannelList({ token, state, showSeverity = false }: { token: string; state: NotificationTargetsState; showSeverity?: boolean }) {
  const { targets, credentialStorageReady, loading, error, setError, load } = state;
  const [adding, setAdding] = useState<NotificationChannel | null>(null);
  const [saved, setSaved] = useState("");

  async function patch(target: NotificationTarget, body: Record<string, unknown>) {
    setError("");
    try {
      await api(`/api/targets/${encodeURIComponent(target.id)}`, token, { method: "PATCH", body: JSON.stringify(body) });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function remove(target: NotificationTarget) {
    setError("");
    try {
      await api(`/api/targets/${encodeURIComponent(target.id)}`, token, { method: "DELETE" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="grid gap-2.5">
      {!credentialStorageReady && !loading && (
        <div className="flex gap-[11px] rounded-field border border-danger-line bg-danger-bg px-3.5 py-3">
          <Icon name="alert" className="mt-px size-[18px]" />
          <div>
            <strong className="text-[13px]">Credential encryption is not configured</strong>
            <p className="mt-0.5 text-[12.5px] text-muted">Set BROLLY_CREDENTIAL_KEY before saving a channel. Brolly refuses to store notification credentials in plaintext.</p>
          </div>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {saved && <Notice tone="success" role="status">{saved}</Notice>}
      {loading && <p className="py-2.5 text-[13px] text-muted">Loading alert channels…</p>}
      {targets.map(target => (
        <ChannelRow
          key={target.id}
          target={target}
          showSeverity={showSeverity}
          onLabel={label => void patch(target, { label })}
          onSeverity={minimumSeverity => void patch(target, { minimumSeverity })}
          onRemove={() => void remove(target)}
        />
      ))}
      {adding
        ? (
          <div className="rounded-panel border border-line p-3.5">
            <header className="mb-2.5 flex items-center gap-2.5">
              <ChannelLogo kind={adding.kind} />
              <div className="min-w-0 flex-1">
                <strong className="block text-[13.5px]">{adding.label}</strong>
                <p className="mt-0.5 text-[12px] leading-[1.45] text-muted">{adding.description}</p>
              </div>
            </header>
            <ChannelCredentialsForm
              channel={adding}
              token={token}
              withLabel
              showSeverity={showSeverity}
              onCancel={() => setAdding(null)}
              onSaved={async () => {
                setSaved(`${adding.label} channel saved.`);
                setAdding(null);
                await load();
              }}
            />
          </div>
        )
        : <AddChannelRow disabled={!credentialStorageReady} onPick={channel => { setSaved(""); setAdding(channel); }} />}
    </div>
  );
}

function AddChannelRow({ disabled, onPick }: { disabled: boolean; onPick: (channel: NotificationChannel) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, open, () => setOpen(false));
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
        className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-panel border border-dashed border-line bg-transparent px-4 py-4 text-[13.5px] font-[650] text-muted hover:border-orange hover:text-ink disabled:cursor-not-allowed disabled:opacity-55"
      >
        <span aria-hidden="true" className="text-[18px] leading-none">+</span> Add alert channel
      </button>
      {open && (
        <ul role="menu" className="absolute left-0 right-0 top-full z-20 mt-1.5 grid list-none gap-0.5 rounded-panel border border-line bg-panel p-1.5 shadow-panel">
          {NOTIFICATION_CHANNELS.map(channel => (
            <li key={channel.kind} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); onPick(channel); }}
                className="flex w-full cursor-pointer items-start gap-2.5 rounded-field border-0 bg-transparent px-2.5 py-2 text-left hover:bg-panel-soft"
              >
                <ChannelLogo kind={channel.kind} />
                <span className="min-w-0">
                  <strong className="block text-[13px]">{channel.label}</strong>
                  <span className="block text-[12px] leading-[1.4] text-muted">{channel.description}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChannelRow({ target, showSeverity, onLabel, onSeverity, onRemove }: {
  target: NotificationTarget;
  showSeverity: boolean;
  onLabel: (label: string) => void;
  onSeverity: (severity: Severity) => void;
  onRemove: () => void;
}) {
  const [label, setLabel] = useState(target.label ?? "");
  useEffect(() => setLabel(target.label ?? ""), [target.label]);
  const commitLabel = () => { if ((label.trim() || null) !== (target.label ?? null)) onLabel(label); };

  return (
    <article className="flex flex-wrap items-center gap-3 rounded-panel border border-line p-3.5">
      <ChannelLogo kind={target.kind} />
      <div className="min-w-0 flex-1">
        <input
          aria-label={`Label for ${channelLabel(target.kind)} channel`}
          className="w-full max-w-[32ch] rounded-field border border-transparent bg-transparent px-1.5 py-0.5 text-[13.5px] font-[680] text-ink hover:border-field-line focus:border-orange focus:outline-none"
          placeholder={channelLabel(target.kind)}
          value={label}
          onChange={event => setLabel(event.target.value)}
          onBlur={commitLabel}
          onKeyDown={event => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
        />
        <p className="mt-0.5 px-1.5 text-[12px] text-muted">
          {channelLabel(target.kind)}{target.lastDeliveryAt ? ` · ${target.lastDeliveryOk ? "Delivered" : "Failed"} ${relativeTime(target.lastDeliveryAt)}` : ""}
        </p>
      </div>
      {showSeverity && (
        <label className="flex flex-col gap-1 text-[11.5px] font-bold text-muted">
          Notify at
          <select
            value={target.minimumSeverity}
            onChange={event => onSeverity(event.target.value as Severity)}
            className="min-h-[34px] rounded-field border border-field-line bg-field px-2 text-[12.5px] text-ink"
          >
            <option value="info">Info and above</option>
            <option value="warning">Warning and above</option>
            <option value="critical">Critical and emergency</option>
            <option value="emergency">Emergency only</option>
          </select>
        </label>
      )}
      <Button variant="quiet" onClick={onRemove}>Remove</Button>
    </article>
  );
}

export function ChannelCredentialsForm({ channel, token, existing, withLabel = false, showSeverity = true, onCancel, onSaved }: {
  channel: NotificationChannel;
  token: string;
  existing?: NotificationTarget;
  withLabel?: boolean;
  showSeverity?: boolean;
  onCancel?: () => void;
  onSaved: () => Promise<void>;
}) {
  const [minimumSeverity, setMinimumSeverity] = useState<Severity>(existing?.minimumSeverity ?? (channel.kind === "twilio" ? "critical" : "warning"));
  const [label, setLabel] = useState(existing?.label ?? "");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key: string, value: string) => setFields(current => ({ ...current, [key]: value }));

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
      await api("/api/targets", token, { method: "POST", body: JSON.stringify({ id: existing?.id, kind: channel.kind, label: label.trim() || null, config, enabled: true, minimumSeverity }) });
      setFields({});
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-2.5" onSubmit={submit}>
      {withLabel && <TextField label="Label" value={label} onChange={event => setLabel(event.target.value)} placeholder={channel.kind === "webhook" ? "PagerDuty bridge" : channel.kind === "discord" ? "Ops server" : `${channel.label} alerts`} maxLength={80} />}
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
      {showSeverity && (
        <SelectField label="Minimum severity" value={minimumSeverity} onChange={event => setMinimumSeverity(event.target.value as Severity)}>
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="critical">Critical</option>
          <option value="emergency">Emergency only</option>
        </SelectField>
      )}
      <p className="m-0 flex items-center gap-[7px] text-[12px] text-muted">
        <Icon name="shield" className="size-3.5" /> Brolly stores this secret encrypted and never displays it again.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        {onCancel && <Button variant="quiet" onClick={onCancel} disabled={busy}>Cancel</Button>}
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : "Save alert channel"}</Button>
      </div>
    </form>
  );
}
