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
    method: "POST", redirect: "error", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  switch (target.kind) {
    case "discord": return { url: notificationWebhookUrl("discord", target.url).toString(), init: json({ content: summary }) };
    case "slack": return { url: notificationWebhookUrl("slack", target.url).toString(), init: json({ text: summary }) };
    case "webhook": return { url: notificationWebhookUrl("webhook", target.url).toString(), init: json({ type: "brolly.incident", incident }, target.token ? { authorization: `Bearer ${target.token}` } : {}) };
    case "resend": return { url: "https://api.resend.com/emails", init: json({ from: required(target.from, "Resend from"), to: [required(target.to, "Resend to")], subject: summary.slice(0, 150), text: summary }, { authorization: `Bearer ${required(target.token, "Resend token")}` }) };
    case "postmark": return { url: "https://api.postmarkapp.com/email", init: json({ From: required(target.from, "Postmark from"), To: required(target.to, "Postmark to"), Subject: summary.slice(0, 150), TextBody: summary }, { "x-postmark-server-token": required(target.token, "Postmark token") }) };
    case "twilio": {
      const sid = required(target.accountSid, "Twilio account SID");
      const form = new URLSearchParams({ From: required(target.from, "Twilio from"), To: required(target.to, "Twilio to"), Body: summary });
      return { url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, init: { method: "POST", redirect: "error", headers: { authorization: `Basic ${btoa(`${sid}:${required(target.token, "Twilio auth token")}`)}`, "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(10_000) } };
    }
  }
}

export function notificationWebhookUrl(kind: "discord" | "slack" | "webhook", value: string | undefined): URL {
  let url: URL;
  try { url = new URL(required(value, `${kind} webhook URL`)); } catch (error) {
    if (error instanceof Error && error.message.endsWith("is required")) throw error;
    throw new Error(`${kind} webhook URL is invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error(`${kind} webhook must use a standard HTTPS URL`);
  if (kind === "discord" && !["discord.com", "discordapp.com"].includes(url.hostname)) throw new Error("Discord webhooks must use discord.com");
  if (kind === "discord" && !url.pathname.startsWith("/api/webhooks/")) throw new Error("Discord webhook path is invalid");
  if (kind === "slack" && url.hostname !== "hooks.slack.com") throw new Error("Slack webhooks must use hooks.slack.com");
  if (kind === "slack" && !url.pathname.startsWith("/services/")) throw new Error("Slack webhook path is invalid");
  if (kind === "webhook" && blockedWebhookHost(url.hostname)) throw new Error("Generic webhooks cannot target local or private network addresses");
  return url;
}

function blockedWebhookHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv6 = host.includes(":");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || ipv6 && (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd")
      || /^fe[89ab]/.test(host))) return true;
  const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped ?? host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.some(value => value > 255)
    || octets[0] === 0
    || octets[0] === 10
    || octets[0] === 127
    || octets[0] === 169 && octets[1] === 254
    || octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31
    || octets[0] === 192 && octets[1] === 168
    || octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127
    || octets[0] === 198 && (octets[1] === 18 || octets[1] === 19);
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}
