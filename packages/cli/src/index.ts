#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { authorizeCloudflare } from "./oauth.js";
import { loadConfig, saveConfig } from "./config.js";
import { deployGuard } from "./install.js";

const BROLLY_PUBLIC_OAUTH_CLIENT_ID = "5690968d2377c6200202668946420dec";

const command = process.argv[2] ?? "help";

try {
  if (command === "install") await install();
  else if (command === "status") console.log(JSON.stringify(await guardRequest("/api/status"), null, 2));
  else if (command === "incidents") console.log(JSON.stringify(await guardRequest("/api/incidents"), null, 2));
  else if (command === "run") console.log(JSON.stringify(await guardRequest("/api/run", { method: "POST" }), null, 2));
  else if (command === "prepare") await prepareOrStop(false);
  else if (command === "stop") await prepareOrStop(true);
  else if (command === "resume") await resumeAction();
  else if (command === "classify") await classifyAsset();
  else if (command === "mode") await setMode();
  else if (command === "target") await addTarget();
  else if (command === "open") await openUrl((await loadConfig()).guardUrl);
  else help();
} catch (error) {
  console.error(`brolly: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function install(): Promise<void> {
  const clientId = process.env.BROLLY_OAUTH_CLIENT_ID ?? BROLLY_PUBLIC_OAUTH_CLIENT_ID;
  console.log("Opening Cloudflare to authorize Brolly. Brolly will ask you to choose exactly one account.");
  const scopes = (process.env.BROLLY_OAUTH_SCOPES ?? [
    "openid", "offline_access", "user-details.read", "memberships.read", "account-settings.read", "account-analytics.read",
    "workers-scripts.read", "workers-scripts.write", "workers-kv-storage.metadata_read", "workers-r2.metadata_read",
    "d1.metadata_read", "d1.write", "queues.metadata_read", "queues.write", "vectorize.read", "query-cache.read",
    "pages.metadata_read", "aig.metadata_read", "zone.read",
  ].join(" ")).trim().split(/\s+/);
  const oauth = await authorizeCloudflare(clientId, scopes, openUrl);
  const accounts = await cloudflare<Array<{ id: string; name: string }>>(oauth.accessToken, "/accounts");
  if (accounts.length !== 1 && !process.env.BROLLY_ACCOUNT_ID) {
    console.log(accounts.map(account => `${account.id}\t${account.name}`).join("\n"));
    throw new Error("Set BROLLY_ACCOUNT_ID to one account ID and rerun install");
  }
  const accountId = process.env.BROLLY_ACCOUNT_ID ?? accounts[0]?.id;
  if (!accountId || !accounts.some(account => account.id === accountId)) throw new Error("Selected account is not authorized");
  const databases = await cloudflare<Array<{ uuid: string; name: string }>>(oauth.accessToken, `/accounts/${accountId}/d1/database`);
  const database = databases.find(item => item.name === "brolly-guard") ?? await cloudflare<{ uuid: string; name: string }>(oauth.accessToken, `/accounts/${accountId}/d1/database`, {
    method: "POST", body: JSON.stringify({ name: "brolly-guard" }),
  });
  const adminToken = randomBytes(32).toString("base64url");
  console.log(`Created D1 database ${database.name} (${database.uuid}).`);
  const deployed = await deployGuard({
    accountId, accountName: accounts.find(account => account.id === accountId)!.name, clientId, oauth, databaseId: database.uuid, adminToken,
    billingToken: process.env.BROLLY_BILLING_TOKEN,
    timezone: process.env.BROLLY_TIMEZONE,
    summaryHour: process.env.BROLLY_DAILY_SUMMARY_HOUR,
  });
  const guardUrl = process.env.BROLLY_GUARD_URL ?? deployed.guardUrl;
  await saveConfig({ guardUrl, accountId, adminToken, installedAt: Date.now() });
  console.log(`Brolly is deployed at ${guardUrl}`);
  console.log(`Legacy signed-control public key (only for runtimes using the pre-fuse endpoint):\n${JSON.stringify(deployed.publicControlJwk)}`);
  console.log(`\nTo make any Worker or Durable Object stoppable:\n  pnpm add @standardagents/brolly-runtime\n  printf '%s' '{"version":1,"generation":0,"objects":{}}' | pnpm wrangler secret put BROLLY_FUSE\nThen add brollyWorker(env) at Worker ingress and brollyDurableObject(ctx, env) immediately after super(ctx, env) in each Durable Object constructor.`);
  if (!process.env.BROLLY_BILLING_TOKEN) {
    console.log("Authoritative invoice reconciliation is not enabled. Create a Billing Read token from Cloudflare's account-owned token template and rerun with BROLLY_BILLING_TOKEN set.");
  }
}

async function guardRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  const config = await loadConfig();
  const response = await fetch(new URL(path, config.guardUrl), { ...init, headers: { ...init.headers, authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" } });
  if (!response.ok) throw new Error(`Guard returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function prepareOrStop(execute: boolean): Promise<void> {
  const incidentId = process.argv[3];
  if (!incidentId) throw new Error(`Usage: brolly ${execute ? "stop" : "prepare"} <incident-id>`);
  const body = { incidentId, execute };
  console.log(JSON.stringify(await guardRequest("/api/actions", { method: "POST", body: JSON.stringify(body) }), null, 2));
}

async function resumeAction(): Promise<void> {
  const id = process.argv[3];
  if (!id) throw new Error("Usage: brolly resume <action-id>");
  const body = {};
  console.log(JSON.stringify(await guardRequest(`/api/actions/${encodeURIComponent(id)}/resume`, { method: "POST", body: JSON.stringify(body) }), null, 2));
}

async function classifyAsset(): Promise<void> {
  const [family, id, tier] = process.argv.slice(3, 6);
  if (!family || !id || !tier) throw new Error("Usage: brolly classify <family> <asset-id> <control_plane|critical|standard|disposable>");
  console.log(JSON.stringify(await guardRequest(`/api/assets/${encodeURIComponent(family)}/${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify({ tier }),
  }), null, 2));
}

async function setMode(): Promise<void> {
  const mode = process.argv[3];
  if (!mode || !["observe", "approval", "automatic"].includes(mode)) throw new Error("Usage: brolly mode <observe|approval|automatic>");
  const policy = await guardRequest("/api/policy") as Record<string, unknown>;
  console.log(JSON.stringify(await guardRequest("/api/policy", { method: "PUT", body: JSON.stringify({ ...policy, mode }) }), null, 2));
}

async function addTarget(): Promise<void> {
  const [kind, configFile, minimumSeverity = "warning"] = process.argv.slice(3, 6);
  if (!kind || !configFile) throw new Error("Usage: brolly target <discord|slack|resend|postmark|twilio> <config-json-file> [minimum-severity]");
  const config = JSON.parse(await readFile(configFile, "utf8")) as Record<string, unknown>;
  console.log(JSON.stringify(await guardRequest("/api/targets", { method: "POST", body: JSON.stringify({ kind, config, minimumSeverity }) }), null, 2));
}

async function cloudflare<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const payload = await response.json() as { success: boolean; result: T; errors?: Array<{ message: string }> };
  if (!response.ok || !payload.success) throw new Error(payload.errors?.map(error => error.message).join("; ") ?? `Cloudflare returned ${response.status}`);
  return payload.result;
}

async function openUrl(url: string): Promise<void> {
  const executable = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await promisify(execFile)(executable, args);
}

function help(): void {
  console.log(`Brolly — Cloudflare cost sentinel

Usage:
  brolly install      Connect and prepare a one-account installation
  brolly status       Show sentinel status and current incidents
  brolly incidents    List incidents
  brolly run          Request one bounded monitoring pass
  brolly classify     Assign a safety tier and optional owning Worker script
  brolly prepare      Prepare a reversible action from an incident
  brolly stop         Prepare and execute a reversible action from an incident
  brolly resume       Roll back an action (forensic holds require explicit release)
  brolly mode         Select observe, approval, or automatic policy mode
  brolly target       Add an encrypted notification target from a JSON file
  brolly open         Open the guard dashboard`);
}
