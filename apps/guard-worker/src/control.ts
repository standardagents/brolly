import type { ControlAction } from "@standardagents/brolly-core";
import { BROLLY_FUSE_BINDING, BROLLY_FUSE_VERSION, type BrollyFuseManifest, type BrollyQuarantine } from "@standardagents/brolly-runtime";
import type { Env } from "./env.js";
import { operationalToken } from "./credentials.js";

const FUSE_SETTING_PREFIX = "deployment_fuse:";
const MAX_FUSE_BYTES = 5_000;
const AUTOMATIC_WORKER_COOLDOWN_MS = 5 * 60_000;
const AUTOMATIC_ACCOUNT_WINDOW_MS = 60 * 60_000;
const MAX_AUTOMATIC_DEPLOYMENTS_PER_HOUR = 12;

export class AutomaticDeploymentLimitError extends Error {}

/**
 * Apply or clear a deployment-carried fuse. The only external operation is the
 * one-time Cloudflare control-plane secret update; instrumented runtimes never
 * call Brolly or any storage service while enforcing it.
 */
export async function executeDeploymentFuseControl(
  env: Env,
  action: ControlAction,
  workerScript: string,
  requestedAction: "quarantine" | "resume" = "quarantine",
  automatic = false,
): Promise<{ workerScript: string; manifest: BrollyFuseManifest }> {
  return executeDeploymentFuseBatch(env, [action], workerScript, requestedAction, automatic);
}

export async function executeDeploymentFuseBatch(
  env: Env,
  actions: ControlAction[],
  workerScript: string,
  requestedAction: "quarantine" | "resume" = "quarantine",
  automatic = false,
): Promise<{ workerScript: string; manifest: BrollyFuseManifest }> {
  if (!actions.length) throw new Error("At least one fuse action is required");
  if (!/^[A-Za-z0-9_-]+$/.test(workerScript)) throw new Error("Owning Worker script name is invalid");
  await assertSafeDeploymentTarget(env, actions, workerScript, automatic);
  const holder = crypto.randomUUID();
  if (!await acquireControlLease(env.DB, `fuse:${workerScript}`, holder, 30_000)) {
    throw new AutomaticDeploymentLimitError(`Another fuse update for ${workerScript} is already in progress`);
  }
  try {
    if (automatic) await assertAutomaticDeploymentCapacity(env.DB, workerScript);

    const key = `${FUSE_SETTING_PREFIX}${workerScript}`;
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key=?1 LIMIT 1`).bind(key).first<{ value: string }>();
    const current = parseStoredFuse(row?.value);
    const manifest: BrollyFuseManifest = {
      version: BROLLY_FUSE_VERSION,
      generation: current.generation + 1,
      ...(current.worker ? { worker: current.worker } : {}),
      ...(current.objects && Object.keys(current.objects).length ? { objects: { ...current.objects } } : {}),
    };

    for (const action of actions) applyFuseAction(manifest, action, requestedAction);

    const encoded = JSON.stringify(manifest);
    if (new TextEncoder().encode(encoded).byteLength > MAX_FUSE_BYTES) {
      throw new Error("BROLLY_FUSE would exceed Cloudflare's 5 KB binding limit; quarantine the Worker or clear inactive object quarantines first");
    }

    // Desired state is durable before the external mutation. If Cloudflare
    // times out after accepting the deployment, a retry replays this same
    // generation instead of rebuilding from stale state and losing entries.
    await env.DB.prepare(
      `INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    ).bind(key, encoded, Date.now()).run();
    const token = await operationalToken(env);
    await cf(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(workerScript)}/secrets`, {
      method: "PUT",
      body: JSON.stringify({ name: BROLLY_FUSE_BINDING, text: encoded, type: "secret_text" }),
    });
    await env.DB.prepare(
      `INSERT INTO control_deployments(id,worker_script,generation,action_count,automatic,created_at) VALUES(?1,?2,?3,?4,?5,?6)`,
    ).bind(crypto.randomUUID(), workerScript, manifest.generation, actions.length, automatic ? 1 : 0, Date.now()).run();
    return { workerScript, manifest };
  } finally {
    await releaseControlLease(env.DB, `fuse:${workerScript}`, holder);
  }
}

function applyFuseAction(manifest: BrollyFuseManifest, action: ControlAction, requestedAction: "quarantine" | "resume"): void {
  const quarantine: BrollyQuarantine = {
    actionId: action.id,
    incidentId: action.incidentId,
    reason: action.reason.slice(0, 500),
    appliedAt: Date.now(),
  };

  if (action.asset.family === "workers") {
    if (requestedAction === "quarantine") manifest.worker = quarantine;
    else if (manifest.worker?.actionId === action.id) delete manifest.worker;
    else if (manifest.worker) throw new Error(`Worker quarantine belongs to newer action ${manifest.worker.actionId}; refusing to clear it with ${action.id}`);
  } else {
    manifest.objects ??= {};
    if (requestedAction === "quarantine") manifest.objects[action.asset.id] = quarantine;
    else if (manifest.objects[action.asset.id]?.actionId === action.id) delete manifest.objects[action.asset.id];
    else if (manifest.objects[action.asset.id]) throw new Error(`Object quarantine belongs to newer action ${manifest.objects[action.asset.id]!.actionId}; refusing to clear it with ${action.id}`);
    if (Object.keys(manifest.objects).length === 0) delete manifest.objects;
  }

}

function parseStoredFuse(value?: string): BrollyFuseManifest {
  if (!value) return { version: BROLLY_FUSE_VERSION, generation: 0 };
  try {
    const parsed = JSON.parse(value) as BrollyFuseManifest;
    if (parsed.version === BROLLY_FUSE_VERSION && Number.isSafeInteger(parsed.generation) && parsed.generation >= 0) return parsed;
  } catch { /* surfaced below */ }
  throw new Error("Stored BROLLY_FUSE state is corrupt; refusing to replace live quarantine state");
}

async function assertSafeDeploymentTarget(env: Env, actions: ControlAction[], workerScript: string, automatic: boolean): Promise<void> {
  if (workerScript === (env.BROLLY_SELF_WORKER_NAME ?? "brolly-guard") || workerScript === "brolly-guard" || workerScript.startsWith("brolly-guard-")) {
    throw new Error("Brolly's control-plane Worker cannot be quarantined");
  }
  const worker = await env.DB.prepare(
    `SELECT tier,metadata_json FROM assets WHERE account_id=?1 AND family='workers' AND asset_id=?2 AND scope='resource' LIMIT 1`,
  ).bind(env.BROLLY_ACCOUNT_ID, workerScript).first<{ tier: string; metadata_json: string }>();
  if (!worker) throw new Error(`Worker ${workerScript} is not in the current Cloudflare inventory`);
  if (["control_plane", "critical", "unclassified"].includes(worker.tier)) throw new Error(`Worker ${workerScript} is protected as ${worker.tier}`);
  for (const action of actions) {
    if (action.asset.accountId !== env.BROLLY_ACCOUNT_ID) throw new Error("Action account does not match this Brolly installation");
    if (["control_plane", "critical", "unclassified"].includes(action.asset.tier)) throw new Error(`Asset tier ${action.asset.tier} cannot be stopped`);
    if (action.asset.tags?.brollyFuse !== "true") throw new Error("The current inventory no longer marks this target as deployment-fuse integrated");
    if (action.asset.family !== "workers" && (action.asset.family !== "durable_objects" || action.asset.scope !== "object")) {
      throw new Error("Deployment fuses support Worker scripts and exact Durable Object IDs only");
    }
    if (action.asset.family === "workers" && action.asset.id !== workerScript) throw new Error("Worker action target does not match the inventoried Worker");
    if (action.asset.family === "durable_objects") {
      if (!/^[a-f0-9]{64}$/i.test(action.asset.id)) throw new Error("Exact Durable Object quarantine requires a 64-character object ID");
      if (action.asset.tags?.cloudflareWorkerScript !== workerScript) throw new Error("Durable Object ownership does not match Cloudflare inventory");
    }
  }
  if (automatic) {
    const verification = await env.DB.prepare(`SELECT value,updated_at FROM settings WHERE key=?1 LIMIT 1`)
      .bind(`configuration_verification:${workerScript}`).first<{ value: string; updated_at: number }>();
    if (!verification || verification.updated_at < Date.now() - 24 * 60 * 60_000) throw new Error(`Automatic quarantine requires a successful verification of ${workerScript} within the last 24 hours`);
    let checks: Record<string, { state?: string }>;
    try { checks = (JSON.parse(verification.value) as { checks: Record<string, { state?: string }> }).checks; }
    catch { throw new Error(`Automatic quarantine verification for ${workerScript} is corrupt`); }
    if (!["apiAccess", "fuseSecret", "runtimeBundle", "activeDeployment"].every(key => checks[key]?.state === "pass")) {
      throw new Error(`Automatic quarantine is disabled because ${workerScript} is not fully verified`);
    }
  }
}

async function assertAutomaticDeploymentCapacity(db: D1Database, workerScript: string): Promise<void> {
  const now = Date.now();
  const [worker, account] = await Promise.all([
    db.prepare(`SELECT created_at FROM control_deployments WHERE worker_script=?1 AND automatic=1 ORDER BY created_at DESC LIMIT 1`).bind(workerScript).first<{ created_at: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM control_deployments WHERE automatic=1 AND created_at>=?1`).bind(now - AUTOMATIC_ACCOUNT_WINDOW_MS).first<{ count: number }>(),
  ]);
  if (worker && worker.created_at > now - AUTOMATIC_WORKER_COOLDOWN_MS) throw new AutomaticDeploymentLimitError(`Automatic deployment cooldown is active for ${workerScript}`);
  if (Number(account?.count ?? 0) >= MAX_AUTOMATIC_DEPLOYMENTS_PER_HOUR) throw new AutomaticDeploymentLimitError("Brolly's automatic deployment circuit breaker is open for one hour");
}

async function acquireControlLease(db: D1Database, name: string, holder: string, ttlMs: number): Promise<boolean> {
  const now = Date.now();
  const result = await db.prepare(
    `INSERT INTO cron_lease(name,holder,expires_at) VALUES(?1,?2,?3)
     ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at
     WHERE cron_lease.expires_at<?4 OR cron_lease.holder=?2`,
  ).bind(name, holder, now + ttlMs, now).run();
  return Number(result.meta.changes ?? 0) > 0;
}

async function releaseControlLease(db: D1Database, name: string, holder: string): Promise<void> {
  await db.prepare(`DELETE FROM cron_lease WHERE name=?1 AND holder=?2`).bind(name, holder).run();
}

export async function executeRuntimeControl(
  env: Env,
  action: ControlAction,
  runtimeUrl: string,
  requestedAction: "quarantine" | "resume" = "quarantine",
  releaseForensicHold = false,
): Promise<Response> {
  if (!env.BROLLY_CONTROL_PRIVATE_KEY_JWK) throw new Error("BROLLY_CONTROL_PRIVATE_KEY_JWK is not configured");
  if (action.asset.tier === "control_plane") throw new Error("Control-plane assets cannot be stopped");
  const endpoint = new URL(runtimeUrl);
  if (endpoint.protocol !== "https:") throw new Error("Runtime controls require an HTTPS endpoint");
  const now = Date.now();
  const payload = {
    kind: "brolly_runtime_control",
    version: 1,
    account_id: action.asset.accountId,
    project_id: action.asset.tags?.projectId ?? action.asset.parentId ?? "",
    object_id: action.asset.id,
    action_id: action.id,
    action: requestedAction,
    reason: action.reason,
    forensic_hold: false,
    release_forensic_hold: releaseForensicHold,
    observed: action.observed,
    issued_at: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 60,
  };
  const compact = await signPayload(payload, env.BROLLY_CONTROL_PRIVATE_KEY_JWK);
  return fetch(new URL("/api/auth/brolly-control", endpoint), {
    method: "POST",
    headers: { authorization: `Brolly ${compact}`, "content-type": "application/json", "idempotency-key": action.id },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
}

async function signPayload(payload: unknown, privateJwkJson: string): Promise<string> {
  const header = { alg: "ES256", typ: "JWT" };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("jwk", JSON.parse(privateJwkJson) as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
  return `${encodedHeader}.${encodedPayload}.${base64url(signature)}`;
}

function base64url(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

interface ApiEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ message: string }>;
  result_info?: { page?: number; total_pages?: number };
}

/** Capture the exact rollback state before any account-level mutation is attempted. */
export async function prepareCloudflareControl(env: Env, action: ControlAction): Promise<Record<string, unknown>> {
  const token = await operationalToken(env);
  if (action.kind === "pause_consumer") {
    const queue = await cf<Record<string, unknown>>(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/queues/${encodeURIComponent(action.asset.id)}`);
    const settings = (queue.settings && typeof queue.settings === "object" ? queue.settings : {}) as Record<string, unknown>;
    return { kind: "pause_consumer", settings };
  }
  if (action.kind === "disable_trigger") {
    const script = encodeURIComponent(action.asset.id);
    const schedules = await cf<{ schedules: Array<{ cron: string }> }>(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/scripts/${script}/schedules`);
    const subdomain = await cf<{ enabled: boolean; previews_enabled: boolean }>(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/scripts/${script}/subdomain`);
    const zoneEnvelope = await cfEnvelope<Array<{ id: string }>>(token, `/zones?account.id=${encodeURIComponent(env.BROLLY_ACCOUNT_ID)}&per_page=50`);
    if ((zoneEnvelope.result_info?.total_pages ?? 1) > 1) throw new Error("Worker control refused: more than 50 zones would make the rollback snapshot incomplete");
    const zones = zoneEnvelope.result;
    const routes: Array<{ zoneId: string; id: string; pattern: string }> = [];
    for (const zone of zones.slice(0, 50)) {
      const routeEnvelope = await cfEnvelope<Array<{ id: string; pattern: string; script?: string }>>(token, `/zones/${zone.id}/workers/routes`);
      if ((routeEnvelope.result_info?.total_pages ?? 1) > 1) throw new Error(`Worker control refused: route snapshot for zone ${zone.id} is incomplete`);
      const listed = routeEnvelope.result;
      for (const route of listed.filter(item => item.script === action.asset.id).slice(0, 100)) routes.push({ zoneId: zone.id, id: route.id, pattern: route.pattern });
    }
    const domainEnvelope = await cfEnvelope<Array<{ id: string; hostname: string; service: string; zone_id?: string; zone_name?: string }>>(
      token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/domains?service=${encodeURIComponent(action.asset.id)}&per_page=100`,
    );
    if ((domainEnvelope.result_info?.total_pages ?? 1) > 1) throw new Error("Worker control refused: more than 100 custom domains would make the rollback snapshot incomplete");
    return { kind: "disable_trigger", schedules: schedules.schedules, subdomain, routes, domains: domainEnvelope.result };
  }
  throw new Error(`Unsupported Cloudflare control: ${action.kind}`);
}

/** Execute only after prepareCloudflareControl's snapshot is durably stored. */
export async function executeCloudflareControl(env: Env, action: ControlAction): Promise<void> {
  const token = await operationalToken(env);
  if (action.kind === "pause_consumer") {
    const settings = (action.rollback.settings ?? {}) as Record<string, unknown>;
    await cf(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/queues/${encodeURIComponent(action.asset.id)}`, {
      method: "PATCH", body: JSON.stringify({ settings: { ...settings, delivery_paused: true } }),
    });
    return;
  }
  if (action.kind === "disable_trigger") {
    throw new Error("Route-deleting Worker shutdown is retired; install @standardagents/brolly-runtime for reversible Worker quarantine");
  }
  throw new Error(`Unsupported Cloudflare control: ${action.kind}`);
}

export async function rollbackCloudflareControl(env: Env, action: ControlAction): Promise<void> {
  const token = await operationalToken(env);
  if (action.kind === "pause_consumer") {
    await cf(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/queues/${encodeURIComponent(action.asset.id)}`, { method: "PATCH", body: JSON.stringify({ settings: action.rollback.settings ?? {} }) });
    return;
  }
  if (action.kind === "disable_trigger") {
    const script = encodeURIComponent(action.asset.id);
    const schedules = ((action.rollback.schedules as Array<{ cron: string }> | undefined) ?? []).map(schedule => ({ cron: schedule.cron }));
    await cf(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/scripts/${script}/schedules`, { method: "PUT", body: JSON.stringify(schedules) });
    const subdomain = action.rollback.subdomain as { enabled?: boolean; previews_enabled?: boolean } | undefined;
    if (subdomain?.enabled || subdomain?.previews_enabled) await cf(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/scripts/${script}/subdomain`, { method: "POST", body: JSON.stringify(subdomain) });
    for (const route of (action.rollback.routes as Array<{ zoneId: string; pattern: string }> | undefined) ?? []) {
      await cf(env, token, `/zones/${route.zoneId}/workers/routes`, { method: "POST", body: JSON.stringify({ pattern: route.pattern, script: action.asset.id }) });
    }
    for (const domain of (action.rollback.domains as Array<{ hostname: string; service: string; zone_id?: string; zone_name?: string }> | undefined) ?? []) {
      await cf(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/domains`, {
        method: "PUT",
        body: JSON.stringify({ hostname: domain.hostname, service: domain.service, ...(domain.zone_id ? { zone_id: domain.zone_id } : {}), ...(domain.zone_name ? { zone_name: domain.zone_name } : {}) }),
      });
    }
  }
}

async function cf<T = unknown>(env: Env, token: string, path: string, init: RequestInit = {}): Promise<T> {
  void env;
  return (await cfEnvelope<T>(token, path, init)).result;
}

async function cfEnvelope<T = unknown>(token: string, path: string, init: RequestInit = {}): Promise<ApiEnvelope<T>> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  if (!response.ok) throw new Error(`Cloudflare control failed (${response.status}): ${await response.text()}`);
  const payload = await response.json() as ApiEnvelope<T>;
  if (!payload.success) throw new Error(payload.errors?.map(error => error.message).join("; ") ?? "Cloudflare control failed");
  return payload;
}
