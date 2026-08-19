export const NOTIFICATION_TARGET_KINDS = [
  "cloudflare_email",
  "discord",
  "postmark",
  "resend",
  "slack",
  "twilio",
  "webhook",
] as const;

export const NOTIFICATION_ACCOUNT_KINDS = ["cloudflare_email", "postmark", "resend", "twilio"] as const;

export type NotificationTargetKind = typeof NOTIFICATION_TARGET_KINDS[number];
export type NotificationAccountKind = typeof NOTIFICATION_ACCOUNT_KINDS[number];

export interface NotificationTargetPayload {
  kind: NotificationTargetKind;
  label: string;
  config?: Record<string, unknown>;
  provider?: { config: Record<string, unknown> };
  destination?: { to: string | string[] };
}

/**
 * Converts the JSON document supplied to `brolly target` into the guard
 * notification API shape. Account credentials and destinations are separate
 * fields so a second channel can reuse a saved account.
 */
export function createTargetPayload(kindInput: string, document: unknown): NotificationTargetPayload {
  if (!isTargetKind(kindInput)) throw new Error(`Unknown notification channel kind: ${kindInput}`);
  if (!isRecord(document)) throw new Error("Notification channel JSON must be an object");

  const label = requiredLabel(document.label);
  if (isAccountKind(kindInput)) return createAccountTargetPayload(kindInput, label, document);

  if (!isRecord(document.config)) {
    throw new Error("Webhook, Discord, and Slack channels require a config object");
  }
  return { kind: kindInput, label, config: document.config };
}

function createAccountTargetPayload(
  kind: NotificationAccountKind,
  label: string,
  document: Record<string, unknown>,
): NotificationTargetPayload {
  const destination = readDestination(kind, document.destination);
  if (document.provider !== undefined) {
    if (!isRecord(document.provider) || !isRecord(document.provider.config)) {
      throw new Error("An account change requires a provider config object");
    }
    return { kind, label, provider: { config: document.provider.config }, destination };
  }
  return { kind, label, destination };
}

function readDestination(kind: NotificationAccountKind, value: unknown): { to: string | string[] } {
  if (!isRecord(value)) throw new Error("Provider-backed channels require a destination.to value");
  if (typeof value.to === "string") {
    const to = value.to.trim();
    if (to) return { to };
  } else if (isEmailKind(kind) && Array.isArray(value.to)) {
    const to = normalizeEmailRecipients(value.to);
    if (to.length) return { to };
  }
  throw new Error("Provider-backed channels require a non-empty destination.to value");
}

function normalizeEmailRecipients(values: unknown[]): string[] {
  if (!values.length || values.some(value => typeof value !== "string")) return [];

  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const value of values as string[]) {
    const recipient = value.trim();
    if (!recipient) continue;
    const key = recipient.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(recipient);
  }
  return recipients;
}

function requiredLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Notification channel label is required");
  const label = value.trim();
  if (label.length > 80) throw new Error("Notification channel labels must contain 1 to 80 characters");
  return label;
}

function isTargetKind(value: string): value is NotificationTargetKind {
  return (NOTIFICATION_TARGET_KINDS as readonly string[]).includes(value);
}

function isAccountKind(value: NotificationTargetKind): value is NotificationAccountKind {
  return (NOTIFICATION_ACCOUNT_KINDS as readonly string[]).includes(value);
}

function isEmailKind(value: NotificationAccountKind): value is "cloudflare_email" | "postmark" | "resend" {
  return value === "cloudflare_email" || value === "postmark" || value === "resend";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
