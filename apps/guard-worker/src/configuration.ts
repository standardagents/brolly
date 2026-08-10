import type { Env } from "./env.js";
import { operationalToken } from "./credentials.js";

const API = "https://api.cloudflare.com/client/v4";
const VERIFICATION_PREFIX = "configuration_verification:";
const MAX_WORKERS_PER_REFRESH = 5;
const MAX_BUNDLE_SCAN_BYTES = 1_000_000;
const RUNTIME_MARKER = "BROLLY_QUARANTINED";

type CheckState = "pass" | "fail" | "unknown" | "error";
type OverallState = "configured" | "partial" | "not_configured" | "error";

interface VerificationCheck {
  state: CheckState;
  label: string;
  detail: string;
}

interface WorkerVerification {
  workerScript: string;
  checkedAt: number;
  deploymentId?: string;
  versionId?: string;
  checks: {
    apiAccess: VerificationCheck;
    fuseSecret: VerificationCheck;
    runtimeBundle: VerificationCheck;
    activeDeployment: VerificationCheck;
  };
}

interface AssetRow {
  family: "workers" | "durable_objects";
  asset_id: string;
  name: string | null;
  scope: "resource" | "namespace";
  tier: string;
  metadata_json: string;
  seen_at: number;
}

interface ApiEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message: string }>;
}

export async function configurationData(env: Env): Promise<Record<string, unknown>> {
  const [assetResult, verificationResult] = await Promise.all([
    env.DB.prepare(
      `SELECT family,asset_id,name,scope,tier,metadata_json,seen_at FROM assets
       WHERE (family='workers' AND scope='resource') OR (family='durable_objects' AND scope='namespace')
       ORDER BY family,name,asset_id LIMIT 2500`,
    ).all<AssetRow>(),
    env.DB.prepare(`SELECT key,value FROM settings WHERE key LIKE 'configuration_verification:%' LIMIT 2500`).all<{ key: string; value: string }>(),
  ]);
  const verifications = new Map<string, WorkerVerification>();
  for (const row of verificationResult.results) {
    try { verifications.set(row.key.slice(VERIFICATION_PREFIX.length), JSON.parse(row.value) as WorkerVerification); } catch { /* ignored corrupt cached evidence */ }
  }

  const workerRows = assetResult.results.filter(row => row.family === "workers");
  const namespaceRows = assetResult.results.filter(row => row.family === "durable_objects");
  const namespacesByWorker = new Map<string, AssetRow[]>();
  for (const namespace of namespaceRows) {
    const tags = parseTags(namespace.metadata_json);
    const owner = tags.cloudflareWorkerScript;
    if (owner) namespacesByWorker.set(owner, [...(namespacesByWorker.get(owner) ?? []), namespace]);
  }

  const workers = workerRows.map(row => {
    const tags = parseTags(row.metadata_json);
    const verification = verifications.get(row.asset_id);
    const declaredInstalled = tags.brollyFuse === "true";
    const mappedNamespaces = namespacesByWorker.get(row.asset_id) ?? [];
    const checks = {
      inventory: pass("Discovered", "Worker script is present in the latest Brolly inventory."),
      declared: declaredInstalled
        ? pass("Guard confirmed", "An operator confirmed that brollyWorker(env) is placed before application work.")
        : unknown("Guard not confirmed", "Monitoring works, but precise Worker shutdown is not enabled until the ingress guard is confirmed."),
      apiAccess: verification?.checks.apiAccess ?? unknown("Not refreshed", "Refresh this Worker to test Cloudflare API access."),
      fuseSecret: verification?.checks.fuseSecret ?? unknown("Not refreshed", "Refresh this Worker to check for BROLLY_FUSE."),
      runtimeBundle: verification?.checks.runtimeBundle ?? unknown("Not refreshed", "Refresh this Worker to inspect the deployed bundle for the Brolly runtime marker."),
      activeDeployment: verification?.checks.activeDeployment ?? unknown("Not refreshed", "Refresh this Worker to identify the active deployment."),
    };
    return {
      id: row.asset_id, name: row.name ?? row.asset_id, tier: row.tier, tags, seenAt: row.seen_at,
      declaredInstalled, namespaceCount: mappedNamespaces.length, checkedAt: verification?.checkedAt ?? null,
      deploymentId: verification?.deploymentId ?? null, versionId: verification?.versionId ?? null,
      status: overallWorkerStatus(declaredInstalled, checks), checks,
    };
  });
  const workerMap = new Map(workers.map(worker => [worker.id, worker]));
  const namespaces = namespaceRows.map(row => {
    const tags = parseTags(row.metadata_json);
    const discoveredOwner = tags.cloudflareWorkerScript;
    const declaredOwner = undefined;
    const owner = discoveredOwner;
    const ownerWorker = owner ? workerMap.get(owner) : undefined;
    const ownerMismatch = false;
    const constructorConfirmed = tags.brollyFuse === "true";
    const checks = {
      inventory: pass("Discovered", "Durable Object namespace is present in Cloudflare inventory."),
      owner: ownerMismatch
        ? fail("Owner mismatch", "The stored owner does not match Cloudflare inventory.")
        : owner
          ? pass("Owner mapped", `Cloudflare associates this namespace with ${owner}.`)
          : unknown("Owner unknown", "Cloudflare did not return an owning Worker. Brolly will not accept a manual override."),
      constructor: constructorConfirmed
        ? pass("Constructor confirmed", "An operator confirmed brollyDurableObject(ctx, env) is installed for this namespace.")
        : unknown("Constructor not confirmed", "The namespace remains alert-only until the constructor guard is confirmed."),
      worker: ownerWorker?.status === "configured"
        ? pass("Owning Worker configured", `${owner} has live fuse and runtime evidence.`)
        : ownerWorker
          ? unknown("Owning Worker incomplete", `${owner} is ${ownerWorker.status.replaceAll("_", " ")}.`)
          : unknown("Worker not inventoried", owner ? `${owner} was not found in the Worker inventory.` : "Map an owning Worker first."),
    };
    const status: OverallState = ownerMismatch ? "error"
      : constructorConfirmed && ownerWorker?.status === "configured" ? "configured"
        : constructorConfirmed || Boolean(owner) || ownerWorker?.status === "partial" ? "partial" : "not_configured";
    return {
      id: row.asset_id, name: row.name ?? row.asset_id, tier: row.tier, tags, seenAt: row.seen_at,
      className: tags.durableObjectClass ?? null, storage: tags.durableObjectStorage ?? null,
      ownerWorker: owner ?? null, declaredOwner: declaredOwner ?? null, discoveredOwner: discoveredOwner ?? null,
      status, checks,
    };
  });

  const configuredWorkers = workers.filter(item => item.status === "configured").length;
  const configuredNamespaces = namespaces.filter(item => item.status === "configured").length;
  return {
    generatedAt: Date.now(), connected: !env.BROLLY_ACCOUNT_ID.startsWith("REPLACE_"),
    summary: {
      workers: workers.length, configuredWorkers,
      namespaces: namespaces.length, configuredNamespaces,
      partial: [...workers, ...namespaces].filter(item => item.status === "partial").length,
      needsAttention: [...workers, ...namespaces].filter(item => item.status === "error").length,
      lastVerifiedAt: workers.reduce<number | null>((latest, item) => item.checkedAt && (!latest || item.checkedAt > latest) ? item.checkedAt : latest, null),
    },
    workers, namespaces,
  };
}

export async function refreshConfiguration(env: Env, workerScripts: string[]): Promise<Record<string, unknown>> {
  const scripts = [...new Set(workerScripts.map(value => value.trim()).filter(Boolean))];
  if (!scripts.length) throw new Error("Choose at least one Worker to refresh");
  if (scripts.length > MAX_WORKERS_PER_REFRESH) throw new Error(`Refresh at most ${MAX_WORKERS_PER_REFRESH} Workers per request`);
  for (const script of scripts) if (!/^[A-Za-z0-9_-]+$/.test(script)) throw new Error(`Invalid Worker script name: ${script}`);
  const now = Date.now();
  const lease = await env.DB.prepare(
    `INSERT INTO cron_lease(name,holder,expires_at) VALUES('configuration-refresh',?1,?2)
     ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at
     WHERE cron_lease.expires_at<?3`,
  ).bind(crypto.randomUUID(), now + 55_000, now).run();
  if (Number(lease.meta.changes ?? 0) !== 1) throw new Error("A configuration refresh already ran in the last minute. Cached evidence is shown until the cooldown ends.");
  const known = await env.DB.prepare(`SELECT asset_id FROM assets WHERE account_id=?1 AND family='workers' AND scope='resource' LIMIT 2500`).bind(env.BROLLY_ACCOUNT_ID).all<{ asset_id: string }>();
  const knownScripts = new Set(known.results.map(row => row.asset_id));
  for (const script of scripts) if (!knownScripts.has(script)) throw new Error(`Worker is not in Brolly inventory: ${script}`);

  let token: string;
  try { token = await operationalToken(env); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const script of scripts) await saveVerification(env, unavailableVerification(script, detail));
    return configurationData(env);
  }

  for (let index = 0; index < scripts.length; index += 3) {
    await Promise.all(scripts.slice(index, index + 3).map(async script => {
      const verification = await verifyWorker(env, token, script);
      await saveVerification(env, verification);
    }));
  }
  return configurationData(env);
}

async function verifyWorker(env: Env, token: string, workerScript: string): Promise<WorkerVerification> {
  const script = encodeURIComponent(workerScript);
  const [secretResult, deploymentResult, bundleResult] = await Promise.allSettled([
    api<Array<{ name: string; type: string }>>(token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/scripts/${script}/secrets`),
    api<{ deployments?: Array<{ id: string; versions?: Array<{ version_id: string; percentage: number }> }> }>(token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/scripts/${script}/deployments`),
    scanWorkerBundle(token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/scripts/${script}`),
  ]);
  const firstError = [secretResult, deploymentResult, bundleResult].find(result => result.status === "rejected") as PromiseRejectedResult | undefined;
  const apiAccess = firstError
    ? errorCheck("Cloudflare check failed", firstError.reason)
    : pass("API access verified", "Brolly read secrets, deployments, and the deployed Worker bundle.");
  const secrets = secretResult.status === "fulfilled" ? secretResult.value : [];
  const hasFuse = secrets.some(secret => secret.name === "BROLLY_FUSE" && secret.type === "secret_text");
  const deployments = deploymentResult.status === "fulfilled" ? deploymentResult.value.deployments ?? [] : [];
  const active = deployments[0];
  const version = active?.versions?.find(item => item.percentage === 100)?.version_id ?? active?.versions?.[0]?.version_id;
  const bundle = bundleResult.status === "fulfilled" ? bundleResult.value : null;
  return {
    workerScript, checkedAt: Date.now(), deploymentId: active?.id, versionId: version,
    checks: {
      apiAccess,
      fuseSecret: secretResult.status === "rejected" ? errorCheck("Secret check failed", secretResult.reason)
        : hasFuse ? pass("Fuse secret present", "The deployed Worker has a secret_text binding named BROLLY_FUSE.")
          : fail("Fuse secret missing", "Initialize BROLLY_FUSE before enabling shutdown controls."),
      runtimeBundle: bundleResult.status === "rejected" ? errorCheck("Bundle check failed", bundleResult.reason)
        : bundle?.found ? pass("Runtime detected", "The deployed Worker bundle contains the Brolly quarantine marker.")
          : bundle?.truncated ? unknown("Bundle scan bounded", `No marker was found in the first ${MAX_BUNDLE_SCAN_BYTES.toLocaleString()} bytes.`)
            : fail("Runtime not detected", "The active Worker bundle does not contain the Brolly runtime marker."),
      activeDeployment: deploymentResult.status === "rejected" ? errorCheck("Deployment check failed", deploymentResult.reason)
        : active ? pass("Active deployment found", version ? `Deployment ${active.id} is serving version ${version}.` : `Deployment ${active.id} is active.`)
          : fail("No active deployment", "Cloudflare returned no active deployment for this Worker."),
    },
  };
}

async function scanWorkerBundle(token: string, path: string): Promise<{ found: boolean; truncated: boolean }> {
  const response = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Cloudflare bundle check failed (${response.status}): ${await response.text()}`);
  if (!response.body) return { found: (await response.text()).includes(RUNTIME_MARKER), truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let scanned = 0;
  let tail = "";
  while (scanned < MAX_BUNDLE_SCAN_BYTES) {
    const { done, value } = await reader.read();
    if (done) return { found: tail.includes(RUNTIME_MARKER), truncated: false };
    scanned += value.byteLength;
    const text = tail + decoder.decode(value, { stream: true });
    if (text.includes(RUNTIME_MARKER)) { await reader.cancel(); return { found: true, truncated: false }; }
    tail = text.slice(-RUNTIME_MARKER.length + 1);
  }
  await reader.cancel();
  return { found: false, truncated: true };
}

async function api<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Cloudflare returned ${response.status}: ${await response.text()}`);
  const payload = await response.json() as ApiEnvelope<T>;
  if (!payload.success) throw new Error(payload.errors?.map(item => item.message).join("; ") ?? "Cloudflare verification failed");
  return payload.result;
}

async function saveVerification(env: Env, verification: WorkerVerification): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  ).bind(`${VERIFICATION_PREFIX}${verification.workerScript}`, JSON.stringify(verification), verification.checkedAt).run();
}

function unavailableVerification(workerScript: string, detail: string): WorkerVerification {
  const check = error("Cloudflare unavailable", detail);
  return { workerScript, checkedAt: Date.now(), checks: { apiAccess: check, fuseSecret: check, runtimeBundle: check, activeDeployment: check } };
}

function overallWorkerStatus(declaredInstalled: boolean, checks: Record<string, VerificationCheck>): OverallState {
  if (Object.values(checks).some(check => check.state === "error")) return "error";
  if (declaredInstalled && checks.fuseSecret?.state === "pass" && checks.runtimeBundle?.state === "pass" && checks.activeDeployment?.state === "pass") return "configured";
  if (declaredInstalled || Object.values(checks).some(check => check.state === "pass" && check.label !== "Discovered")) return "partial";
  return "not_configured";
}

function parseTags(value: string): Record<string, string> { try { return JSON.parse(value) as Record<string, string>; } catch { return {}; } }
function pass(label: string, detail: string): VerificationCheck { return { state: "pass", label, detail }; }
function fail(label: string, detail: string): VerificationCheck { return { state: "fail", label, detail }; }
function unknown(label: string, detail: string): VerificationCheck { return { state: "unknown", label, detail }; }
function error(label: string, detail: string): VerificationCheck { return { state: "error", label, detail }; }
function errorCheck(label: string, cause: unknown): VerificationCheck { return error(label, cause instanceof Error ? cause.message : String(cause)); }
