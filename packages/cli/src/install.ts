import { createCipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { OAuthResult } from "./oauth.js";

export interface InstallResult { guardUrl: string; publicControlJwk: JsonWebKey }

export async function deployGuard(input: {
  accountId: string; clientId: string; oauth: OAuthResult; databaseId: string; adminToken: string;
  billingToken?: string; timezone?: string; summaryHour?: string;
}): Promise<InstallResult> {
  const packaged = resolve(dirname(fileURLToPath(import.meta.url)), "../worker");
  const sourceFallback = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/guard-worker");
  const workerPath = await firstReadable([join(packaged, "index.js"), join(sourceFallback, "dist/brolly_guard/index.js")]);
  const assetsPath = await firstReadableDirectory([join(packaged, "client"), join(sourceFallback, "dist/client")]);
  const migrationPath = await firstReadable([join(packaged, "0001_initial.sql"), join(sourceFallback, "migrations/0001_initial.sql")]);
  const migration = await readFile(migrationPath, "utf8");
  for (const statement of migration.split(/;\s*(?:\n|$)/).map(value => value.trim()).filter(Boolean)) {
    await d1Query(input.oauth.accessToken, input.accountId, input.databaseId, statement);
  }

  const credentialKey = randomBytes(32);
  const credentialEnvelope = encryptCredentials({
    accessToken: input.oauth.accessToken, refreshToken: input.oauth.refreshToken,
    expiresAt: input.oauth.expiresIn ? Date.now() + input.oauth.expiresIn * 1000 : undefined,
  }, credentialKey);
  await d1Query(input.oauth.accessToken, input.accountId, input.databaseId,
    `INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`,
    ["oauth_credentials", credentialEnvelope, Date.now()]);

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privateControlJwk = privateKey.export({ format: "jwk" });
  const publicControlJwk = publicKey.export({ format: "jwk" });
  const scratch = join(tmpdir(), `brolly-install-${randomBytes(8).toString("hex")}`);
  const configPath = join(scratch, "wrangler.json");
  await import("node:fs/promises").then(fs => fs.mkdir(scratch, { recursive: true, mode: 0o700 }));
  const config = {
    name: "brolly-guard", main: workerPath, compatibility_date: "2026-08-08", account_id: input.accountId,
    triggers: { crons: ["* * * * *"] },
    assets: { directory: assetsPath, not_found_handling: "single-page-application", run_worker_first: ["/api/*", "/health"] },
    d1_databases: [{ binding: "DB", database_name: "brolly-guard", database_id: input.databaseId }],
    vars: { BROLLY_ACCOUNT_ID: input.accountId, BROLLY_TIMEZONE: input.timezone ?? "UTC", BROLLY_DAILY_SUMMARY_HOUR: input.summaryHour ?? "9", BROLLY_OAUTH_CLIENT_ID: input.clientId },
    observability: { enabled: true },
  };
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    const output = await runWrangler(["deploy", "--config", configPath], input.oauth.accessToken);
    const secrets: Record<string, string> = {
      CLOUDFLARE_OAUTH_TOKEN: input.oauth.accessToken,
      BROLLY_ADMIN_TOKEN: input.adminToken,
      BROLLY_CREDENTIAL_KEY: credentialKey.toString("base64url"),
      BROLLY_CONTROL_PRIVATE_KEY_JWK: JSON.stringify(privateControlJwk),
    };
    if (input.billingToken) secrets.CLOUDFLARE_BILLING_TOKEN = input.billingToken;
    await runWrangler(["secret", "bulk", "--config", configPath], input.oauth.accessToken, JSON.stringify(secrets));
    const guardUrl = output.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0] ?? `https://brolly-guard.workers.dev`;
    return { guardUrl, publicControlJwk };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function encryptCredentials(value: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ iv: iv.toString("base64url"), ciphertext: Buffer.concat([ciphertext, tag]).toString("base64url") });
}

async function d1Query(token: string, accountId: string, databaseId: string, sql: string, params: unknown[] = []): Promise<void> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ sql, params }),
  });
  const payload = await response.json() as { success: boolean; errors?: Array<{ message: string }> };
  if (!response.ok || !payload.success) throw new Error(payload.errors?.map(error => error.message).join("; ") ?? `D1 query failed (${response.status})`);
}

async function runWrangler(args: string[], token: string, stdin?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("pnpm", ["dlx", "wrangler", ...args], { env: { ...process.env, CLOUDFLARE_API_TOKEN: token }, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; let error = "";
    child.stdout.on("data", chunk => { output += String(chunk); process.stdout.write(chunk); });
    child.stderr.on("data", chunk => { error += String(chunk); process.stderr.write(chunk); });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolvePromise(output) : reject(new Error(`Wrangler failed (${code}): ${error.slice(-2000)}`)));
    child.stdin.end(stdin);
  });
}

async function firstReadable(paths: string[]): Promise<string> {
  for (const path of paths) { try { await readFile(path); return path; } catch { /* try next */ } }
  throw new Error("Packaged Brolly guard bundle is missing; run pnpm build before installing from source");
}

async function firstReadableDirectory(paths: string[]): Promise<string> {
  for (const path of paths) { try { if ((await stat(path)).isDirectory()) return path; } catch { /* try next */ } }
  throw new Error("Packaged Brolly dashboard assets are missing; run pnpm build before installing from source");
}
