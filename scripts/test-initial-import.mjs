import { spawn, spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DB_PATH = path.resolve(".wrangler/state/account-dev/v3/d1/miniflare-D1DatabaseObject/73646d9cff124e92005d9938e8e9451ed6e56f1ac13e6c82510bd125fc7789e3.sqlite");
const PERSIST_PATH = path.resolve(".wrangler/state/account-dev");
const CONFIG_PATH = path.resolve("wrangler.jsonc");
const ARTIFACT_DIR = path.resolve(".wrangler/import-tests");
const TIMEOUT_MS = 45 * 60_000;
const POLL_MS = 5_000;
const DEFAULT_SHARED_QUERY_LIMIT = 270;
const CLEAN_GRAPHQL_BUDGET = 32_000;
const PUBLIC_OAUTH_CLIENT_ID = "5690968d2377c6200202668946420dec";

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(`Usage: pnpm test:import:account -- [options]

Runs a clean, real-account 90-day import without a browser. The reset preserves
the connected account, OAuth credentials, Billing token, inventory, and setup
configuration. Imported and derived telemetry is deleted.

Options:
  --skip-build       Reuse current package builds
  --no-reset         Resume current import data
  --preflight-only   Report Cloudflare capacity without starting an import
  --timeout-ms=<n>   Overall timeout (default: 2700000)
  --help             Show this help
`);
  process.exit(0);
}

mkdirSync(ARTIFACT_DIR, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const artifactPath = path.join(ARTIFACT_DIR, `${runId}.jsonl`);
const serverLogPath = path.join(ARTIFACT_DIR, `${runId}.server.log`);
let startedAt = Date.now();
const milestones = {};
let lastSignature = "";
let child;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopWorker();
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  });
}

record("run_started", { runId, reset: options.reset, artifactPath, serverLogPath });
if (!options.skipBuild) buildDependencies();
applyMigrations();
await waitForCloudflareCapacity();
if (options.preflightOnly) process.exit(0);
if (options.reset) resetImportData();
try {
  const port = await availablePort();
  child = startWorker(port, serverLogPath);
  const origin = `http://127.0.0.1:${port}`;
  await waitForHealth(origin, child);
  record("worker_ready", { port });
  startedAt = Date.now();
  record("import_started", {});

  while (Date.now() - startedAt < options.timeoutMs) {
    const invocationStartedAt = Date.now();
    const invocation = fetch(`${origin}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*&format=json`);
    while (true) {
      const state = importState();
      reportState(state);
      captureMilestones(state);
      const settled = await Promise.race([
        invocation.then(response => ({ done: true, response })),
        delay(POLL_MS).then(() => ({ done: false })),
      ]);
      if (!settled.done) continue;
      if (!settled.response.ok) throw new Error(`Scheduled import returned ${settled.response.status}: ${await settled.response.text()}`);
      record("invocation_complete", { durationMs: Date.now() - invocationStartedAt });
      break;
    }

    const state = importState();
    reportState(state);
    captureMilestones(state);
    if (terminalStatus(state.job?.status)) {
      const summary = summarize(state, startedAt, milestones);
      record("run_complete", summary);
      console.log(JSON.stringify({ artifactPath, serverLogPath, ...summary }, null, 2));
      process.exitCode = state.failed > 0 ? 2 : 0;
      break;
    }
    const waitUntil = earliestFutureDeadline([state.resumeAt, state.nextEligibleAt]);
    if (waitUntil > Date.now()) {
      record("continuation_wait", { waitMs: waitUntil - Date.now(), waitUntil });
      await delay(waitUntil - Date.now() + 50);
    }
  }
  if (!terminalStatus(importState().job?.status)) throw new Error(`Import exceeded ${options.timeoutMs}ms`);
} finally {
  stopWorker();
}

function stopWorker() {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  child = undefined;
}

function buildDependencies() {
  for (const packageName of ["@standardagents/brolly-core", "@standardagents/brolly-notifiers", "@standardagents/brolly-runtime"]) {
    run("pnpm", ["--filter", packageName, "build"]);
  }
}

function applyMigrations() {
  run("pnpm", [
    "exec", "wrangler", "d1", "migrations", "apply", "DB", "--local",
    "--persist-to", PERSIST_PATH, "--config", CONFIG_PATH,
  ], { ...process.env, CI: "true" });
}

function resetImportData() {
  const db = new DatabaseSync(DB_PATH);
  const accountId = setting(db, "account_id");
  const now = Date.now();
  const jobId = webcrypto.randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of [
      "backfill_slices", "backfill_jobs", "usage_accumulator_shards", "usage_daily", "usage_cycle_totals",
      "billing_line_items", "billing_cycles", "coverage_intervals", "metric_samples", "metric_coverage",
      "collector_state", "collector_capabilities", "contributor_candidates", "monitor_runs", "monitor_usage_daily",
    ]) db.exec(`DELETE FROM ${table}`);
    db.prepare("DELETE FROM cron_lease WHERE name LIKE 'initial-ingestion:%'").run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'initial_ingestion_quota:%' OR key LIKE 'initial_ingestion_capabilities:%' OR key='onboarding_budget_estimates'").run();
    db.prepare("DELETE FROM settings WHERE key='onboarding_complete'").run();
    db.prepare(
      `INSERT INTO backfill_jobs(
         id,account_id,kind,requested_start_at,requested_end_at,newest_first,status,created_at,updated_at
       ) VALUES(?1,?2,'initial_v2',?3,?4,1,'planning',?4,0)`,
    ).run(jobId, accountId, now - 90 * 86_400_000, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  record("import_reset", { jobId });
}

async function waitForCloudflareCapacity() {
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const result = await cloudflareCapacity();
    record("quota_preflight", result);
    if (result.graphqlAvailable
      && result.graphqlBudget >= CLEAN_GRAPHQL_BUDGET
      && result.remaining >= Math.min(300, Math.floor(result.limit * 0.25))) return;
    // The preflight query consumes GraphQL budget itself. Capacity returns as
    // requests leave Cloudflare's rolling window, so an early follow-up probe
    // only adds debt. Let the complete window clear before checking again.
    const waitMs = Math.max(
      result.windowSeconds * 1_000,
      result.retryAfterMs ?? result.resetSeconds * 1_000,
    );
    await delay(waitMs + 100);
  }
  throw new Error("Cloudflare quota did not recover within six minutes");
}

async function cloudflareCapacity() {
  const oauth = await refreshOAuthCredentials();
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let accountId;
  try { accountId = setting(db, "account_id"); } finally { db.close(); }
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${oauth.accessToken}`,
      "content-type": "application/json",
      "x-rate-limit-type": "account-based",
    },
    body: JSON.stringify({
      query: "query BrollyImportPreflight($account: String!) { cost viewer { budget accounts(filter: { accountTag: $account }) { accountTag } } }",
      variables: { account: accountId },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({}));
  const policy = parseRateHeader(response.headers.get("ratelimit-policy"));
  const rate = parseRateHeader(response.headers.get("ratelimit"));
  const graphqlRateLimited = Array.isArray(payload.errors) && payload.errors.some(error =>
    String(error?.extensions?.code ?? "").toLowerCase() === "budget"
      || /rate.?limit|budget depleted|too many requests/i.test(String(error?.message ?? "")),
  );
  const graphqlBudget = Number.isFinite(Number(payload.data?.viewer?.budget))
    ? Number(payload.data.viewer.budget)
    : 0;
  const budgetRecoveryMs = graphqlBudget < CLEAN_GRAPHQL_BUDGET
    ? Math.ceil((CLEAN_GRAPHQL_BUDGET - graphqlBudget) / (CLEAN_GRAPHQL_BUDGET / 300_000))
    : null;
  return {
    status: response.status,
    graphqlAvailable: response.ok && !graphqlRateLimited,
    graphqlErrors: Array.isArray(payload.errors)
      ? payload.errors.map(error => String(error?.message ?? "Unknown GraphQL error"))
      : [],
    graphqlCost: Number.isFinite(Number(payload.data?.cost)) ? Number(payload.data.cost) : null,
    graphqlBudget,
    limit: policy.q ?? 1_200,
    windowSeconds: policy.w ?? 300,
    remaining: rate.r ?? 0,
    resetSeconds: rate.t ?? 1,
    retryAfterMs: graphqlRateLimited
      ? 5 * 60_000
      : Math.max(retryAfterMs(response.headers.get("retry-after")) ?? 0, budgetRecoveryMs ?? 0) || null,
  };
}

async function refreshOAuthCredentials() {
  const credentialKey = devVariable("BROLLY_CREDENTIAL_KEY");
  const db = new DatabaseSync(DB_PATH);
  try {
    const current = await decryptJson(setting(db, "oauth_credentials"), credentialKey);
    if (!current.expiresAt || Number(current.expiresAt) - Date.now() > 5 * 60_000) return current;
    if (!current.refreshToken) throw new Error("Stored Cloudflare OAuth access cannot be renewed; reconnect Brolly");
    const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: devVariableOptional("BROLLY_OAUTH_CLIENT_ID") ?? PUBLIC_OAUTH_CLIENT_ID,
        refresh_token: current.refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Cloudflare OAuth refresh failed (${response.status})`);
    const payload = await response.json();
    const refreshed = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? current.refreshToken,
      expiresAt: payload.expires_in ? Date.now() + Number(payload.expires_in) * 1_000 : undefined,
    };
    db.prepare("UPDATE settings SET value=?1,updated_at=?2 WHERE key='oauth_credentials'")
      .run(await encryptJson(refreshed, credentialKey), Date.now());
    record("oauth_refreshed", { expiresAt: refreshed.expiresAt ?? null });
    return refreshed;
  } finally {
    db.close();
  }
}

function startWorker(port, logPath) {
  const output = [];
  const worker = spawn("pnpm", ["--filter", "@standardagents/brolly-guard", "dev"], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      BROLLY_ACCOUNT_DEV: "1",
      BROLLY_ACCOUNT_DEV_NO_TUNNEL: "1",
      BROLLY_DEV_HOST: "127.0.0.1",
      BROLLY_DEV_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = chunk => {
    output.push(String(chunk));
    writeFileSync(logPath, output.join(""));
  };
  worker.stdout.on("data", capture);
  worker.stderr.on("data", capture);
  return worker;
}

async function waitForHealth(origin, worker) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (worker.exitCode !== null) throw new Error(`Worker exited during startup (${worker.exitCode})`);
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the local Worker");
}

function importState() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const job = db.prepare("SELECT id,status,created_at,updated_at FROM backfill_jobs WHERE kind='initial_v2' ORDER BY created_at DESC LIMIT 1").get();
    if (!job) return { job: null, collectors: [], complete: 0, pending: 0, failed: 0, resumeAt: null, nextEligibleAt: null, quota: null };
    const collectors = db.prepare(
      `SELECT collector_key AS collector,COUNT(*) AS total,
         SUM(status='complete') AS complete,SUM(status='failed') AS failed,
         SUM(status IN ('pending','running')) AS pending
       FROM backfill_slices WHERE backfill_job_id=?1 AND status!='superseded'
       GROUP BY collector_key ORDER BY MIN(COALESCE(json_extract(scope_key,'$.priority'),10000)),collector_key`,
    ).all(job.id);
    const totals = db.prepare(
      `SELECT SUM(status='complete') AS complete,SUM(status='failed') AS failed,
         SUM(status IN ('pending','running')) AS pending,
         SUM(status IN ('pending','running') AND (next_eligible_at IS NULL OR next_eligible_at<=?2)) AS eligible_now,
         MIN(CASE WHEN status IN ('pending','running') AND next_eligible_at>?2 THEN next_eligible_at END) AS next_eligible_at
       FROM backfill_slices WHERE backfill_job_id=?1 AND status!='superseded'`,
    ).get(job.id, Date.now());
    const quotaRow = db.prepare("SELECT value FROM settings WHERE key LIKE 'initial_ingestion_quota:%' LIMIT 1").get();
    const quota = quotaRow?.value ? JSON.parse(String(quotaRow.value)) : null;
    const capabilityRow = db.prepare("SELECT value FROM settings WHERE key=?1 LIMIT 1").get(`initial_ingestion_capabilities:${job.id}`);
    const discoveredCapabilities = capabilityRow?.value ? JSON.parse(String(capabilityRow.value)).length : 0;
    const latestAdmissionAt = Array.isArray(quota?.admissions)
      ? Math.max(0, ...quota.admissions.map(admission => Number(admission?.admittedAt ?? 0)))
      : Number(quota?.accountLastAdmissionAt ?? quota?.windowStartedAt ?? 0);
    return {
      job,
      collectors,
      complete: Number(totals?.complete ?? 0),
      pending: Number(totals?.pending ?? 0),
      failed: Number(totals?.failed ?? 0),
      nextEligibleAt: Number(totals?.eligible_now ?? 0) > 0 || totals?.next_eligible_at == null
        ? null
        : Number(totals.next_eligible_at),
      resumeAt: quotaResumeAt(quota, latestAdmissionAt),
      quota,
      discoveredCapabilities,
    };
  } finally {
    db.close();
  }
}

function quotaResumeAt(quota, latestAdmissionAt, now = Date.now()) {
  const rateLimitAt = Math.max(
    quota?.pausedUntil && quota.pausedUntil > now ? Number(quota.pausedUntil) : 0,
    quota?.accountPausedUntil && quota.accountPausedUntil > now ? Number(quota.accountPausedUntil) : 0,
  );
  if (rateLimitAt > now) return rateLimitAt;
  return earliestFutureDeadline([
    quota?.capacityWaitUntil,
    quota?.sharedNextAdmissionAt,
    quota?.reportedRemaining == null
      && quota?.sharedUsed >= (quota?.sharedLimit ?? quota?.adaptiveLimit ?? DEFAULT_SHARED_QUERY_LIMIT)
      ? latestAdmissionAt + 300_000
      : null,
  ], now) || null;
}

function earliestFutureDeadline(values, now = Date.now()) {
  const deadlines = values
    .map(value => Number(value ?? 0))
    .filter(value => Number.isFinite(value) && value > now);
  return deadlines.length ? Math.min(...deadlines) : 0;
}

function reportState(state) {
  const signature = JSON.stringify({
    status: state.job?.status,
    complete: state.complete,
    pending: state.pending,
    failed: state.failed,
    queryUnits: state.quota?.sharedUsed ?? 0,
    physicalRequests: state.quota?.physicalUsed ?? 0,
    reportedRemaining: state.quota?.reportedRemaining ?? null,
    observedCapacity: state.quota?.observedCapacity ?? null,
    observedMaxCost: state.quota?.observedMaxCost ?? 0,
    observedMaxDebit: state.quota?.observedMaxDebit ?? 0,
    observedCostMultiplier: state.quota?.observedCostMultiplier ?? 1,
    observedCosts: state.quota?.observedCosts ?? {},
    observedDebits: state.quota?.observedDebits ?? {},
    discoveredCapabilities: state.discoveredCapabilities ?? 0,
    collectors: state.collectors.map(item => [item.collector, item.complete, item.pending, item.failed]),
  });
  if (signature === lastSignature) return;
  lastSignature = signature;
  record("progress", JSON.parse(signature));
}

function captureMilestones(state) {
  const billing = state.collectors.find(item => item.collector === "billing");
  const durableObjects = state.collectors.find(item => item.collector === "graphql:durable-objects");
  const workers = state.collectors.find(item => item.collector === "graphql:workers");
  if (!milestones.billingReadyAt && billing && Number(billing.pending) === 0) milestones.billingReadyAt = Date.now();
  if (!milestones.durableObjectsReadyAt && durableObjects && Number(durableObjects.pending) === 0) milestones.durableObjectsReadyAt = Date.now();
  if (!milestones.workersReadyAt && workers && Number(workers.pending) === 0) milestones.workersReadyAt = Date.now();
}

function summarize(state, start, marks) {
  return {
    status: state.job?.status ?? "missing",
    durationMs: Date.now() - start,
    billingReadyMs: marks.billingReadyAt ? marks.billingReadyAt - start : null,
    durableObjectsReadyMs: marks.durableObjectsReadyAt ? marks.durableObjectsReadyAt - start : null,
    workersReadyMs: marks.workersReadyAt ? marks.workersReadyAt - start : null,
    queryUnitsUsed: Number(state.quota?.sharedUsed ?? 0),
    physicalRequestsUsed: Number(state.quota?.physicalUsed ?? 0),
    slices: { complete: state.complete, pending: state.pending, failed: state.failed },
    collectors: state.collectors,
    storage: storageSummary(),
  };
}

function storageSummary() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const counts = db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM resources) AS resources,
         (SELECT COUNT(*) FROM usage_accumulator_shards) AS accumulator_shards,
         (SELECT COUNT(*) FROM usage_daily) AS daily_rows,
         (SELECT COUNT(*) FROM usage_cycle_totals) AS cycle_rows,
         (SELECT COUNT(*) FROM billing_line_items) AS billing_rows,
         (SELECT COUNT(*) FROM backfill_slices WHERE error LIKE '%Rate limiter%' OR error LIKE '%query budget exceeded%') AS rate_limit_deferrals,
         (SELECT COUNT(*) FROM backfill_slices WHERE error LIKE '%Cloudflare GraphQL query budget%') AS graphql_budget_splits`,
    ).get();
    return { ...counts, databaseBytes: statSync(DB_PATH).size };
  } finally {
    db.close();
  }
}

function record(event, detail) {
  const entry = JSON.stringify({ at: new Date().toISOString(), elapsedMs: typeof startedAt === "number" ? Date.now() - startedAt : 0, event, ...detail });
  if (typeof artifactPath === "string") writeFileSync(artifactPath, `${entry}\n`, { flag: "a" });
  console.log(entry);
}

function terminalStatus(status) {
  return status === "complete" || status === "complete_with_gaps" || status === "failed";
}

function setting(db, key) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?1 LIMIT 1").get(key);
  if (!row?.value) throw new Error(`Missing local D1 setting ${key}`);
  return String(row.value);
}

function devVariable(name) {
  const line = readFileSync(path.resolve(".dev.vars"), "utf8").split(/\r?\n/)
    .find(value => value.trimStart().startsWith(`${name}=`));
  if (!line) throw new Error(`Missing ${name} in .dev.vars`);
  return line.slice(line.indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
}

function devVariableOptional(name) {
  try { return devVariable(name); } catch { return undefined; }
}

async function decryptJson(value, secret) {
  const envelope = JSON.parse(value);
  const key = await webcrypto.subtle.importKey("raw", decode(secret), "AES-GCM", false, ["decrypt"]);
  const plaintext = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: decode(envelope.iv) }, key, decode(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function encryptJson(value, secret) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await webcrypto.subtle.importKey("raw", decode(secret), "AES-GCM", false, ["encrypt"]);
  const ciphertext = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({ iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) });
}

function decode(value) {
  return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function parseRateHeader(value) {
  return Object.fromEntries(String(value ?? "").match(/[a-z]+=[0-9]+/g)?.map(item => {
    const [key, raw] = item.split("=");
    return [key, Number(raw)];
  }) ?? []);
}

function retryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Unable to choose a test port"));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
}

function parseArgs(values) {
  const parsed = { help: false, preflightOnly: false, skipBuild: false, reset: true, timeoutMs: TIMEOUT_MS };
  for (const value of values) {
    if (value === "--") continue;
    if (value === "--help") parsed.help = true;
    else if (value === "--preflight-only") parsed.preflightOnly = true;
    else if (value === "--skip-build") parsed.skipBuild = true;
    else if (value === "--no-reset") parsed.reset = false;
    else if (value.startsWith("--timeout-ms=")) parsed.timeoutMs = Number(value.slice(13));
    else throw new Error(`Unknown argument ${value}`);
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 10_000) throw new Error("timeout-ms must be at least 10000");
  return parsed;
}
