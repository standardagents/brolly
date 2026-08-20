import { useCallback, useEffect, useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { api } from "../api";
import { relativeTime } from "../format";
import { emailSendingTokenTemplateUrl, emailServiceOnboardingUrl } from "../lib/email";
import { useOutsideClose } from "../lib/outside-close";
import type { NotificationKind, NotificationProvider, NotificationTarget, ProviderKind, ProvidersResponse } from "../types";
import { Button, ChannelLogo, CountBadge, Icon, InfoTip, Modal, Notice, Panel, PanelHead } from "./ui";

export const NOTIFICATION_CHANNELS: Array<{ kind: NotificationKind; label: string; description: string }> = [
  { kind: "cloudflare_email", label: "Cloudflare Email", description: "Send email through Cloudflare Email Service." },
  { kind: "discord", label: "Discord", description: "Post incident messages to a Discord webhook." },
  { kind: "postmark", label: "Postmark", description: "Send email through a Postmark server." },
  { kind: "resend", label: "Resend", description: "Send email through a Resend account." },
  { kind: "slack", label: "Slack", description: "Send incident messages to a Slack webhook." },
  { kind: "twilio", label: "Twilio SMS", description: "Send text messages through a Twilio account." },
  { kind: "webhook", label: "Webhook", description: "POST an incident payload to an HTTPS endpoint." },
];

const PROVIDER_KINDS: ProviderKind[] = ["cloudflare_email", "postmark", "resend", "twilio"];
const MAX_EMAIL_RECIPIENTS = 50;

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
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  return { targets, credentialStorageReady, loading, error, setError, load };
}

export function useNotificationProviders(token: string) {
  const [providers, setProviders] = useState<NotificationProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setProviders((await api<ProvidersResponse>("/api/providers", token)).providers);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  return { providers, loading, error, setError, load };
}

export type NotificationChannel = typeof NOTIFICATION_CHANNELS[number];
export type NotificationTargetsState = ReturnType<typeof useNotificationTargets>;

export function channelLabel(kind: NotificationKind): string {
  return NOTIFICATION_CHANNELS.find(channel => channel.kind === kind)?.label ?? kind;
}

export function targetName(target: NotificationTarget): string {
  return target.label?.trim() || channelLabel(target.kind);
}

export function NotificationSection({ token }: { token: string }) {
  const state = useNotificationTargets(token);
  return (
    <Panel id="notifications" className="pb-4">
      <PanelHead
        eyebrow="Escalation"
        title="Incident notifications"
        titleExtra={
          <InfoTip label="When does Brolly send a notification?">
            <h4>Alert level delivery</h4>
            <p>Each alert level controls its channels and repeat intervals.</p>
            <h4>Delivery limits</h4>
            <p>Each target receives at most 20 deliveries per hour.</p>
            <p>Twilio receives at most five messages per day.</p>
          </InfoTip>
        }
        sub="Manage saved accounts and alert destinations."
        actions={<CountBadge tone={state.targets.length ? "neutral" : "warning"}>{state.targets.length} configured</CountBadge>}
      />
      <div className="grid gap-5 px-5">
        <ProviderAccounts token={token} onChanged={state.load} />
        <ChannelList token={token} state={state} />
      </div>
    </Panel>
  );
}

export function ChannelList({ token, state, layout = "list" }: { token: string; state: NotificationTargetsState; layout?: "list" | "grid" }) {
  const { targets, credentialStorageReady, loading, error, setError, load } = state;
  const [adding, setAdding] = useState<NotificationChannel | null>(null);
  const [saved, setSaved] = useState("");
  const grid = layout === "grid";
  const fullWidth = grid ? "lg:col-span-2 xl:col-span-3" : "";
  // Ghost cells complete the current grid row after the add cell, so the row
  // count is stable: 1 channel → [channel][add][ghost], 2 → [c][c][add],
  // 3 → a fresh [add][ghost][ghost] row. Counts differ per column count.
  const cells = targets.length + 1;
  const ghosts = (columns: number) => (columns - (cells % columns)) % columns;

  async function patchLabel(target: NotificationTarget, label: string) {
    setError("");
    try {
      await api(`/api/targets/${encodeURIComponent(target.id)}`, token, { method: "PATCH", body: JSON.stringify({ label }) });
      await load();
    } catch (cause) { setError(message(cause)); }
  }

  async function remove(target: NotificationTarget) {
    setError("");
    try {
      await api(`/api/targets/${encodeURIComponent(target.id)}`, token, { method: "DELETE" });
      await load();
    } catch (cause) { setError(message(cause)); }
  }

  return (
    <div className={`grid gap-2.5 ${grid ? "lg:grid-cols-2 xl:grid-cols-3" : ""}`} data-channel-grid={grid || undefined}>
      {!credentialStorageReady && !loading && <div className={fullWidth}><CredentialWarning /></div>}
      {error && <div className={fullWidth}><Notice tone="error">{error}</Notice></div>}
      {saved && <p className="sr-only" role="status">{saved}</p>}
      {loading && <p className={`${fullWidth} py-2.5 text-[13px] text-muted`}>Loading alert channels…</p>}
      {targets.map(target => <ChannelRow key={target.id} target={target} onLabel={label => void patchLabel(target, label)} onRemove={() => void remove(target)} />)}
      <AddChannelRow disabled={!credentialStorageReady} onPick={channel => { setSaved(""); setAdding(channel); }} />
      {grid && Array.from({ length: ghosts(2) }, (_, index) => <GhostCell key={`ghost-2-${index}`} className="hidden lg:block xl:hidden" />)}
      {grid && Array.from({ length: ghosts(3) }, (_, index) => <GhostCell key={`ghost-3-${index}`} className="hidden xl:block" />)}
      {adding && <ChannelSetupModal channel={adding} token={token} onClose={() => setAdding(null)} onSaved={async () => { setSaved(`${adding.label} channel saved.`); setAdding(null); await load(); }} />}
    </div>
  );
}

/** Empty slot that keeps a channel-grid row visually complete. */
function GhostCell({ className }: { className: string }) {
  return <span aria-hidden="true" className={`min-h-[74px] rounded-panel border border-dashed border-line-soft ${className}`} />;
}

function CredentialWarning() {
  return (
    <div className="flex gap-[11px] rounded-field border border-danger-line bg-danger-bg px-3.5 py-3">
      <Icon name="alert" className="mt-px size-[18px]" />
      <div><strong className="text-[13px]">Credential encryption is unavailable</strong><p className="mt-0.5 text-[12.5px] text-muted">Set BROLLY_CREDENTIAL_KEY before saving a channel.</p></div>
    </div>
  );
}

export function AddChannelRow({ disabled = false, label = "Add alert channel", compact = false, onPick }: { disabled?: boolean; label?: string; compact?: boolean; onPick: (channel: NotificationChannel) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, open, () => setOpen(false));
  return (
    <div ref={ref} className="relative h-full" data-channel-add-cell>
      <button type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(current => !current)} className={compact
        ? "group flex min-h-12 w-full cursor-pointer items-center gap-2.5 rounded-field border border-dashed border-line bg-panel px-2 py-1.5 text-left text-[12.5px] font-[650] text-muted transition-colors hover:border-orange hover:bg-orange-soft/30 hover:text-ink disabled:cursor-not-allowed disabled:opacity-55"
        : "flex min-h-[74px] w-full cursor-pointer items-center justify-center gap-2 rounded-panel border border-dashed border-line bg-transparent px-4 py-4 text-[13.5px] font-[650] text-muted hover:border-orange hover:text-ink disabled:cursor-not-allowed disabled:opacity-55"}>
        {compact
          ? <span aria-hidden="true" className="grid size-[38px] flex-none place-items-center rounded-lg border border-dashed border-line text-[18px] leading-none group-hover:border-orange group-hover:text-orange">+</span>
          : <span aria-hidden="true" className="text-[18px] leading-none">+</span>} {label}
      </button>
      {open && (
        <ul role="menu" className="absolute left-0 right-0 top-full z-30 mt-1.5 grid min-w-[280px] list-none gap-0.5 rounded-panel border border-line bg-panel p-1.5 shadow-panel">
          {NOTIFICATION_CHANNELS.map(channel => (
            <li key={channel.kind} role="none"><button type="button" role="menuitem" data-channel-kind={channel.kind} onClick={() => { setOpen(false); onPick(channel); }} className="flex w-full cursor-pointer items-start gap-2.5 rounded-field border-0 bg-transparent px-2.5 py-2 text-left hover:bg-panel-soft"><ChannelLogo kind={channel.kind} /><span><strong className="block text-[13px]">{channel.label}</strong><span className="block text-[12px] text-muted">{channel.description}</span></span></button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Shared channel-creation surface used by setup and alert-level assignment. */
export function ChannelSetupModal({ channel, token, onClose, onSaved }: {
  channel: NotificationChannel;
  token: string;
  onClose: () => void;
  onSaved: (targetId: string) => Promise<void>;
}) {
  const titleId = `add-${channel.kind}-channel-title`;
  return (
    <Modal
      labelledBy={titleId}
      onClose={onClose}
      header={(
        <div className="flex items-start gap-3">
          <ChannelLogo kind={channel.kind} />
          <div><h2 id={titleId}>Add {channel.label}</h2><p>{channel.description}</p></div>
        </div>
      )}
    >
      <ChannelCredentialsForm channel={channel} token={token} onCancel={onClose} onSaved={onSaved} />
    </Modal>
  );
}

function ChannelRow({ target, onLabel, onRemove }: { target: NotificationTarget; onLabel: (label: string) => void; onRemove: () => void }) {
  const [label, setLabel] = useState(target.label ?? "");
  useEffect(() => setLabel(target.label ?? ""), [target.label]);
  const commit = () => { const value = label.trim(); if (value && value !== target.label) onLabel(value); else setLabel(target.label ?? ""); };
  return (
    <article className="flex min-h-[74px] flex-wrap items-center gap-3 rounded-panel border border-line p-3.5" data-channel-card>
      <ChannelLogo kind={target.kind} />
      <div className="min-w-0 flex-1">
        <input aria-label={`Label for ${channelLabel(target.kind)} channel`} className="w-full max-w-[32ch] rounded-field border border-transparent bg-transparent px-1.5 py-0.5 text-[13.5px] font-[680] text-ink hover:border-field-line focus:border-orange focus:outline-none" value={label} onChange={event => setLabel(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
        <p className="mt-0.5 px-1.5 text-[12px] text-muted">{channelLabel(target.kind)}{target.lastDeliveryAt ? ` · ${target.lastDeliveryOk ? "Delivered" : "Failed"} ${relativeTime(target.lastDeliveryAt)}` : ""}</p>
        {target.lastDeliveryOk === false && target.lastDeliveryError && <p className="mt-1 px-1.5 text-[12px] text-danger">{target.lastDeliveryError}</p>}
      </div>
      <Button variant="quiet" onClick={onRemove} title="Remove channel" aria-label={`Remove ${channelLabel(target.kind)} channel`}><Icon name="x" /></Button>
    </article>
  );
}

export function ChannelCredentialsForm({ channel, token, onCancel, onSaved }: { channel: NotificationChannel; token: string; onCancel?: () => void; onSaved: (targetId: string) => Promise<void> }) {
  const providers = useNotificationProviders(token);
  const existing = providers.providers.find(provider => provider.kind === channel.kind);
  const providerKind = PROVIDER_KINDS.includes(channel.kind as ProviderKind) ? channel.kind as ProviderKind : null;
  const [changeAccount, setChangeAccount] = useState(false);
  const [label, setLabel] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [recipients, setRecipients] = useState([""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = useCallback((key: string, value: string) => setFields(current => ({ ...current, [key]: value })), []);
  const emailChannel = channel.kind === "cloudflare_email" || channel.kind === "postmark" || channel.kind === "resend";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body: Record<string, unknown> = { kind: channel.kind, label: label.trim() };
      if (providerKind) {
        body.destination = { to: emailChannel ? recipients.map(recipient => recipient.trim()) : fields.to };
        if (!existing || changeAccount) body.provider = { config: providerConfig(providerKind, fields) };
      } else {
        body.config = channel.kind === "webhook" ? { url: fields.url, token: fields.token || undefined } : { url: fields.url };
      }
      const result = await api<{ id: string }>("/api/targets", token, { method: "POST", body: JSON.stringify(body) });
      await onSaved(result.id);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  const accountFieldsVisible = Boolean(providerKind && (!existing || changeAccount));
  return (
    <form className="flex flex-col gap-2.5" onSubmit={submit}>
      <TextField label="Channel label" required value={label} onChange={event => setLabel(event.target.value)} placeholder={channelLabel(channel.kind)} maxLength={80} />
      {providerKind && existing && !changeAccount && (
        <div className="flex items-center justify-between gap-3 rounded-field bg-panel-soft px-3 py-2 text-[12.5px]"><span><strong>{channelLabel(channel.kind)}</strong> · from {existing.from}</span><button type="button" className="text-orange-deep underline" onClick={() => setChangeAccount(true)}>Change account</button></div>
      )}
      {providerKind === "cloudflare_email" && accountFieldsVisible && <CloudflareEmailAccountFields token={token} fields={fields} set={set} />}
      {providerKind && providerKind !== "cloudflare_email" && accountFieldsVisible && <ProviderCredentialFields kind={providerKind} fields={fields} set={set} />}
      {emailChannel
        ? <RecipientFields values={recipients} onChange={setRecipients} />
        : providerKind
          ? <TextField label="Destination number" required type="tel" value={fields.to ?? ""} onChange={event => set("to", event.target.value)} />
          : <WebhookFields channel={channel} fields={fields} set={set} />}
      <p className="m-0 flex items-center gap-[7px] text-[12px] text-muted"><Icon name="shield" className="size-3.5" /> Brolly stores credentials in encrypted form.</p>
      {providers.error && <Notice tone="error">{providers.error}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">{onCancel && <Button variant="quiet" onClick={onCancel} disabled={busy}>Cancel</Button>}<Button type="submit" variant="primary" data-action="save-channel" disabled={busy || providers.loading}>{busy ? "Saving…" : "Save alert channel"}</Button></div>
    </form>
  );
}

function RecipientFields({ values, onChange }: { values: string[]; onChange: (values: string[]) => void }) {
  const update = (index: number, value: string) => onChange(values.map((recipient, position) => position === index ? value : recipient));
  const remove = (index: number) => onChange(values.filter((_, position) => position !== index));
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-[12.5px] font-[680]">Recipients</legend>
      {values.map((recipient, index) => (
        <div key={index} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <label className="sr-only" htmlFor={`notification-recipient-${index}`}>Recipient {index + 1}</label>
          <input id={`notification-recipient-${index}`} aria-label={`Recipient ${index + 1}`} className="min-h-[38px] w-full rounded-field border border-field-line bg-field px-2.5 text-[13px] text-ink focus:border-orange focus:outline-none" required type="email" value={recipient} onChange={event => update(index, event.target.value)} />
          {values.length > 1 && <Button variant="quiet" onClick={() => remove(index)} aria-label={`Remove recipient ${index + 1}`}><Icon name="x" /> Remove</Button>}
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <small className="text-[12px] text-muted">Every address in this channel receives the same alert.</small>
        <Button variant="secondary" size="small" data-action="add-recipient" disabled={values.length >= MAX_EMAIL_RECIPIENTS} onClick={() => onChange([...values, ""])}><span aria-hidden="true">+</span> Add recipient</Button>
      </div>
    </fieldset>
  );
}

function ProviderCredentialFields({ kind, fields, set }: { kind: ProviderKind; fields: Record<string, string>; set: (key: string, value: string) => void }) {
  if (kind === "twilio") return <><TextField label="Account SID" required value={fields.accountSid ?? ""} onChange={event => set("accountSid", event.target.value)} /><TextField label="Auth token" required type="password" autoComplete="new-password" value={fields.token ?? ""} onChange={event => set("token", event.target.value)} /><TextField label="From number" required type="tel" value={fields.from ?? ""} onChange={event => set("from", event.target.value)} /></>;
  return <><TextField label="API token" required type="password" autoComplete="new-password" value={fields.token ?? ""} onChange={event => set("token", event.target.value)} /><TextField label="From address" required type="email" value={fields.from ?? ""} onChange={event => set("from", event.target.value)} /></>;
}

function CloudflareEmailAccountFields({ token, fields, set }: { token: string; fields: Record<string, string>; set: (key: string, value: string) => void }) {
  const [accountId, setAccountId] = useState("");
  const [zones, setZones] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => { void api<{ accountId: string; zones: Array<{ id: string; name: string }> }>("/api/cloudflare-zones", token).then(result => { setAccountId(result.accountId); setZones(result.zones); set("accountId", result.accountId); if (result.zones[0]) set("domain", result.zones[0].name); }).catch(() => undefined); }, [set, token]);
  const from = `${fields.localPart || "brolly"}@${fields.domain || zones[0]?.name || ""}`;
  useEffect(() => { if (from.includes("@") && !from.endsWith("@")) set("from", from); }, [from, set]);
  return <>
    <a className="inline-flex w-max items-center gap-1.5 text-[13px] font-[680] text-orange-deep underline" href={emailSendingTokenTemplateUrl(accountId)} target="_blank" rel="noreferrer">Create an Email Sending token in Cloudflare <Icon name="external" className="size-3.5" /></a>
    <p className="text-[12px] text-muted">Cloudflare&apos;s token creation page will be pre-configured with your account values.</p>
    <TextField label="API token" required type="password" autoComplete="new-password" value={fields.token ?? ""} onChange={event => set("token", event.target.value)} />
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-2 max-md:grid-cols-1"><TextField label="Local part" required value={fields.localPart ?? "brolly"} onChange={event => set("localPart", event.target.value)} /><SelectField label="Domain" required value={fields.domain ?? zones[0]?.name ?? ""} onChange={event => set("domain", event.target.value)}>{zones.map(zone => <option key={zone.id} value={zone.name}>{zone.name}</option>)}</SelectField></div>
    <p className="text-[12px] text-muted">The domain must be onboarded in <a className="underline" href={emailServiceOnboardingUrl(accountId)} target="_blank" rel="noreferrer">Compute → Email Service</a>.</p>
  </>;
}

function WebhookFields({ channel, fields, set }: { channel: NotificationChannel; fields: Record<string, string>; set: (key: string, value: string) => void }) {
  return <><TextField label={`${channel.label} URL`} required type="url" value={fields.url ?? ""} onChange={event => set("url", event.target.value)} />{channel.kind === "webhook" && <TextField label="Bearer token (optional)" type="password" autoComplete="new-password" value={fields.token ?? ""} onChange={event => set("token", event.target.value)} />}</>;
}

function ProviderAccounts({ token, onChanged }: { token: string; onChanged: () => Promise<void> }) {
  const state = useNotificationProviders(token);
  const [editing, setEditing] = useState<NotificationProvider | null>(null);
  const [error, setError] = useState("");
  async function remove(provider: NotificationProvider) {
    setError("");
    try { await api(`/api/providers/${provider.kind}`, token, { method: "DELETE" }); await state.load(); await onChanged(); }
    catch (cause) { setError(message(cause)); }
  }
  return <section className="grid gap-2.5" aria-labelledby="notification-accounts"><div><h3 id="notification-accounts" className="text-[14px] font-[720]">Accounts</h3><p className="mt-0.5 text-[12.5px] text-muted">Saved credentials are shared by channels of the same kind.</p></div>{state.providers.length === 0 && !state.loading && <p className="rounded-field bg-panel-soft px-3 py-2.5 text-[12.5px] text-muted">No saved accounts.</p>}{state.providers.map(provider => <div key={provider.kind} className="rounded-field border border-line-soft px-3 py-2.5"><div className="flex items-center gap-2"><ChannelLogo kind={provider.kind} /><span className="min-w-0 flex-1 text-[12.5px]"><strong className="block">{channelLabel(provider.kind)}</strong><span className="text-muted">From {provider.from}</span></span><Button variant="quiet" onClick={() => setEditing(provider)}>Change</Button><Button variant="quiet" onClick={() => void remove(provider)}>Remove</Button></div>{editing?.kind === provider.kind && <ProviderAccountForm token={token} provider={provider} onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await state.load(); await onChanged(); }} />}</div>)}{(error || state.error) && <Notice tone="error">{error || state.error}</Notice>}</section>;
}

function ProviderAccountForm({ token, provider, onCancel, onSaved }: { token: string; provider: NotificationProvider; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = useCallback((key: string, value: string) => setFields(current => ({ ...current, [key]: value })), []);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await api(`/api/providers/${provider.kind}`, token, { method: "PATCH", body: JSON.stringify({ config: providerConfig(provider.kind, fields) }) }); await onSaved(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } }
  return <form className="mt-3 grid gap-2.5 border-t border-line-soft pt-3" onSubmit={submit}>{provider.kind === "cloudflare_email" ? <CloudflareEmailAccountFields token={token} fields={fields} set={set} /> : <ProviderCredentialFields kind={provider.kind} fields={fields} set={set} />}{error && <Notice tone="error">{error}</Notice>}<div className="flex justify-end gap-2"><Button variant="quiet" onClick={onCancel}>Cancel</Button><Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : "Save account"}</Button></div></form>;
}

function providerConfig(kind: ProviderKind, fields: Record<string, string>): Record<string, string> {
  return kind === "twilio" ? { accountSid: fields.accountSid ?? "", token: fields.token ?? "", from: fields.from ?? "" } : kind === "cloudflare_email" ? { accountId: fields.accountId ?? "", token: fields.token ?? "", from: fields.from ?? "" } : { token: fields.token ?? "", from: fields.from ?? "" };
}

function TextField({ label, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) { return <label className="flex flex-col gap-[5px] text-[12.5px] font-[680]">{label}<input className="min-h-[38px] w-full rounded-field border border-field-line bg-field px-2.5 text-[13px] text-ink focus:border-orange focus:outline-none" {...rest} /></label>; }
function SelectField({ label, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: ReactNode }) { return <label className="flex flex-col gap-[5px] text-[12.5px] font-[680]">{label}<select className="min-h-[38px] w-full rounded-field border border-field-line bg-field px-2.5 text-[13px] text-ink focus:border-orange focus:outline-none" {...rest}>{children}</select></label>; }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
