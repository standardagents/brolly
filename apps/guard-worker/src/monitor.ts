import { LedgerBudgetExceededError, LedgerRunBudget, METRIC_CATALOG, MonitoringBudgetExceededError, RunBudget, localDayAt, type AssetRef, type ControlAction, type CoverageResult, type Evaluation } from "@standardagents/brolly-core";
import { notify, type NotificationTarget } from "@standardagents/brolly-notifiers";
import { CloudflareClient } from "./cloudflare.js";
import type { Env } from "./env.js";
import { Store } from "./store.js";
import { openJson } from "./credentials.js";
import { AutomaticDeploymentLimitError, executeDeploymentFuseBatch } from "./control.js";
import { LedgerStore } from "./ledger-store.js";
import { ingestWindow } from "./ingest.js";
import { dispatchAlertNotifications, evaluateUsageAlerts } from "./alert-engine.js";
import { runRetentionMaintenance } from "./retention.js";
import { runOneBackfillSlice } from "./backfill.js";
import { migrateLegacyPolicyRules } from "./policy-migration.js";
import { configuredLedgerRunLimits } from "./ledger-settings.js";

export interface CollectorWindowCursor<T> {
  startAt: number;
  endAt: number;
  cursor?: T;
}

export async function runMonitor(env: Env, options: { force?: boolean } = {}): Promise<void> {
  const ledgerBudget = new LedgerRunBudget(await configuredLedgerRunLimits(env.DB));
  const budget = new RunBudget({
    apiCalls: ledgerBudget.limits.graphqlQueries + ledgerBudget.limits.restRequests,
    databaseRows: ledgerBudget.limits.d1RowsRead + ledgerBudget.limits.d1RowsWritten,
    samples: 100_000,
    wallMs: ledgerBudget.limits.wallMs,
  });
  const store = new Store(env.DB, (amount, kind) => {
    budget.charge("databaseRows", amount);
    ledgerBudget.charge(kind === "read" ? "d1RowsRead" : "d1RowsWritten", amount);
  });
  const ledger = new LedgerStore(env.DB, ledgerBudget);
  const holder = crypto.randomUUID();
  if (!await store.acquireLease("minute-monitor", holder, 55_000)) return;
  const automaticQueue = new Map<string, ControlAction[]>();
  const startedAt = Date.now();
  const timeZone = env.BROLLY_TIMEZONE ?? "UTC";
  const collectionEnd = Math.floor((startedAt - 2 * 60_000) / (5 * 60_000)) * 5 * 60_000;
  let activeDue = await ledger.claimDueCollector(env.BROLLY_ACCOUNT_ID, "active-usage", 5 * 60_000, startedAt, options.force === true);
  if (!activeDue && !options.force) {
    const pending = await env.DB.prepare(
      `SELECT 1 AS present FROM collector_state
       WHERE account_id=?1 AND collector_key IN ('graphql:durable-objects','graphql:workers')
         AND partition_key IN ('active','correction') AND last_status='partial' LIMIT 1`,
    ).bind(env.BROLLY_ACCOUNT_ID).first<{ present: number }>();
    if (pending) activeDue = await ledger.claimDueCollector(env.BROLLY_ACCOUNT_ID, "active-usage", 5 * 60_000, startedAt, true);
  }
  let hotWatch = false;
  if (!activeDue && !options.force) {
    const watched = await env.DB.prepare(
      `SELECT 1 AS present FROM alert_instances i JOIN alert_lines l ON l.id=i.alert_line_id
       WHERE i.status='open' AND i.historical=0 AND i.period_end_at>?1 AND l.priority>=50 LIMIT 1`,
    ).bind(startedAt).first<{ present: number }>();
    const watermark = await env.DB.prepare(
      `SELECT MIN(high_watermark_at) AS watermark FROM collector_state
       WHERE account_id=?1 AND collector_key IN ('graphql:durable-objects','graphql:workers')
         AND partition_key='active'`,
    ).bind(env.BROLLY_ACCOUNT_ID).first<{ watermark: number | null }>();
    if (watched && Number(watermark?.watermark ?? 0) < collectionEnd) {
      hotWatch = await ledger.claimDueCollector(env.BROLLY_ACCOUNT_ID, "hot-watch", 60_000, startedAt);
    }
  }
  if (!activeDue && !hotWatch) return;
  const runId = await ledger.startMonitorRun(
    env.BROLLY_ACCOUNT_ID,
    options.force ? "explicit_refresh" : hotWatch ? "hot_watch" : "active_usage",
    startedAt,
  );
  let runFinished = false;
  let runContinuation: unknown;
  let normalizedSamples = 0;

  try {
    const policy = await store.loadPolicy();
    const client = new CloudflareClient(env, budget, ledgerBudget);
    const now = startedAt;
    const utcMinute = new Date(now).getUTCMinutes();
    const since = collectionEnd - 5 * 60_000;
    const inventoryDue = await ledger.claimDueCollector(env.BROLLY_ACCOUNT_ID, "resource-inventory", 60 * 60_000, now, options.force === true);
    const capabilityDue = await ledger.claimDueCollector(env.BROLLY_ACCOUNT_ID, "capability-discovery", 24 * 60 * 60_000, now, options.force === true);
    const billingDue = await ledger.claimDueCollector(env.BROLLY_ACCOUNT_ID, "billing-reconciliation", 60 * 60_000, now, options.force === true);
    const retentionDue = await ledger.claimDueCollector(env.BROLLY_ACCOUNT_ID, "retention-maintenance", 60 * 60_000, now, options.force === true);
    if (capabilityDue) await ledger.syncMetricCatalog();
    const inventory = inventoryDue ? await client.inventory() : { assets: [], coverage: [] as CoverageResult[] };
    budget.charge("samples", inventory.assets.length);
    await store.saveAssets(inventory.assets);
    for (const family of new Set(inventory.assets.map(asset => asset.family))) {
      await store.applyPoliciesToAssets(inventory.assets.filter(asset => asset.family === family), family);
    }
    await ledger.saveInventory(inventory.assets);
    await store.saveCoverage(inventory.coverage);
    if (capabilityDue) {
      await ledger.saveCapabilities(await client.analyticsCapabilities());
      await ledger.persistCollectorState(env.BROLLY_ACCOUNT_ID, "capability-discovery", "", {
        nextEligibleAt: now + 24 * 60 * 60_000, status: "complete", watermarkAt: now,
      });
    }
    if (inventoryDue) await ledger.persistCollectorState(env.BROLLY_ACCOUNT_ID, "resource-inventory", "", {
      nextEligibleAt: now + 60 * 60_000, status: "complete", watermarkAt: now,
    });
    if (capabilityDue) await migrateLegacyPolicyRules(env.DB, env.BROLLY_ACCOUNT_ID, policy);

    const [durableActiveCursor, durableCorrectionCursor, workerActiveCursor, workerCorrectionCursor] = await Promise.all([
      ledger.collectorCursor<CollectorWindowCursor<import("./cloudflare.js").DurableObjectUsageCursor>>(env.BROLLY_ACCOUNT_ID, "graphql:durable-objects", "active"),
      ledger.collectorCursor<CollectorWindowCursor<import("./cloudflare.js").DurableObjectUsageCursor>>(env.BROLLY_ACCOUNT_ID, "graphql:durable-objects", "correction"),
      ledger.collectorCursor<CollectorWindowCursor<import("./cloudflare.js").WorkerUsageCursor>>(env.BROLLY_ACCOUNT_ID, "graphql:workers", "active"),
      ledger.collectorCursor<CollectorWindowCursor<import("./cloudflare.js").WorkerUsageCursor>>(env.BROLLY_ACCOUNT_ID, "graphql:workers", "correction"),
    ]);
    const durableActiveWindow = collectorWindow(durableActiveCursor, since, collectionEnd);
    const durableCorrectionWindow = collectorWindow(durableCorrectionCursor, since - 5 * 60_000, since);
    const workerActiveWindow = collectorWindow(workerActiveCursor, since, collectionEnd);
    const workerCorrectionWindow = collectorWindow(workerCorrectionCursor, since - 5 * 60_000, since);
    const [durableObjects, durableCorrections, workers, workerCorrections] = await Promise.all([
      ingestWindow({
        env, client, ledger, collector: "graphql:durable-objects", budget: ledgerBudget, timeZone,
        startsAt: durableActiveWindow.startAt, endsAt: durableActiveWindow.endAt, cursor: durableActiveWindow.cursor,
        persist: false,
      }),
      ingestWindow({
        env, client, ledger, collector: "graphql:durable-objects", budget: ledgerBudget, timeZone,
        startsAt: durableCorrectionWindow.startAt, endsAt: durableCorrectionWindow.endAt, cursor: durableCorrectionWindow.cursor,
        persist: false,
      }),
      ingestWindow({
        env, client, ledger, collector: "graphql:workers", budget: ledgerBudget, timeZone,
        startsAt: workerActiveWindow.startAt, endsAt: workerActiveWindow.endAt, cursor: workerActiveWindow.cursor,
        persist: false,
      }),
      ingestWindow({
        env, client, ledger, collector: "graphql:workers", budget: ledgerBudget, timeZone,
        startsAt: workerCorrectionWindow.startAt, endsAt: workerCorrectionWindow.endAt, cursor: workerCorrectionWindow.cursor,
        persist: false,
      }),
    ]);
    runContinuation = {
      durableObjects: windowContinuation(durableActiveWindow, durableObjects.continuation, collectionEnd),
      durableObjectCorrections: windowContinuation(durableCorrectionWindow, durableCorrections.continuation),
      workers: windowContinuation(workerActiveWindow, workers.continuation, collectionEnd),
      workerCorrections: windowContinuation(workerCorrectionWindow, workerCorrections.continuation),
    };
    await store.saveCoverage([...durableObjects.coverage, ...workers.coverage]);
    await store.applyPoliciesToAssets(
      [...durableObjects.samples, ...durableCorrections.samples].map(sample => sample.asset),
      "durable_objects",
    );
    await store.applyPoliciesToAssets(
      [...workers.samples, ...workerCorrections.samples].map(sample => sample.asset),
      "workers",
    );
    normalizedSamples = durableObjects.observations + durableCorrections.observations
      + workers.observations + workerCorrections.observations;
    const ledgerObservations = [
      ...(durableCorrections.normalizedObservations ?? []), ...(durableObjects.normalizedObservations ?? []),
      ...(workerCorrections.normalizedObservations ?? []), ...(workers.normalizedObservations ?? []),
    ];
    const ledgerChanges = await ledger.applyObservations(ledgerObservations, timeZone);
    const billingCycle = await ledger.currentBillingCycle(env.BROLLY_ACCOUNT_ID, collectionEnd);
    const alertResult = await evaluateUsageAlerts(env, ledgerChanges, {
      timeZone, billingCycleId: billingCycle.id,
      billingCycleStart: billingCycle.startsAt, billingCycleEnd: billingCycle.endsAt, now, budget: ledgerBudget,
    });
    await dispatchAlertNotifications(env, alertResult.notifications, ledgerBudget);
    for (const action of alertResult.automaticActions) {
      const workerScript = String(action.rollback.workerScript ?? "");
      if (workerScript) automaticQueue.set(workerScript, [...(automaticQueue.get(workerScript) ?? []), action]);
    }
    await persistWindowState(ledger, env.BROLLY_ACCOUNT_ID, "graphql:durable-objects", "active", durableActiveWindow, durableObjects, now, collectionEnd);
    await persistWindowState(ledger, env.BROLLY_ACCOUNT_ID, "graphql:durable-objects", "correction", durableCorrectionWindow, durableCorrections, now);
    await persistWindowState(ledger, env.BROLLY_ACCOUNT_ID, "graphql:workers", "active", workerActiveWindow, workers, now, collectionEnd);
    await persistWindowState(ledger, env.BROLLY_ACCOUNT_ID, "graphql:workers", "correction", workerCorrectionWindow, workerCorrections, now);
    await ledger.sealCompletedDays(env.BROLLY_ACCOUNT_ID, timeZone, now);
    if (billingDue) {
      try {
        const billing = await ingestWindow({
          env, client, ledger, collector: "billing", budget: ledgerBudget, timeZone,
          startsAt: now - 31 * 86_400_000, endsAt: now,
        });
        const reconciledCycle = await ledger.currentBillingCycle(env.BROLLY_ACCOUNT_ID, now);
        const billingAlerts = await evaluateUsageAlerts(env, billing.changes, {
          timeZone,
          billingCycleId: reconciledCycle.id,
          billingCycleStart: reconciledCycle.startsAt,
          billingCycleEnd: reconciledCycle.endsAt,
          now, budget: ledgerBudget,
        });
        await dispatchAlertNotifications(env, billingAlerts.notifications, ledgerBudget);
        await store.saveCoverage([{
          family: "billing", metric: "authoritative_usage", finestScope: "account",
          state: billing.coverage[0]?.state ?? "unavailable", checkedAt: now,
          detail: billing.coverage[0]?.detail,
        }]);
        await ledger.persistCollectorState(env.BROLLY_ACCOUNT_ID, "billing-reconciliation", "", {
          watermarkAt: now, nextEligibleAt: now + 60 * 60_000,
          status: billing.complete ? "complete" : "partial",
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await store.saveCoverage([{
          family: "billing", metric: "authoritative_usage", finestScope: "account",
          state: "unavailable", checkedAt: now, detail,
        }]);
        await ledger.persistCollectorState(env.BROLLY_ACCOUNT_ID, "billing-reconciliation", "", {
          nextEligibleAt: now + 5 * 60_000, status: "failed", error: detail,
        });
      }
    }
    if (retentionDue) {
      await runRetentionMaintenance(env.DB, env.BROLLY_ACCOUNT_ID, ledgerBudget, now, timeZone);
      await ledger.persistCollectorState(env.BROLLY_ACCOUNT_ID, "retention-maintenance", "", {
        watermarkAt: now, nextEligibleAt: now + 60 * 60_000, status: "complete",
      });
    }
    const objectCosts = new Map<string, { asset: AssetRef; cost: number }>();
    for (const sample of durableObjects.samples) {
      if (sample.asset.scope === "object") {
        const current = objectCosts.get(sample.asset.id) ?? { asset: sample.asset, cost: 0 };
        current.cost += sample.estimatedCostUsd ?? 0;
        objectCosts.set(sample.asset.id, current);
      }
    }

    let rolling24hCost: number | null = null;
    const projectedDailyCost = durableObjects.samples.reduce((sum, sample) => sum + (sample.estimatedCostUsd ?? 0), 0) * (86_400_000 / (collectionEnd - since));
    const projectedWorkersDailyCost = workers.samples.reduce((sum, sample) => sum + (sample.estimatedCostUsd ?? 0), 0) * (86_400_000 / (collectionEnd - since));
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
        start: since, end: collectionEnd, source: "graphql", estimatedCostUsd: projectedDailyCost,
      },
      ...(rolling24hCost === null ? [] : [{
        asset: spendAsset, metric: "rolling_24h_cost_usd", unit: "usd" as const, value: rolling24hCost,
        start: now - 86_400_000, end: now, source: "graphql" as const, estimatedCostUsd: rolling24hCost,
      }]),
      {
        asset: workersSpendAsset, metric: "projected_daily_cost_usd", unit: "usd", value: projectedWorkersDailyCost,
        start: since, end: collectionEnd, source: "graphql", estimatedCostUsd: projectedWorkersDailyCost,
      },
    ]);
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
    while (ledgerBudget.remaining("backfillSlices") > 0 && ledgerBudget.remaining("wallMs") >= 8_000) {
      const backfill = await runOneBackfillSlice(env, client, ledger, ledgerBudget, timeZone);
      if (!backfill.worked) break;
      normalizedSamples += backfill.samples;
    }

    const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: env.BROLLY_TIMEZONE ?? "UTC" }).format(new Date(now));
    if (isDailySummaryHour(env) && await store.claimDailySummary(localDay)) {
      const [billingCoverage, billedCost] = await Promise.all([
        env.DB.prepare(
          `SELECT state,detail FROM metric_coverage
           WHERE family='billing' AND metric='authoritative_usage' LIMIT 1`,
        ).first<{ state: CoverageResult["state"]; detail: string | null }>(),
        env.DB.prepare(
          `SELECT SUM(COALESCE(billed_cost,effective_cost,list_cost,0)) AS cost
           FROM billing_line_items WHERE account_id=?1 AND charge_period_start>=?2`,
        ).bind(env.BROLLY_ACCOUNT_ID, now - 2 * 86_400_000).first<{ cost: number | null }>(),
      ]);
      const billingState = billingCoverage?.state ?? "permission_denied";
      const billingDetail = billingCoverage?.detail
        ?? "Add Billing Read access in Brolly setup or configure CLOUDFLARE_BILLING_TOKEN for authoritative reconciliation";
      const authoritativeBilledCost = billedCost?.cost == null ? null : Number(billedCost.cost);
      if (billingState !== "healthy") {
        const billingCoverageAsset: AssetRef = { accountId: env.BROLLY_ACCOUNT_ID, family: "billing", id: "authoritative_usage", scope: "account", tier: "control_plane" };
        await handleEvaluation(store, {
          key: `${env.BROLLY_ACCOUNT_ID}:coverage:billing:authoritative_usage`, asset: billingCoverageAsset,
          metric: "telemetry_coverage", severity: "critical", observed: 0,
          reason: `billing/authoritative_usage telemetry is ${billingState}${billingDetail ? `: ${billingDetail}` : ""}`, action: "notify",
        }, false, env, automaticQueue);
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
    await ledger.finishMonitorRun(runId, env.BROLLY_ACCOUNT_ID, localDayAt(now, timeZone), {
      startedAt, datasetsQueried: ledgerBudget.usage.graphqlQueries,
      rowsReturned: durableObjects.samples.length + durableCorrections.samples.length + workers.samples.length + workerCorrections.samples.length,
      samplesNormalized: normalizedSamples, continuation: runContinuation,
      complete: durableObjects.complete && durableCorrections.complete && workers.complete && workerCorrections.complete,
    });
    runFinished = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!runFinished) {
      try {
        await ledger.finishMonitorRun(runId, env.BROLLY_ACCOUNT_ID, localDayAt(startedAt, timeZone), {
          startedAt, datasetsQueried: ledgerBudget.usage.graphqlQueries, rowsReturned: 0,
          samplesNormalized: normalizedSamples, continuation: runContinuation, errors: [message], complete: false,
        });
      } catch (accountingError) {
        console.error("[Brolly] monitor accounting failed", accountingError);
      }
    }
    if (error instanceof MonitoringBudgetExceededError || error instanceof LedgerBudgetExceededError) {
      console.error(JSON.stringify({ event: "monitoring_budget_exhausted", kind: error.kind, message: error.message, usage: budget.usage }));
      await writeSentinelIncident(env.DB, env.BROLLY_ACCOUNT_ID, error.message);
      return;
    }
    console.error("[Brolly] monitor failed", error);
    await writeSentinelIncident(env.DB, env.BROLLY_ACCOUNT_ID, message);
  }
}

export function collectorWindow<T>(stored: CollectorWindowCursor<T> | null, fallbackStart: number, fallbackEnd: number): CollectorWindowCursor<T> {
  if (stored && Number.isFinite(stored.startAt) && Number.isFinite(stored.endAt) && stored.startAt < stored.endAt) return stored;
  return { startAt: fallbackStart, endAt: fallbackEnd };
}

export function windowContinuation<T>(window: CollectorWindowCursor<T>, continuation: T | null, latestEnd?: number): CollectorWindowCursor<T> | null {
  if (continuation) return { startAt: window.startAt, endAt: window.endAt, cursor: continuation };
  if (latestEnd !== undefined && window.endAt < latestEnd) {
    return { startAt: window.endAt, endAt: Math.min(latestEnd, window.endAt + 5 * 60_000) };
  }
  return null;
}

async function persistWindowState<T extends { continuation: C | null; complete: boolean; watermarkAt: number }, C>(
  ledger: LedgerStore,
  accountId: string,
  collectorKey: string,
  partitionKey: string,
  window: CollectorWindowCursor<C>,
  result: T,
  now: number,
  latestEnd?: number,
): Promise<void> {
  const continuation = windowContinuation(window, result.continuation, latestEnd);
  await ledger.persistCollectorState(accountId, collectorKey, partitionKey, {
    cursor: continuation ?? undefined,
    watermarkAt: result.watermarkAt,
    nextEligibleAt: now + (continuation ? 60_000 : 5 * 60_000),
    status: continuation || !result.complete ? "partial" : "complete",
  });
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

async function handleEvaluation(store: Store, evaluation: Evaluation, dailySummary = false, env?: Env, automaticQueue?: Map<string, ControlAction[]>): Promise<void> {
  const { incident, notify: shouldSend } = await store.recordEvaluation(evaluation);
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
