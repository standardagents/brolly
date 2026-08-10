import type { Env } from "./env.js";

interface StoredOAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export async function operationalToken(env: Env): Promise<string> {
  if (!env.BROLLY_CREDENTIAL_KEY) return env.CLOUDFLARE_OAUTH_TOKEN;
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key='oauth_credentials' LIMIT 1`).first<{ value: string }>();
  if (!row) return env.CLOUDFLARE_OAUTH_TOKEN;
  const stored = await openJson<StoredOAuth>(row.value, env.BROLLY_CREDENTIAL_KEY);
  if (!stored.expiresAt || stored.expiresAt - Date.now() > 5 * 60_000 || !stored.refreshToken || !env.BROLLY_OAUTH_CLIENT_ID) return stored.accessToken;
  const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: env.BROLLY_OAUTH_CLIENT_ID, refresh_token: stored.refreshToken }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Cloudflare OAuth refresh failed (${response.status}): ${await response.text()}`);
  const payload = await response.json() as { access_token: string; refresh_token?: string; expires_in?: number };
  const refreshed: StoredOAuth = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? stored.refreshToken,
    expiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined,
  };
  await env.DB.prepare(`UPDATE settings SET value=?1,updated_at=?2 WHERE key='oauth_credentials'`).bind(await sealJson(refreshed, env.BROLLY_CREDENTIAL_KEY), Date.now()).run();
  return refreshed.accessToken;
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
