import type { Incident } from "@standardagents/brolly-core";

export type NotificationKind = "discord" | "slack" | "webhook" | "resend" | "postmark" | "twilio";

export interface NotificationTarget {
  id: string;
  kind: NotificationKind;
  url?: string;
  token?: string;
  from?: string;
  to?: string;
  accountSid?: string;
  enabled: boolean;
}

export interface NotificationResult { targetId: string; ok: boolean; status?: number; error?: string }

export async function notify(target: NotificationTarget, incident: Incident, fetcher: typeof fetch = fetch): Promise<NotificationResult> {
  if (!target.enabled) return { targetId: target.id, ok: true };
  try {
    const request = buildRequest(target, incident);
    const response = await fetcher(request.url, request.init);
    return response.ok
      ? { targetId: target.id, ok: true, status: response.status }
      : { targetId: target.id, ok: false, status: response.status, error: await response.text() };
  } catch (error) {
    return { targetId: target.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function buildRequest(target: NotificationTarget, incident: Incident): { url: string; init: RequestInit } {
  const summary = `[Brolly ${incident.severity.toUpperCase()}] ${incident.asset.family}/${incident.asset.name ?? incident.asset.id}: ${incident.reason}. Observed ${incident.observed.toLocaleString()} ${incident.metric}.`;
  const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  switch (target.kind) {
    case "discord": return { url: required(target.url, "Discord webhook URL"), init: json({ content: summary }) };
    case "slack": return { url: required(target.url, "Slack webhook URL"), init: json({ text: summary }) };
    case "webhook": return { url: required(target.url, "Webhook URL"), init: json({ type: "brolly.incident", incident }, target.token ? { authorization: `Bearer ${target.token}` } : {}) };
    case "resend": return { url: "https://api.resend.com/emails", init: json({ from: required(target.from, "Resend from"), to: [required(target.to, "Resend to")], subject: summary.slice(0, 150), text: summary }, { authorization: `Bearer ${required(target.token, "Resend token")}` }) };
    case "postmark": return { url: "https://api.postmarkapp.com/email", init: json({ From: required(target.from, "Postmark from"), To: required(target.to, "Postmark to"), Subject: summary.slice(0, 150), TextBody: summary }, { "x-postmark-server-token": required(target.token, "Postmark token") }) };
    case "twilio": {
      const sid = required(target.accountSid, "Twilio account SID");
      const form = new URLSearchParams({ From: required(target.from, "Twilio from"), To: required(target.to, "Twilio to"), Body: summary });
      return { url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, init: { method: "POST", headers: { authorization: `Basic ${btoa(`${sid}:${required(target.token, "Twilio auth token")}`)}`, "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(10_000) } };
    }
  }
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}
