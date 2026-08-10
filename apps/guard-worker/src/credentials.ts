import type { Env } from "./env.js";

interface StoredOAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export async function operationalToken(env: Env): Promise<string> {
  if (!env.BROLLY_CREDENTIAL_KEY) return fallbackToken(env);
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key='oauth_credentials' LIMIT 1`).first<{ value: string }>();
  if (!row) return fallbackToken(env);
  const stored = await openJson<StoredOAuth>(row.value, env.BROLLY_CREDENTIAL_KEY);
  if (!stored.expiresAt || stored.expiresAt - Date.now() > 5 * 60_000) return stored.accessToken;
  if (!stored.refreshToken || !env.BROLLY_OAUTH_CLIENT_ID) throw new Error("Cloudflare OAuth expired and cannot be refreshed; reconnect Cloudflare from Brolly");
  const holder = crypto.randomUUID();
  const now = Date.now();
  const lease = await env.DB.prepare(
    `INSERT INTO cron_lease(name,holder,expires_at) VALUES('oauth-refresh',?1,?2)
     ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at
     WHERE cron_lease.expires_at<?3`,
  ).bind(holder, now + 30_000, now).run();
  if (Number(lease.meta.changes ?? 0) !== 1) throw new Error("Cloudflare OAuth refresh is already in progress; retry shortly");
  try {
    const currentRow = await env.DB.prepare(`SELECT value FROM settings WHERE key='oauth_credentials' LIMIT 1`).first<{ value: string }>();
    if (!currentRow) return fallbackToken(env);
    const current = await openJson<StoredOAuth>(currentRow.value, env.BROLLY_CREDENTIAL_KEY);
    if (!current.expiresAt || current.expiresAt - Date.now() > 5 * 60_000) return current.accessToken;
    if (!current.refreshToken) throw new Error("Cloudflare OAuth expired and cannot be refreshed; reconnect Cloudflare from Brolly");
    const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: env.BROLLY_OAUTH_CLIENT_ID, refresh_token: current.refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Cloudflare OAuth refresh failed (${response.status}); reconnect Cloudflare from Brolly`);
    const payload = await response.json() as { access_token: string; refresh_token?: string; expires_in?: number };
    const refreshed: StoredOAuth = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? current.refreshToken,
      expiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined,
    };
    await env.DB.prepare(`UPDATE settings SET value=?1,updated_at=?2 WHERE key='oauth_credentials'`).bind(await sealJson(refreshed, env.BROLLY_CREDENTIAL_KEY), Date.now()).run();
    return refreshed.accessToken;
  } finally {
    await env.DB.prepare(`DELETE FROM cron_lease WHERE name='oauth-refresh' AND holder=?1`).bind(holder).run();
  }
}

function fallbackToken(env: Env): string {
  if (!env.CLOUDFLARE_OAUTH_TOKEN) throw new Error("Connect this Brolly instance to Cloudflare before scanning or controlling resources");
  return env.CLOUDFLARE_OAUTH_TOKEN;
}

export async function openJson<T>(value: string, secret: string): Promise<T> {
  const envelope = JSON.parse(value) as { iv: string; ciphertext: string };
  const key = await importKey(secret);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(envelope.iv) }, key, decode(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export async function sealJson(value: unknown, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(secret);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({ iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) });
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", decode(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
}
function decode(value: string): ArrayBuffer {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, char => char.charCodeAt(0)).buffer as ArrayBuffer;
}
function encode(value: Uint8Array): string { let binary = ""; for (const byte of value) binary += String.fromCharCode(byte); return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); }
