import type { CoverageItem, DashboardData } from "../types";

export type ConnectionKind = "connected" | "local" | "disconnected";

export interface ConnectionHealth {
  kind: ConnectionKind;
  label: string;
  title: string;
  detail: string;
  errors: string[];
}

export function parseProviderError(raw: string): { code?: number; message: string } {
  if (!raw) return { message: "" };
  try {
    const value = JSON.parse(raw) as { errors?: Array<{ code?: number; message?: string }>; message?: string };
    const first = value.errors?.[0];
    return { code: first?.code, message: first?.message ?? value.message ?? "Cloudflare returned an unspecified API error." };
  } catch {
    const code = raw.match(/"code"\s*:\s*(\d+)/)?.[1];
    const message = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
    return { code: code ? Number(code) : undefined, message: message ?? raw.replace(/^Error:\s*/i, "") };
  }
}

export function connectionHealth(data: DashboardData): ConnectionHealth {
  const placeholder = /REPLACE_DURING_INSTALL|placeholder/i.test(data.account.id);
  const providerFailures = data.coverage.gaps
    .map(item => parseProviderError(item.detail ?? ""))
    .filter(item => item.code === 7003 || item.code === 9106 || /authentication failed|could not route/i.test(item.message));
  const errors = providerFailures.map(item => item.message).filter(Boolean);
  if (placeholder) {
    return {
      kind: "local",
      label: "Local preview",
      title: "Local preview — no Cloudflare account connected",
      detail: "This instance uses a placeholder account ID, so scans cannot read live inventory or usage. Everything shown as spend or inventory is sample or stale data, never live protection.",
      errors,
    };
  }
  if (providerFailures.length > 0) {
    return {
      kind: "disconnected",
      label: "Connection needs attention",
      title: "Brolly cannot read this Cloudflare account",
      detail: "The account ID or credential was rejected. Live spend, inventory, incident detection, and shutdown actions may be incomplete until the connection is repaired.",
      errors,
    };
  }
  return {
    kind: "connected",
    label: "Cloudflare connected",
    title: "Cloudflare telemetry is connected",
    detail: "Brolly can reach the configured account. Individual meter coverage may still be partial; review the telemetry collectors on the Configuration page.",
    errors: [],
  };
}

export function coverageGuidance(item: CoverageItem): { summary: string; fix?: string } {
  const raw = item.detail?.trim() ?? "";
  const parsed = parseProviderError(raw);
  if (parsed.code === 7003 || /could not route/i.test(parsed.message)) {
    return {
      summary: "Cloudflare could not route this account inventory request.",
      fix: "Reconnect Cloudflare from Brolly and authorize the same account this installation already protects.",
    };
  }
  if (parsed.code === 9106 || /authentication failed/i.test(parsed.message)) {
    return {
      summary: "Cloudflare rejected Brolly's API credentials.",
      fix: "Reconnect the Cloudflare account or replace the expired/revoked token, then run an account scan.",
    };
  }
  if (item.state === "permission_denied") {
    return {
      summary: parsed.message || "Brolly does not have permission to read this billing signal.",
      fix: "Grant the required account-read/analytics permission, then run an account scan.",
    };
  }
  if (/no active fast-telemetry collector/i.test(parsed.message)) {
    return {
      summary: "No reliable fast telemetry collector is connected for this meter yet.",
      fix: "Keep the budget configured; enforcement activates when this collector is added. Use the daily billing reconciliation as the account-level backstop.",
    };
  }
  if (parsed.message) {
    return { summary: parsed.message, fix: item.state === "unavailable" ? "Check the Cloudflare account connection and retry the scan." : undefined };
  }
  return {
    summary: item.state === "delayed" ? "Cloudflare returned a bounded or delayed result." : "Telemetry is currently unavailable.",
    fix: "Run an account scan again; if this persists, check the account connection and collector coverage.",
  };
}
