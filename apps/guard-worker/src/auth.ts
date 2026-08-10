import type { Env } from "./env.js";
import { sealJson } from "./credentials.js";

const AUTHORIZATION_ENDPOINT = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
const USERINFO_ENDPOINT = "https://dash.cloudflare.com/oauth2/userinfo";
const API = "https://api.cloudflare.com/client/v4";
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const SESSION_COOKIE = "brolly_session";
const STATE_COOKIE = "brolly_oauth_state";

export const BROLLY_OAUTH_SCOPES = [
  "openid",
  "offline_access",
  "user-details.read",
  "memberships.read",
  "account-settings.read",
  "account-analytics.read",
  "workers-scripts.read",
  "workers-scripts.write",
  "workers-kv-storage.metadata_read",
  "workers-r2.metadata_read",
  "d1.metadata_read",
  "queues.metadata_read",
  "queues.write",
  "vectorize.read",
  "query-cache.read",
  "pages.metadata_read",
  "aig.metadata_read",
  "zone.read",
] as const;

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

interface UserInfo {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
}

interface CloudflareAccount {
  id: string;
  name: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ message: string }>;
}

export interface AuthenticatedActor {
  kind: "session" | "break_glass";
  actor: string;
  accountId?: string;
}

export async function authRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/login" && request.method === "GET") return beginLogin(request, env);
  if (url.pathname === "/api/auth/callback" && request.method === "GET") return finishLogin(request, env);
  if (url.pathname === "/oauth/callback" && request.method === "GET") return relayCallback(request);
  if (url.pathname === "/api/auth/relay/verify" && request.method === "GET") return verifyRelay(request, env);
  if (url.pathname === "/api/auth/session" && request.method === "GET") return sessionStatus(request, env);
  if (url.pathname === "/api/auth/logout" && request.method === "POST") return logout(request, env);
  return null;
}

export async function authenticate(request: Request, env: Env): Promise<AuthenticatedActor | null> {
  const authorization = request.headers.get("authorization");
  if (env.BROLLY_ADMIN_TOKEN && authorization === `Bearer ${env.BROLLY_ADMIN_TOKEN}`) {
    return { kind: "break_glass", actor: "break-glass-token" };
  }
  const token = cookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT user_id,email,display_name,account_id,expires_at FROM auth_sessions WHERE token_hash=?1 LIMIT 1`,
  ).bind(tokenHash).first<{ user_id: string; email: string | null; display_name: string | null; account_id: string; expires_at: number }>();
  if (!row || row.expires_at <= now) return null;
  if (!safeMutationOrigin(request)) return null;
  if (now % 300_000 < 10_000) {
    await env.DB.prepare(`UPDATE auth_sessions SET last_seen_at=?2 WHERE token_hash=?1`).bind(tokenHash, now).run();
  }
  return { kind: "session", actor: row.email ?? row.display_name ?? row.user_id, accountId: row.account_id };
}

export async function configuredEnv(env: Env, actor?: AuthenticatedActor | null): Promise<Env | null> {
  const accountId = actor?.accountId ?? await configuredAccountId(env);
  return accountId ? { ...env, BROLLY_ACCOUNT_ID: accountId } : null;
}

export async function configuredAccountId(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key='account_id' LIMIT 1`).first<{ value: string }>();
  if (row?.value) return row.value;
  if (env.BROLLY_ACCOUNT_ID && !env.BROLLY_ACCOUNT_ID.startsWith("REPLACE_")) return env.BROLLY_ACCOUNT_ID;
  return null;
}

async function beginLogin(request: Request, env: Env): Promise<Response> {
  if (!oauthReady(env)) return oauthConfigurationError(env);
  const url = new URL(request.url);
  const origin = url.origin;
  const stateSecret = randomToken(32);
  const state = `${stateSecret}.${encodeText(origin)}`;
  const verifier = randomToken(48);
  const challenge = encodeBytes(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const redirectUri = env.BROLLY_OAUTH_REDIRECT_URI!;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM oauth_states WHERE expires_at < ?1`).bind(now),
    env.DB.prepare(`INSERT INTO oauth_states(state_hash,verifier,redirect_uri,created_at,expires_at) VALUES(?1,?2,?3,?4,?5)`)
      .bind(await sha256(state), verifier, redirectUri, now, now + OAUTH_STATE_TTL_MS),
  ]);
  const authorization = new URL(AUTHORIZATION_ENDPOINT);
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: env.BROLLY_OAUTH_CLIENT_ID!,
    redirect_uri: redirectUri,
    scope: BROLLY_OAUTH_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      location: authorization.toString(),
      "set-cookie": serializeCookie(STATE_COOKIE, state, request, OAUTH_STATE_TTL_MS),
      "cache-control": "no-store",
    },
  });
}

async function relayCallback(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  const origin = decodeStateOrigin(state);
  if (!origin) return htmlError("Brolly could not verify the OAuth return address.", 400);
  if (!safeRelayOrigin(origin)) return htmlError("Brolly only relays OAuth to a public HTTPS installation.", 400);
  const verifyUrl = new URL("/api/auth/relay/verify", origin);
  verifyUrl.searchParams.set("state", state);
  let callbackUrl: URL;
  try {
    const response = await fetch(verifyUrl, { signal: AbortSignal.timeout(5_000), redirect: "error" });
    const payload = await response.json() as { callbackUrl?: string };
    if (!response.ok || !payload.callbackUrl) throw new Error("The Brolly instance rejected this login state");
    callbackUrl = new URL(payload.callbackUrl);
    if (callbackUrl.origin !== origin || callbackUrl.pathname !== "/api/auth/callback") throw new Error("The Brolly callback address is invalid");
  } catch {
    return htmlError("This Cloudflare login was not started by a live Brolly instance. Return to Brolly and try again.", 400);
  }
  callbackUrl.searchParams.set("state", state);
  if (code) callbackUrl.searchParams.set("code", code);
  if (error) callbackUrl.searchParams.set("error", error);
  return new Response(null, { status: 302, headers: { location: callbackUrl.toString(), "cache-control": "no-store" } });
}

async function verifyRelay(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  if (decodeStateOrigin(state) !== url.origin) return Response.json({ error: "Invalid OAuth origin" }, { status: 400 });
  const row = await env.DB.prepare(`SELECT expires_at FROM oauth_states WHERE state_hash=?1 LIMIT 1`).bind(await sha256(state)).first<{ expires_at: number }>();
  if (!row || row.expires_at <= Date.now()) return Response.json({ error: "Unknown or expired OAuth state" }, { status: 404 });
  return Response.json({ callbackUrl: new URL("/api/auth/callback", url.origin).toString() }, { headers: { "cache-control": "no-store" } });
}

function safeRelayOrigin(value: string): boolean {
  const origin = new URL(value);
  if (origin.protocol !== "https:" || (origin.port && origin.port !== "443")) return false;
  const hostname = origin.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) return false;
  return hostname.includes(".");
}

async function finishLogin(request: Request, env: Env): Promise<Response> {
  if (!oauthReady(env)) return oauthConfigurationError(env);
  if (!env.BROLLY_CREDENTIAL_KEY) return htmlError("BROLLY_CREDENTIAL_KEY is missing. Add it as a Worker secret before connecting Cloudflare.", 503);
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const stateCookie = cookie(request, STATE_COOKIE);
  if (!state || !stateCookie || !constantTimeEqual(state, stateCookie)) return htmlError("Cloudflare login state did not match this browser. Start again from Brolly.", 400);
  const stateHash = await sha256(state);
  const row = await env.DB.prepare(`SELECT verifier,redirect_uri,expires_at FROM oauth_states WHERE state_hash=?1 LIMIT 1`).bind(stateHash)
    .first<{ verifier: string; redirect_uri: string; expires_at: number }>();
  await env.DB.prepare(`DELETE FROM oauth_states WHERE state_hash=?1`).bind(stateHash).run();
  if (!row || row.expires_at <= Date.now()) return htmlError("Cloudflare login expired. Start again from Brolly.", 400);
  const oauthError = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (oauthError || !code) return htmlError(oauthError || "Cloudflare did not return an authorization code.", 400);

  const tokenResponse = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.BROLLY_OAUTH_CLIENT_ID!,
      code,
      redirect_uri: row.redirect_uri,
      code_verifier: row.verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResponse.ok) return htmlError(`Cloudflare token exchange failed (${tokenResponse.status}).`, 502);
  const oauth = await tokenResponse.json() as OAuthTokenResponse;
  const [user, accounts] = await Promise.all([
    fetchJson<UserInfo>(USERINFO_ENDPOINT, oauth.access_token),
    cloudflare<Array<CloudflareAccount>>(oauth.access_token, "/accounts"),
  ]);
  if (!user.sub) return htmlError("Cloudflare did not return a stable user identity.", 502);
  if (accounts.length !== 1) {
    return htmlError(accounts.length === 0
      ? "No Cloudflare account was authorized. Start again and choose the account Brolly should protect."
      : "Brolly requires one account per installation. Start again and authorize exactly one Cloudflare account.", 409);
  }
  const account = accounts[0]!;
  const configured = await configuredAccountId(env);
  if (configured && configured !== account.id) return htmlError(`This Brolly instance protects a different Cloudflare account.`, 403);
  const now = Date.now();
  const credentials = await sealJson({
    accessToken: oauth.access_token,
    refreshToken: oauth.refresh_token,
    expiresAt: oauth.expires_in ? now + oauth.expires_in * 1000 : undefined,
  }, env.BROLLY_CREDENTIAL_KEY);
  const sessionToken = randomToken(32);
  const sessionHash = await sha256(sessionToken);
  await env.DB.prepare(`INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('account_id',?1,?2)`).bind(account.id, now).run();
  const claimedAccount = await configuredAccountId(env);
  if (claimedAccount !== account.id) return htmlError("Another administrator connected this Brolly instance to a different account while you were signing in.", 409);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('account_name',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(account.name, now),
    env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('oauth_credentials',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(credentials, now),
    env.DB.prepare(`INSERT INTO auth_sessions(token_hash,user_id,email,display_name,account_id,created_at,last_seen_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?6,?7)`).bind(sessionHash, user.sub, user.email ?? null, user.name ?? user.preferred_username ?? null, account.id, now, now + SESSION_TTL_MS),
    env.DB.prepare(`DELETE FROM auth_sessions WHERE expires_at < ?1`).bind(now),
  ]);
  const headers = new Headers({ location: "/", "cache-control": "no-store" });
  headers.append("set-cookie", serializeCookie(SESSION_COOKIE, sessionToken, request, SESSION_TTL_MS));
  headers.append("set-cookie", serializeCookie(STATE_COOKIE, "", request, 0));
  return new Response(null, { status: 302, headers });
}

async function sessionStatus(request: Request, env: Env): Promise<Response> {
  const actor = await authenticate(request, env);
  const accountId = actor?.accountId ?? await configuredAccountId(env);
  const accountName = await env.DB.prepare(`SELECT value FROM settings WHERE key='account_name' LIMIT 1`).first<{ value: string }>();
  return Response.json({
    authenticated: Boolean(actor),
    oauthConfigured: oauthReady(env),
    credentialStorageReady: Boolean(env.BROLLY_CREDENTIAL_KEY),
    actor: actor ? { name: actor.actor, kind: actor.kind } : null,
    account: accountId ? { id: accountId, name: accountName?.value ?? accountId } : null,
  }, { headers: { "cache-control": "no-store" } });
}

async function logout(request: Request, env: Env): Promise<Response> {
  if (!safeMutationOrigin(request)) return Response.json({ error: "Invalid request origin" }, { status: 403, headers: { "cache-control": "no-store" } });
  const token = cookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare(`DELETE FROM auth_sessions WHERE token_hash=?1`).bind(await sha256(token)).run();
  return Response.json({ ok: true }, { headers: { "set-cookie": serializeCookie(SESSION_COOKIE, "", request, 0), "cache-control": "no-store" } });
}

function oauthReady(env: Env): boolean {
  return Boolean(env.BROLLY_OAUTH_CLIENT_ID && !env.BROLLY_OAUTH_CLIENT_ID.startsWith("REPLACE_") && env.BROLLY_OAUTH_REDIRECT_URI);
}

function oauthConfigurationError(env: Env): Response {
  return Response.json({
    error: "Cloudflare OAuth is not configured for this Brolly release.",
    detail: !env.BROLLY_OAUTH_CLIENT_ID || env.BROLLY_OAUTH_CLIENT_ID.startsWith("REPLACE_")
      ? "The Brolly publisher must set the shared public BROLLY_OAUTH_CLIENT_ID. Installers should never create their own OAuth application."
      : "BROLLY_OAUTH_REDIRECT_URI is missing.",
  }, { status: 503, headers: { "cache-control": "no-store" } });
}

function safeMutationOrigin(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const origin = request.headers.get("origin");
  return origin === new URL(request.url).origin;
}

function decodeStateOrigin(state: string): string | null {
  const encoded = state.split(".")[1];
  if (!encoded) return null;
  try {
    const origin = new URL(decodeText(encoded));
    if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return null;
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname))) return null;
    return origin.origin;
  } catch { return null; }
}

function cookie(request: Request, name: string): string | null {
  const value = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : null;
}

function serializeCookie(name: string, value: string, request: Request, ttlMs: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(ttlMs / 1000))}${secure}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) result |= a[index]! ^ b[index]!;
  return result === 0;
}

async function sha256(value: string): Promise<string> {
  return encodeBytes(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function randomToken(bytes: number): string { return encodeBytes(crypto.getRandomValues(new Uint8Array(bytes))); }
function encodeText(value: string): string { return encodeBytes(new TextEncoder().encode(value)); }
function decodeText(value: string): string {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
}
function encodeBytes(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Cloudflare identity request failed (${response.status})`);
  return response.json<T>();
}

async function cloudflare<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  const payload = await response.json() as ApiEnvelope<T>;
  if (!response.ok || !payload.success) throw new Error(payload.errors?.map(error => error.message).join("; ") ?? `Cloudflare returned ${response.status}`);
  return payload.result;
}

function htmlError(message: string, status: number): Response {
  const escaped = message.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Brolly sign-in</title><style>body{font:16px system-ui;background:#f7f7f8;color:#202124;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:36rem;background:white;border:1px solid #ddd;border-radius:16px;padding:2rem}a{color:#c04b00}</style><div class="card"><h1>Cloudflare sign-in could not finish</h1><p>${escaped}</p><p><a href="/">Return to Brolly</a></p></div>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
