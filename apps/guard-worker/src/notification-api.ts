import { notificationWebhookUrl } from "@standardagents/brolly-notifiers";
import { openJson, sealJson } from "./credentials.js";
import type { Env } from "./env.js";

export const PROVIDER_KINDS = ["twilio", "cloudflare_email", "resend", "postmark"] as const;
export type ProviderKind = typeof PROVIDER_KINDS[number];

const TARGET_KINDS = ["cloudflare_email", "discord", "postmark", "resend", "slack", "twilio", "webhook"] as const;

interface StoredProviderRow {
  id: string;
  kind: ProviderKind;
  config_json: string;
  updated_at: number;
}

interface TargetWrite {
  id?: string;
  kind: string;
  label?: string | null;
  config?: Record<string, unknown>;
  provider?: { config?: Record<string, unknown> };
  destination?: { to?: string };
}

export async function notificationApiRoute(
  request: Request,
  env: Env,
  actor: string,
  fetcher: typeof fetch = fetch,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/providers" && request.method === "GET") {
    return Response.json({ providers: await listProviders(env) }, { headers: { "cache-control": "no-store" } });
  }

  const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
  if (providerMatch && (request.method === "PATCH" || request.method === "DELETE")) {
    const kind = decodeURIComponent(providerMatch[1]!) as ProviderKind;
    if (!isProviderKind(kind)) return Response.json({ error: "Unknown notification account kind" }, { status: 404 });
    if (request.method === "DELETE") return removeProvider(env, actor, kind);
    const body = await request.json<{ config?: Record<string, unknown> } & Record<string, unknown>>();
    const config = body.config && typeof body.config === "object" ? body.config : body;
    return replaceProvider(env, actor, kind, config, fetcher);
  }

  if (url.pathname === "/api/targets" && request.method === "GET") {
    const result = await env.DB.prepare(
      `SELECT t.id,t.kind,t.label,t.enabled,t.provider_id,t.created_at,t.updated_at,
         (SELECT created_at FROM notification_deliveries d WHERE d.target_id=t.id ORDER BY created_at DESC LIMIT 1) AS last_delivery_at,
         (SELECT ok FROM notification_deliveries d WHERE d.target_id=t.id ORDER BY created_at DESC LIMIT 1) AS last_delivery_ok,
         (SELECT error FROM notification_deliveries d WHERE d.target_id=t.id ORDER BY created_at DESC LIMIT 1) AS last_delivery_error
       FROM notification_targets t ORDER BY lower(t.label),t.created_at`,
    ).all<Record<string, unknown>>();
    return Response.json({
      credentialStorageReady: Boolean(env.BROLLY_CREDENTIAL_KEY),
      targets: result.results.map(row => ({
        id: String(row.id), kind: String(row.kind), label: String(row.label), enabled: Number(row.enabled) === 1,
        providerId: row.provider_id == null ? null : String(row.provider_id),
        createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
        lastDeliveryAt: row.last_delivery_at == null ? null : Number(row.last_delivery_at),
        lastDeliveryOk: row.last_delivery_ok == null ? null : Number(row.last_delivery_ok) === 1,
        lastDeliveryError: row.last_delivery_error == null ? null : String(row.last_delivery_error),
      })),
    }, { headers: { "cache-control": "no-store" } });
  }

  if (url.pathname === "/api/targets" && request.method === "POST") {
    return saveTarget(request, env, actor, fetcher);
  }

  const targetMatch = url.pathname.match(/^\/api\/targets\/([^/]+)$/);
  if (targetMatch && request.method === "PATCH") {
    const id = decodeURIComponent(targetMatch[1]!);
    const body = await request.json<{ label?: string | null }>();
    if (body.label === undefined) return Response.json({ error: "No channel change supplied" }, { status: 400 });
    const label = normalizeTargetLabel(body.label);
    if (typeof label !== "string") return Response.json({ error: labelError(label) }, { status: 400 });
    if (await duplicateTargetLabel(env.DB, label, id)) return Response.json({ error: "Another alert channel uses this label" }, { status: 400 });
    const result = await env.DB.prepare(`UPDATE notification_targets SET label=?2,updated_at=?3 WHERE id=?1`)
      .bind(id, label, Date.now()).run();
    if (Number(result.meta.changes ?? 0) === 0) return Response.json({ error: "Notification target not found" }, { status: 404 });
    await audit(env.DB, actor, "notification_target.update", id, { label });
    return Response.json({ ok: true, id });
  }

  if (targetMatch && request.method === "DELETE") {
    const id = decodeURIComponent(targetMatch[1]!);
    const result = await env.DB.prepare(`DELETE FROM notification_targets WHERE id=?1`).bind(id).run();
    if (Number(result.meta.changes ?? 0) === 0) return Response.json({ error: "Notification target not found" }, { status: 404 });
    await audit(env.DB, actor, "notification_target.delete", id, {});
    return Response.json({ ok: true, id });
  }

  return null;
}

async function saveTarget(request: Request, env: Env, actor: string, fetcher: typeof fetch): Promise<Response> {
  const body = await request.json<TargetWrite>();
  if (!TARGET_KINDS.includes(body.kind as typeof TARGET_KINDS[number])) {
    return Response.json({ error: "Invalid notification target kind" }, { status: 400 });
  }
  const label = normalizeTargetLabel(body.label);
  if (typeof label !== "string") return Response.json({ error: labelError(label) }, { status: 400 });
  if (!env.BROLLY_CREDENTIAL_KEY) {
    return Response.json({ error: "BROLLY_CREDENTIAL_KEY is required; target credentials will never be stored in plaintext" }, { status: 503 });
  }
  const id = body.id ?? crypto.randomUUID();
  if (await duplicateTargetLabel(env.DB, label, id)) return Response.json({ error: "Another alert channel uses this label" }, { status: 400 });

  let providerId: string | null = null;
  let config: Record<string, unknown>;
  const now = Date.now();
  if (isProviderKind(body.kind)) {
    const destination = { to: body.destination?.to };
    let providerConfig: Record<string, unknown>;
    if (body.provider) {
      providerConfig = body.provider.config ?? {};
      const providerError = validateProviderConfig(body.kind, providerConfig, env.BROLLY_ACCOUNT_ID);
      if (providerError) return Response.json({ error: providerError }, { status: 400 });
      const mergedError = validateNotificationConfig(body.kind, { ...providerConfig, ...destination });
      if (mergedError) return Response.json({ error: mergedError }, { status: 400 });
      if (body.kind === "cloudflare_email") {
        try { await verifyCloudflareEmailToken(String(providerConfig.token), fetcher); }
        catch (error) { return Response.json({ error: errorMessage(error) }, { status: 400 }); }
      }
      const replacement = await replaceProvider(env, actor, body.kind, providerConfig, fetcher, true);
      if (!replacement.ok) return replacement;
      providerId = providerIdFor(body.kind);
    } else {
      const row = await env.DB.prepare(`SELECT id,config_json FROM notification_providers WHERE kind=?1 LIMIT 1`)
        .bind(body.kind).first<{ id: string; config_json: string }>();
      if (!row) return Response.json({ error: providerRequiredMessage(body.kind) }, { status: 400 });
      providerId = row.id;
      providerConfig = await openJson<Record<string, unknown>>(row.config_json, env.BROLLY_CREDENTIAL_KEY);
    }
    config = { ...providerConfig, ...destination };
  } else {
    config = body.config ?? {};
  }

  const configError = validateNotificationConfig(body.kind, config);
  if (configError) return Response.json({ error: configError }, { status: 400 });
  const targetStatement = env.DB.prepare(
    `INSERT INTO notification_targets(id,kind,label,config_json,enabled,provider_id,created_at,updated_at)
     VALUES(?1,?2,?3,?4,1,?5,?6,?6)
     ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,label=excluded.label,config_json=excluded.config_json,
       enabled=1,provider_id=excluded.provider_id,updated_at=excluded.updated_at`,
  ).bind(id, body.kind, label, await sealJson(config, env.BROLLY_CREDENTIAL_KEY), providerId, now);
  await targetStatement.run();
  await audit(env.DB, actor, "notification_target.upsert", id, { kind: body.kind, label, providerId });
  return Response.json({ ok: true, id });
}

async function listProviders(env: Env): Promise<Array<{ kind: ProviderKind; from: string; updatedAt: number }>> {
  if (!env.BROLLY_CREDENTIAL_KEY) return [];
  const result = await env.DB.prepare(
    `SELECT id,kind,config_json,updated_at FROM notification_providers ORDER BY kind`,
  ).all<StoredProviderRow>();
  return Promise.all(result.results.map(async row => {
    const config = await openJson<Record<string, unknown>>(row.config_json, env.BROLLY_CREDENTIAL_KEY!);
    return { kind: row.kind, from: String(config.from ?? ""), updatedAt: Number(row.updated_at) };
  }));
}

async function replaceProvider(
  env: Env,
  actor: string,
  kind: ProviderKind,
  config: Record<string, unknown>,
  fetcher: typeof fetch,
  verified = false,
): Promise<Response> {
  if (!env.BROLLY_CREDENTIAL_KEY) return Response.json({ error: "Credential encryption is not configured" }, { status: 503 });
  const providerError = verified ? null : validateProviderConfig(kind, config, env.BROLLY_ACCOUNT_ID);
  if (providerError) return Response.json({ error: providerError }, { status: 400 });
  if (!verified && kind === "cloudflare_email") {
    try { await verifyCloudflareEmailToken(String(config.token), fetcher); }
    catch (error) { return Response.json({ error: errorMessage(error) }, { status: 400 }); }
  }
  const existing = await env.DB.prepare(`SELECT id FROM notification_providers WHERE kind=?1 LIMIT 1`)
    .bind(kind).first<{ id: string }>();
  const providerId = existing?.id ?? providerIdFor(kind);
  const targets = await env.DB.prepare(`SELECT id,config_json FROM notification_targets WHERE provider_id=?1 ORDER BY id`)
    .bind(providerId).all<{ id: string; config_json: string }>();
  const now = Date.now();
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `INSERT INTO notification_providers(id,kind,config_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)
     ON CONFLICT(kind) DO UPDATE SET config_json=excluded.config_json,updated_at=excluded.updated_at`,
  ).bind(providerId, kind, await sealJson(config, env.BROLLY_CREDENTIAL_KEY), now)];
  for (const target of targets.results) {
    const current = await openJson<Record<string, unknown>>(target.config_json, env.BROLLY_CREDENTIAL_KEY);
    const merged = { ...config, to: current.to };
    const error = validateNotificationConfig(kind, merged);
    if (error) return Response.json({ error }, { status: 400 });
    statements.push(env.DB.prepare(`UPDATE notification_targets SET config_json=?2,updated_at=?3 WHERE id=?1`)
      .bind(target.id, await sealJson(merged, env.BROLLY_CREDENTIAL_KEY), now));
  }
  await env.DB.batch(statements);
  await audit(env.DB, actor, "notification_provider.update", kind, { channels: targets.results.length });
  return Response.json({ ok: true, kind, channels: targets.results.length });
}

async function removeProvider(env: Env, actor: string, kind: ProviderKind): Promise<Response> {
  const row = await env.DB.prepare(`SELECT id FROM notification_providers WHERE kind=?1 LIMIT 1`).bind(kind).first<{ id: string }>();
  if (!row) return Response.json({ error: "Notification account not found" }, { status: 404 });
  const used = await env.DB.prepare(`SELECT COUNT(*) AS count FROM notification_targets WHERE provider_id=?1`).bind(row.id).first<{ count: number }>();
  if (Number(used?.count ?? 0) > 0) {
    return Response.json({ error: "Remove this account's alert channels before removing the account" }, { status: 409 });
  }
  await env.DB.prepare(`DELETE FROM notification_providers WHERE id=?1`).bind(row.id).run();
  await audit(env.DB, actor, "notification_provider.delete", kind, {});
  return Response.json({ ok: true, kind });
}

export function validateProviderConfig(kind: string, config: Record<string, unknown> | null | undefined, accountId?: string): string | null {
  if (!config || typeof config !== "object") return "Account details are required";
  const present = (key: string) => typeof config[key] === "string" && String(config[key]).trim().length > 0;
  if (kind === "twilio" && !["accountSid", "token", "from"].every(present)) return "Twilio account SID, auth token, and from number are required";
  if ((kind === "resend" || kind === "postmark") && !["token", "from"].every(present)) return `${displayKind(kind)} API token and from address are required`;
  if (kind === "cloudflare_email" && !["accountId", "token", "from"].every(present)) return "Cloudflare account, API token, and from address are required";
  if (kind === "cloudflare_email" && accountId && String(config.accountId) !== accountId) return "Cloudflare Email must use the connected account";
  if (!isProviderKind(kind)) return "This channel does not use a saved account";
  return null;
}

export function validateNotificationConfig(kind: string, config: Record<string, unknown> | null | undefined): string | null {
  if (!config || typeof config !== "object") return "Notification configuration is required";
  const present = (key: string) => typeof config[key] === "string" && String(config[key]).trim().length > 0;
  if ((kind === "discord" || kind === "slack" || kind === "webhook") && !present("url")) return `${kind} webhook URL is required`;
  if (kind === "discord" || kind === "slack" || kind === "webhook") {
    try { notificationWebhookUrl(kind, String(config.url)); }
    catch (error) { return errorMessage(error); }
  }
  if (kind === "twilio" && !["accountSid", "token", "from", "to"].every(present)) return "Twilio account SID, auth token, from number, and destination number are required";
  if ((kind === "resend" || kind === "postmark") && !["token", "from", "to"].every(present)) return `${displayKind(kind)} API token, from address, and destination address are required`;
  if (kind === "cloudflare_email" && !["accountId", "token", "from", "to"].every(present)) return "Cloudflare account, API token, from address, and destination address are required";
  return null;
}

export async function verifyCloudflareEmailToken(token: string, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher("https://api.cloudflare.com/client/v4/user/tokens/verify", {
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Cloudflare rejected this API token (${response.status})`);
  const payload = await response.json() as { success?: boolean; result?: { status?: string }; errors?: Array<{ message?: string }> };
  if (!payload.success) throw new Error(payload.errors?.map(error => error.message).filter(Boolean).join("; ") || "Cloudflare rejected this API token");
  if (payload.result?.status !== "active") throw new Error("Cloudflare reports that this API token is inactive");
}

function isProviderKind(kind: string): kind is ProviderKind {
  return PROVIDER_KINDS.includes(kind as ProviderKind);
}

function providerIdFor(kind: ProviderKind): string {
  return `provider:${kind}`;
}

function providerRequiredMessage(kind: ProviderKind): string {
  if (kind === "twilio") return "Twilio account details are required";
  if (kind === "cloudflare_email") return "Cloudflare Email account details are required";
  return `${displayKind(kind)} account details are required`;
}

function displayKind(kind: string): string {
  return kind === "postmark" ? "Postmark" : kind === "resend" ? "Resend" : kind;
}

function normalizeTargetLabel(label: string | null | undefined): string | false | null {
  if (label == null) return null;
  const trimmed = String(label).trim();
  if (!trimmed || trimmed.length > 80) return false;
  return trimmed;
}

function labelError(label: false | null): string {
  return label === null ? "Channel label is required" : "Channel label must contain 1 to 80 characters";
}

async function duplicateTargetLabel(db: D1Database, label: string, exceptId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS present FROM notification_targets WHERE label=?1 COLLATE NOCASE AND id!=?2 LIMIT 1`)
    .bind(label, exceptId).first();
  return Boolean(row);
}

async function audit(db: D1Database, actor: string, action: string, target: string, detail: unknown): Promise<void> {
  await db.prepare(`INSERT INTO audit_log(id,actor,action,target,detail_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)`)
    .bind(crypto.randomUUID(), actor, action, target, JSON.stringify(detail), Date.now()).run();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
