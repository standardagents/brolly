import { DEFAULT_POLICY, METRIC_CATALOG, MonitoringBudgetExceededError, RunBudget, evaluateProjectedDailySpend, evaluateSample, type AssetRef, type ControlAction, type CoverageResult, type Evaluation, type Incident } from "@standardagents/brolly-core";
import { notify, type NotificationTarget } from "@standardagents/brolly-notifiers";
import { CloudflareClient } from "./cloudflare.js";
import type { Env } from "./env.js";
import { Store } from "./store.js";
import { openJson } from "./credentials.js";
import { AutomaticDeploymentLimitError, executeDeploymentFuseBatch } from "./control.js";

export async function runMonitor(env: Env): Promise<void> {
  const budget = new RunBudget();
  const store = new Store(env.DB, amount => budget.charge("databaseRows", amount));
  const holder = crypto.randomUUID();
  if (!await store.acquireLease("minute-monitor", holder, 55_000)) return;
  const automaticQueue = new Map<string, ControlAction[]>();

  try {
    const policy = await store.loadPolicy();
    const client = new CloudflareClient(env, budget);
    const now = Date.now();
    const utcMinute = new Date(now).getUTCMinutes();
    const since = now - 5 * 60_000;
    const inventory = await client.inventory();
    budget.charge("samples", inventory.assets.length);
    await store.saveAssets(inventory.assets);
    await store.saveCoverage(inventory.coverage);

    const [durableObjects, workers] = await Promise.all([
      client.durableObjectUsage(since, now),
      client.workerUsage(since, now),
    ]);
    await store.saveCoverage([...durableObjects.coverage, ...workers.coverage]);
    await store.saveAssets(Array.from(new Map([...durableObjects.samples, ...workers.samples].map(sample => [`${sample.asset.family}:${sample.asset.scope}:${sample.asset.id}`, sample.asset])).values()));
    await store.applyAssetPolicies(durableObjects.samples, "durable_objects");
    await store.applyAssetPolicies(workers.samples, "workers");
    let baselineQueries = 0;
    for (const sample of durableObjects.samples) {
      const threshold = policy.thresholds.find(item => item.metric === sample.metric && item.windowMs === 5 * 60_000);
      if (!threshold) continue;
      let evaluation = evaluateSample(sample, threshold, [], policy);
      if (!evaluation && sample.value > 0 && baselineQueries < 50) {
        baselineQueries += 1;
        evaluation = evaluateSample(sample, threshold, await store.baseline(sample), policy);
      }
      if (evaluation) await handleEvaluation(store, evaluation, false, env, automaticQueue);
    }
    const objectCosts = new Map<string, { asset: AssetRef; cost: number }>();
    const namespaceCosts = new Map<string, { asset: AssetRef; cost: number }>();
    for (const sample of durableObjects.samples) {
      if (sample.asset.scope === "object") {
        const current = objectCosts.get(sample.asset.id) ?? { asset: sample.asset, cost: 0 };
        current.cost += sample.estimatedCostUsd ?? 0;
        objectCosts.set(sample.asset.id, current);
        if (sample.asset.parentId) {
          const namespace = namespaceCosts.get(sample.asset.parentId) ?? {
            asset: { accountId: env.BROLLY_ACCOUNT_ID, family: "durable_objects", id: sample.asset.parentId, scope: "namespace", tier: "unclassified" },
            cost: 0,
          };
          namespace.cost += sample.estimatedCostUsd ?? 0;
          namespaceCosts.set(sample.asset.parentId, namespace);
        }
      } else if (sample.asset.scope === "namespace") {
        const namespace = namespaceCosts.get(sample.asset.id) ?? { asset: sample.asset, cost: 0 };
        namespace.cost += sample.estimatedCostUsd ?? 0;
        namespaceCosts.set(sample.asset.id, namespace);
      }
    }
    const objectCostThreshold = policy.thresholds.find(item => item.metric === "projected_daily_cost_usd")
      ?? DEFAULT_POLICY.thresholds.find(item => item.metric === "projected_daily_cost_usd")!;
    for (const value of objectCosts.values()) {
      const projected = value.cost * (86_400_000 / (now - since));
      const evaluation = evaluateSample(
        { asset: value.asset, metric: "projected_daily_cost_usd", unit: "usd", value: projected, start: since, end: now, source: "graphql", estimatedCostUsd: projected },
        objectCostThreshold, [], policy,
      );
      if (evaluation) await handleEvaluation(store, evaluation, false, env, automaticQueue);
    }
    const namespaceProjectedSamples = [...namespaceCosts.values()].map(value => ({
      asset: value.asset,
      metric: "projected_daily_cost_usd",
      unit: "usd" as const,
      value: value.cost * (86_400_000 / (now - since)),
      start: since,
      end: now,
      source: "graphql" as const,
      estimatedCostUsd: value.cost * (86_400_000 / (now - since)),
    }));
    await store.applyAssetPolicies(namespaceProjectedSamples, "durable_objects");
    for (const sample of namespaceProjectedSamples) {
      const evaluation = evaluateProjectedDailySpend(sample.asset, sample.value, policy);
      if (evaluation) await handleEvaluation(store, evaluation, false, env, automaticQueue);
    }

    const workerCosts = new Map<string, { asset: AssetRef; cost: number }>();
    for (const sample of workers.samples) {
      const current = workerCosts.get(sample.asset.id) ?? { asset: sample.asset, cost: 0 };
      current.cost += sample.estimatedCostUsd ?? 0;
      workerCosts.set(sample.asset.id, current);
    }
    for (const value of workerCosts.values()) {
      const projected = value.cost * (86_400_000 / (now - since));
      const evaluation = evaluateProjectedDailySpend(value.asset, projected, policy);
      if (evaluation) await handleEvaluation(store, evaluation, false, env, automaticQueue);
    }

    // Evaluate true 24-hour object totals directly from Cloudflare every 15
    // minutes. That keeps daily protection independent from (and cheaper than)
    // scanning Brolly's own retained samples.
    let rolling24hCost: number | null = null;
    if (utcMinute % 15 === 0) {
      const dailyObjects = await client.durableObjectUsage(now - 86_400_000, now);
      await store.saveCoverage(dailyObjects.coverage);
      await store.applyAssetPolicies(dailyObjects.samples, "durable_objects");
      rolling24hCost = dailyObjects.samples.reduce((sum, sample) => sum + (sample.estimatedCostUsd ?? 0), 0);
      for (const sample of dailyObjects.samples) {
        const threshold = policy.thresholds.find(item => item.metric === sample.metric && item.windowMs === 86_400_000);
        if (!threshold) continue;
        const evaluation = evaluateSample(sample, threshold, [], policy);
        if (evaluation) await handleEvaluation(store, evaluation, false, env, automaticQueue);
      }
    }
    const projectedDailyCost = durableObjects.samples.reduce((sum, sample) => sum + (sample.estimatedCostUsd ?? 0), 0) * (86_400_000 / (now - since));
    const projectedWorkersDailyCost = workers.samples.reduce((sum, sample) => sum + (sample.estimatedCostUsd ?? 0), 0) * (86_400_000 / (now - since));
    const spendAsset: AssetRef = {
      accountId: env.BROLLY_ACCOUNT_ID, family: "durable_objects", id: env.BROLLY_ACCOUNT_ID,
      name: "all Durable Objects", scope: "account", tier: "control_plane",
    };
    const workersSpendAsset: AssetRef = {
      accountId: env.BROLLY_ACCOUNT_ID, family: "workers", id: env.BROLLY_ACCOUNT_ID,
      name: "all Workers", scope: "account", tier: "control_plane",
    };
    await store.saveSamples([
      {
        asset: spendAsset, metric: "projected_daily_cost_usd", unit: "usd", value: projectedDailyCost,
        start: since, end: now, source: "graphql", estimatedCostUsd: projectedDailyCost,
      },
      ...(rolling24hCost === null ? [] : [{
        asset: spendAsset, metric: "rolling_24h_cost_usd", unit: "usd" as const, value: rolling24hCost,
        start: now - 86_400_000, end: now, source: "graphql" as const, estimatedCostUsd: rolling24hCost,
      }]),
      {
        asset: workersSpendAsset, metric: "projected_daily_cost_usd", unit: "usd", value: projectedWorkersDailyCost,
        start: since, end: now, source: "graphql", estimatedCostUsd: projectedWorkersDailyCost,
      },
    ]);
    const accountEvaluation = evaluateProjectedDailySpend(
      spendAsset,
      projectedDailyCost,
      policy,
    );
    if (accountEvaluation) await handleEvaluation(store, accountEvaluation, false, env, automaticQueue);
    const workersAccountEvaluation = evaluateProjectedDailySpend(workersSpendAsset, projectedWorkersDailyCost, policy);
    if (workersAccountEvaluation) await handleEvaluation(store, workersAccountEvaluation, false, env, automaticQueue);
    if (utcMinute % 15 === 0) {
      // Baseline retention is deliberately capped. Live evaluation still sees
      // every returned object; D1 stores all three metrics only for the 333
      // highest estimated-cost objects (<=999 rows per fifteen minutes).
      const scores = new Map<string, number>();
      for (const sample of durableObjects.samples) {
        scores.set(sample.asset.id, (scores.get(sample.asset.id) ?? 0) + (sample.estimatedCostUsd ?? 0));
      }
      const retainedIds = new Set([...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 333).map(([id]) => id));
      await store.saveSamples(durableObjects.samples.filter(sample => retainedIds.has(sample.asset.id)));
    }
    await coverageIncidents(store, [...inventory.coverage, ...durableObjects.coverage, ...workers.coverage], env, automaticQueue);
    await flushAutomaticFuses(store, env, automaticQueue);

    const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: env.BROLLY_TIMEZONE ?? "UTC" }).format(new Date(now));
    if (isDailySummaryHour(env) && await store.claimDailySummary(localDay)) {
      let billing: Awaited<ReturnType<CloudflareClient["billingUsage"]>> = null;
      let authoritativeBilledCost: number | null = null;
      let billingState: CoverageResult["state"] = env.CLOUDFLARE_BILLING_TOKEN ? "healthy" : "permission_denied";
      let billingDetail = env.CLOUDFLARE_BILLING_TOKEN ? undefined : "Configure CLOUDFLARE_BILLING_TOKEN for authoritative reconciliation";
      try {
        billing = await client.billingUsage(now - 2 * 86_400_000, now);
      } catch (error) {
        billingState = "unavailable";
        billingDetail = error instanceof Error ? error.message : String(error);
      }
      await store.saveCoverage([{
        family: "billing", metric: "authoritative_usage", finestScope: "account",
        state: billingState, checkedAt: now, detail: billingDetail,
      }]);
      if (billingState !== "healthy") {
        const billingCoverageAsset: AssetRef = { accountId: env.BROLLY_ACCOUNT_ID, family: "billing", id: "authoritative_usage", scope: "account", tier: "control_plane" };
        await handleEvaluation(store, {
          key: `${env.BROLLY_ACCOUNT_ID}:coverage:billing:authoritative_usage`, asset: billingCoverageAsset,
          metric: "telemetry_coverage", severity: "critical", observed: 0,
          reason: `billing/authoritative_usage telemetry is ${billingState}${billingDetail ? `: ${billingDetail}` : ""}`, action: "notify",
        }, false, env, automaticQueue);
      }
      if (billing) {
        const billingSamples = billing.slice(0, 10_000).map(record => {
          const family = record.x_ProductFamilyId ?? record.x_ProductFamilyName ?? "unknown";
          const asset: AssetRef = {
            accountId: env.BROLLY_ACCOUNT_ID, family,
            id: record.x_ZoneId ?? family, name: record.x_ZoneName ?? record.x_ProductFamilyName,
            scope: record.x_ZoneId ? "zone" : "account", tier: "control_plane",
          };
          return {
            asset, metric: record.x_BillableMetricId, unit: billingUnit(record.ConsumedUnit), value: record.ConsumedQuantity,
            start: Date.parse(record.ChargePeriodStart), end: Date.parse(record.ChargePeriodEnd), source: "billing" as const,
            estimatedCostUsd: record.BilledCost ?? record.EffectiveCost ?? record.ListCost,
          };
        });
        budget.charge("samples", billingSamples.length);
        await store.saveSamples(billingSamples);
        const currentBillingSamples = billingSamples.filter(sample => sample.end >= now - 86_400_000);
        const hasAuthoritativeCost = currentBillingSamples.some(sample => sample.estimatedCostUsd !== undefined);
        if (hasAuthoritativeCost) {
          const authoritativeCost = currentBillingSamples.reduce((sum, sample) => sum + (sample.estimatedCostUsd ?? 0), 0);
          authoritativeBilledCost = authoritativeCost;
          const billingEvaluation = evaluateSample(
            {
              asset: { accountId: env.BROLLY_ACCOUNT_ID, family: "billing", id: env.BROLLY_ACCOUNT_ID, scope: "account", tier: "control_plane" },
              metric: "account_daily_billed_cost_usd", unit: "usd", value: authoritativeCost,
              start: now - 86_400_000, end: now, source: "billing", estimatedCostUsd: authoritativeCost,
            },
            { metric: "account_daily_billed_cost_usd", windowMs: 86_400_000, ...policy.accountDailySpend }, [], policy,
          );
          if (billingEvaluation) await handleEvaluation(store, billingEvaluation, false, env, automaticQueue);
        }
      }
      const dailyAsset: AssetRef = { accountId: env.BROLLY_ACCOUNT_ID, family: "billing", id: "daily-summary", scope: "account", tier: "control_plane" };
      const dailyKey = `${env.BROLLY_ACCOUNT_ID}:daily-summary:${localDay}`;
      await handleEvaluation(store, {
        key: dailyKey,
        asset: dailyAsset, metric: "daily_summary", severity: "info", observed: projectedDailyCost,
        reason: `Daily summary: ${objectCosts.size} active Durable Objects in the latest window; projected gross Durable Objects cost $${projectedDailyCost.toFixed(2)}${billingState === "permission_denied" ? "; authoritative billing token not configured" : billingState === "unavailable" ? "; authoritative billing API unavailable" : authoritativeBilledCost === null ? "; authoritative usage returned without cost fields" : `; latest authoritative billed/effective/list cost $${authoritativeBilledCost.toFixed(2)}`}`,
        action: "notify",
      }, true, env, automaticQueue);
      await store.resolveIncident(dailyKey);
    }

    const cleanup = await env.DB.prepare(
      `DELETE FROM metric_samples WHERE id IN (SELECT id FROM metric_samples WHERE end_at < ?1 ORDER BY end_at ASC LIMIT 500)`,
    ).bind(now - 35 * 86_400_000).run();
    budget.charge("databaseRows", (cleanup.meta.rows_read ?? 0) + (cleanup.meta.rows_written ?? cleanup.meta.changes ?? 0));
    const notificationCleanup = await env.DB.prepare(
      `DELETE FROM notification_deliveries WHERE id IN (SELECT id FROM notification_deliveries WHERE created_at < ?1 ORDER BY created_at ASC LIMIT 500)`,
    ).bind(now - 35 * 86_400_000).run();
    budget.charge("databaseRows", (notificationCleanup.meta.rows_read ?? 0) + (notificationCleanup.meta.rows_written ?? notificationCleanup.meta.changes ?? 0));
    if (utcMinute % 15 === 0) await cleanupControlPlaneHistory(env.DB, budget, now);
    await store.resolveIncident(`${env.BROLLY_ACCOUNT_ID}:brolly:monitor_health`);
  } catch (error) {
    if (error instanceof MonitoringBudgetExceededError) {
      console.error(JSON.stringify({ event: "monitoring_budget_exhausted", kind: error.kind, message: error.message, usage: budget.usage }));
      await writeSentinelIncident(env.DB, env.BROLLY_ACCOUNT_ID, error.message);
      return;
    }
    console.error("[Brolly] monitor failed", error);
    await writeSentinelIncident(env.DB, env.BROLLY_ACCOUNT_ID, error instanceof Error ? error.message : String(error));
  }
}

async function cleanupControlPlaneHistory(db: D1Database, budget: RunBudget, now: number): Promise<void> {
  const statements = [
    db.prepare(`DELETE FROM oauth_states WHERE state_hash IN (SELECT state_hash FROM oauth_states WHERE expires_at<?1 LIMIT 250)`).bind(now),
    db.prepare(`DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE expires_at<?1 LIMIT 250)`).bind(now),
    db.prepare(`DELETE FROM control_deployments WHERE id IN (SELECT id FROM control_deployments WHERE created_at<?1 ORDER BY created_at LIMIT 250)`).bind(now - 35 * 86_400_000),
    db.prepare(`DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at<?1 ORDER BY created_at LIMIT 250)`).bind(now - 365 * 86_400_000),
    db.prepare(`DELETE FROM actions WHERE id IN (SELECT id FROM actions WHERE updated_at<?1 AND state IN ('failed','rolled_back') ORDER BY updated_at LIMIT 250)`).bind(now - 180 * 86_400_000),
    db.prepare(`DELETE FROM incidents WHERE id IN (SELECT id FROM incidents WHERE last_seen<?1 AND status='resolved' ORDER BY last_seen LIMIT 250)`).bind(now - 90 * 86_400_000),
    db.prepare(`DELETE FROM settings WHERE key IN (SELECT key FROM settings WHERE key LIKE 'configuration_verification:%' AND updated_at<?1 LIMIT 250)`).bind(now - 35 * 86_400_000),
  ];
  for (const result of await db.batch(statements)) {
    budget.charge("databaseRows", (result.meta.rows_read ?? 0) + (result.meta.rows_written ?? result.meta.changes ?? 0));
  }
}

function billingUnit(unit: string): "count" | "bytes" | "milliseconds" | "gb_seconds" | "usd" | "requests" | "rows" {
  const normalized = unit.toLowerCase();
  if (normalized.includes("gb-s") || normalized.includes("gb second")) return "gb_seconds";
  if (normalized.includes("byte") || normalized === "gb") return "bytes";
  if (normalized.includes("request")) return "requests";
  if (normalized.includes("row")) return "rows";
  if (normalized.includes("second") || normalized.includes("millisecond")) return "milliseconds";
  if (normalized === "usd") return "usd";
  return "count";
}

async function handleEvaluation(store: Store, evaluation: Evaluation, dailySummary = false, env?: Env, automaticQueue?: Map<string, ControlAction[]>): Promise<void> {
  const { previous, incident, notify: shouldSend } = await store.recordEvaluation(evaluation);
  if (evaluation.action !== "notify") {
    const action = await store.ensureRuntimeAction(incident);
    const workerScript = incident.asset.family === "workers" ? incident.asset.id : incident.asset.tags?.cloudflareWorkerScript;
    const deploymentFuseReady = incident.asset.tags?.brollyFuse === "true" && Boolean(workerScript);
    if (evaluation.action === "stop" && env && automaticQueue && action.kind === "runtime_quarantine" && deploymentFuseReady && action.state === "prepared"
      && confirmedAutomaticEmergency(previous, incident)) {
      automaticQueue.set(workerScript!, [...(automaticQueue.get(workerScript!) ?? []), action]);
    }
  }
  if (!shouldSend) return;
  const targets = await store.listNotificationTargets();
  await Promise.allSettled(targets.slice(0, 10).map(async row => {
    const severityRank = { info: 0, warning: 1, critical: 2, emergency: 3 } as const;
    const minimum = String(row.minimum_severity ?? "warning") as keyof typeof severityRank;
    if (!dailySummary && severityRank[incident.severity] < (severityRank[minimum] ?? 1)) return;
    if (!await store.notificationAllowed(String(row.id), String(row.kind))) return;
    const config = env?.BROLLY_CREDENTIAL_KEY
      ? await openJson<Omit<NotificationTarget, "id" | "kind" | "enabled">>(String(row.config_json), env.BROLLY_CREDENTIAL_KEY)
      : JSON.parse(String(row.config_json)) as Omit<NotificationTarget, "id" | "kind" | "enabled">;
    const result = await notify({ ...config, id: String(row.id), kind: row.kind as NotificationTarget["kind"], enabled: true }, incident);
    await store.recordNotification(String(row.id), incident.id, String(row.kind), result);
    return result;
  }));
}

async function coverageIncidents(store: Store, coverage: CoverageResult[], env: Env, automaticQueue: Map<string, ControlAction[]>): Promise<void> {
  const accountId = env.BROLLY_ACCOUNT_ID;
  for (const item of coverage) {
    const key = `${accountId}:coverage:${item.family}:${item.metric}`;
    if (item.state === "healthy") {
      await store.resolveIncident(key);
      continue;
    }
    const asset: AssetRef = { accountId, family: item.family, id: item.metric, scope: "account", tier: "control_plane" };
    await handleEvaluation(store, {
      key, asset, metric: "telemetry_coverage", severity: "critical",
      observed: 0, reason: `${item.family}/${item.metric} telemetry is ${item.state}${item.detail ? `: ${item.detail}` : ""}`, action: "notify",
    }, false, env, automaticQueue);
  }
  const seen = new Set(coverage.map(item => `${item.family}:${item.metric}`));
  const missing: CoverageResult[] = [];
  for (const definition of METRIC_CATALOG) {
    for (const metric of definition.metrics) {
      if (seen.has(`${definition.family}:${metric}`)) continue;
      missing.push({
        family: definition.family, metric, finestScope: definition.preferredScope,
        state: "unavailable", checkedAt: Date.now(), detail: "No active fast-telemetry collector",
      });
      const asset: AssetRef = { accountId, family: definition.family, id: metric, scope: "account", tier: "control_plane" };
      await handleEvaluation(store, { key: `${accountId}:coverage:${definition.family}:${metric}`, asset, metric: "telemetry_coverage", severity: "warning", observed: 0, reason: `${definition.family}/${metric} has no active collector`, action: "notify" }, false, env, automaticQueue);
    }
  }
  await store.saveCoverage(missing);
}

export function confirmedAutomaticEmergency(previous: Incident | undefined, incident: Incident): boolean {
  if (!previous || previous.status === "resolved" || previous.severity !== "emergency" || incident.severity !== "emergency") return false;
  if (["projected_daily_cost_usd", "account_daily_billed_cost_usd", "daily_summary", "telemetry_coverage"].includes(incident.metric)) return false;
  if (!(incident.asset.family === "workers" && incident.asset.scope === "resource")
    && !(incident.asset.family === "durable_objects" && incident.asset.scope === "object")) return false;
  const encodedWindow = Number(incident.key.split(":").at(-1));
  const maximumGap = Number.isFinite(encodedWindow) && encodedWindow > 5 * 60_000 ? 20 * 60_000 : 7 * 60_000;
  return incident.lastSeen - previous.lastSeen <= maximumGap;
}

async function flushAutomaticFuses(store: Store, env: Env, queue: Map<string, ControlAction[]>): Promise<void> {
  // One anomalous scan can touch at most five Workers. Multiple exact objects
  // owned by one Worker are coalesced into a single deployment.
  for (const [workerScript, queued] of [...queue.entries()].slice(0, 5)) {
    const actions = [...new Map(queued.map(action => [action.id, action])).values()].slice(0, 15);
    const claimed: ControlAction[] = [];
    for (const action of actions) if (await store.claimActionState(action.id, "prepared", "running")) claimed.push({ ...action, state: "running" });
    if (!claimed.length) continue;
    await store.audit("brolly-policy", "action.quarantine.batch.start", workerScript, { actionIds: claimed.map(action => action.id) });
    try {
      const result = await executeDeploymentFuseBatch(env, claimed, workerScript, "quarantine", true);
      for (const action of claimed) await store.setActionState(action.id, "succeeded");
      await store.audit("brolly-policy", "action.quarantine.batch.succeeded", workerScript, { actionIds: claimed.map(action => action.id), generation: result.manifest.generation });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = error instanceof AutomaticDeploymentLimitError;
      for (const action of claimed) await store.setActionState(action.id, retryable ? "prepared" : "failed", message);
      await store.audit("brolly-policy", retryable ? "action.quarantine.batch.deferred" : "action.quarantine.batch.failed", workerScript, { actionIds: claimed.map(action => action.id), error: message });
    }
  }
}

async function writeSentinelIncident(db: D1Database, accountId: string, reason: string): Promise<void> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO incidents(id,incident_key,account_id,family,asset_id,severity,metric,observed,reason,proposed_action,status,first_seen,last_seen,occurrences)
     VALUES(?1,?2,?3,'brolly','monitor','emergency','monitor_health',0,?4,'notify','open',?5,?5,1)
     ON CONFLICT(incident_key) DO UPDATE SET reason=excluded.reason,last_seen=excluded.last_seen,occurrences=incidents.occurrences+1`,
  ).bind(crypto.randomUUID(), `${accountId}:brolly:monitor_health`, accountId, reason.slice(0, 2000), now).run();
}

function isDailySummaryHour(env: Env): boolean {
  const hour = Number(env.BROLLY_DAILY_SUMMARY_HOUR ?? "9");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: env.BROLLY_TIMEZONE ?? "UTC", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date());
  const currentHour = Number(parts.find(part => part.type === "hour")?.value);
  const currentMinute = Number(parts.find(part => part.type === "minute")?.value);
  return currentHour === hour && currentMinute < 5;
}
