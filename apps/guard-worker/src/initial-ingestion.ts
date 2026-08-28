import {
  INITIAL_INGESTION_LIMITS,
  LedgerBudgetExceededError,
  LedgerRunBudget,
  MonitoringBudgetExceededError,
  RunBudget,
} from "@standardagents/brolly-core";
import { CloudflareClient } from "./cloudflare.js";
import type { Env } from "./env.js";
import { LedgerStore, expandUsageObservations } from "./ledger-store.js";
import { configuredBillingToken } from "./credentials.js";
import { ingestWindow } from "./ingest.js";
import {
  HISTORICAL_DATASETS,
  HistoricalRateLimitError,
  isHistoricalRateLimitError,
  type HistoricalDatasetCapability,
  type HistoricalRateBudget,
  type HistoricalRateScope,
} from "./historical-analytics.js";
import { saveCoverageInterval, saveCoverageIntervals } from "./coverage-intervals.js";

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 90;
const BILLING_MAX_DAYS = 31;
const INITIAL_KIND = "initial_v2";
const LEGACY_INITIAL_KIND = "initial";
const INITIAL_FETCH_CONCURRENCY = 6;
const INITIAL_FETCH_QUEUE_CAPACITY = 2;
const GRAPHQL_SCOPE_INTERVAL_MS = 1_000;
const INITIAL_PHYSICAL_GRAPHQL_QUOTA = 40;
const INITIAL_SHARED_QUERY_QUOTA = 200;
const CONFIGURED_SHARED_QUERY_QUOTA = 160;
const MIN_ADAPTIVE_SHARED_QUERY_QUOTA = 60;
const MAX_ZONE_BATCH = 10;
const GRAPHQL_WINDOW_MS = 5 * 60_000;
const INITIAL_LEASE_TTL_MS = 120_000;
const INITIAL_LEASE_NAME = "initial-ingestion";
const BILLING_REQUESTS_PER_SLICE = 3;
const INITIAL_QUOTA_KEY_PREFIX = "initial_ingestion_quota:";
const INITIAL_CAPABILITY_KEY_PREFIX = "initial_ingestion_capabilities:";
const INITIAL_D1_READ_RESERVATION = 10_000;
const INITIAL_D1_WRITE_RESERVATION = 1_000;

export interface InitialIngestionJobResult {
  id: string;
  created: boolean;
  status: string;
  slices: number;
}

export interface InitialIngestionSlicePlan {
  collector: string;
  startsAt: number;
  endsAt: number;
  scopeKey: string;
  status: "pending" | "complete" | "failed";
  coverageStatus: "missing";
  error: string | null;
}

export interface InitialIngestionSliceMetadata {
  version: 2;
  dataset: string;
  zoneIds: string[];
  maxPageSize: number;
  units: number;
  availability?: "available" | "unavailable";
  terminalGap?: boolean;
  expectedGap?: boolean;
  persistenceRetry?: boolean;
}

export interface InitialIngestionProgress {
  job: {
    id: string;
    status: string;
    startedAt: number;
    updatedAt: number;
    limiterMode: "shared-paced" | "shared-fallback";
    resumeAt: number | null;
    sharedQueryLimit: number;
    queryWindowStartedAt: number;
    physicalRequestsUsed: number;
    physicalRequestLimit: number;
    logicalQueryUnitsUsed: number;
  } | null;
  collectors: Array<{
    collector: string;
    label: string;
    total: number;
    complete: number;
    failed: number;
    pending: number;
    totalUnits: number;
    completeUnits: number;
    failedUnits: number;
    oldestCompleteAt: number | null;
    errors: string[];
  }>;
  days: {
    total: number;
    complete: number;
    pending: number;
    gaps: number;
    failedWindows: number;
    errors: string[];
  } | null;
  readiness: InitialIngestionReadiness;
}

export type InitialIngestionReadinessState = "importing" | "ready" | "limited" | "unavailable";

export interface InitialIngestionReadiness {
  billing: "pending" | "ready" | "unavailable";
  account: "pending" | "ready" | "limited";
  products: Record<string, {
    state: InitialIngestionReadinessState;
    percent: number;
    errors: number;
  }>;
}

interface InitialSliceRow {
  id: string;
  backfill_job_id: string;
  collector_key: string;
  scope_key: string;
  starts_at: number;
  ends_at: number;
  status: string;
  retry_count: number;
  error: string | null;
}

/** Return whether a Billing Read credential is available without making a network request. */
export async function billingIngestionAvailable(env: Env): Promise<boolean> {
  try {
    return Boolean(await configuredBillingToken(env));
  } catch {
    return false;
  }
}

/**
 * Discover real dataset limits, supersede the legacy daily plan, and persist
 * an immutable range plan. Imported ledger history is preserved, and its
 * source-window keys make overlapping v2 observations idempotent.
 */
export async function ensureInitialIngestionJob(
  env: Env,
  options: { billingAvailable?: boolean; now?: number } = {},
): Promise<InitialIngestionJobResult> {
  const now = options.now ?? Date.now();
  const existing = await initialJob(env.DB, env.BROLLY_ACCOUNT_ID, INITIAL_KIND);
  if (existing && existing.status !== "planning_failed"
    && !(existing.status === "planning" && existing.updatedAt < now - 60_000)) {
    return ingestionJobResult(existing, false, await sliceCount(env.DB, existing.id));
  }
  const jobId = existing?.id ?? crypto.randomUUID();
  let created = false;

  if (!existing) {
    try {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE backfill_slices SET status='superseded',updated_at=?2
           WHERE backfill_job_id IN (SELECT id FROM backfill_jobs WHERE account_id=?1 AND kind=?3)
             AND status IN ('pending','running')`,
        ).bind(env.BROLLY_ACCOUNT_ID, now, LEGACY_INITIAL_KIND),
        env.DB.prepare(
          `UPDATE backfill_jobs SET status='superseded',updated_at=?2
           WHERE account_id=?1 AND kind=?3 AND status IN ('pending','running')`,
        ).bind(env.BROLLY_ACCOUNT_ID, now, LEGACY_INITIAL_KIND),
        env.DB.prepare(
          `INSERT INTO backfill_jobs(
             id,account_id,kind,requested_start_at,requested_end_at,newest_first,status,created_at,updated_at
           ) VALUES(?1,?2,?3,?4,?5,1,'planning',?5,?5)`,
        ).bind(jobId, env.BROLLY_ACCOUNT_ID, INITIAL_KIND, historyStart(now), now),
      ]);
      created = true;
    } catch (error) {
      const raced = await initialJob(env.DB, env.BROLLY_ACCOUNT_ID, INITIAL_KIND);
      if (!raced) throw error;
      return ingestionJobResult(raced, false, await sliceCount(env.DB, raced.id));
    }
  } else {
    const claimed = await env.DB.prepare(
      `UPDATE backfill_jobs SET status='planning',updated_at=?2
       WHERE id=?1 AND (status='planning_failed' OR status='planning' AND updated_at<?3)`,
    ).bind(jobId, now, now - 60_000).run();
    if (Number(claimed.meta.changes ?? 0) !== 1) {
      const current = await initialJob(env.DB, env.BROLLY_ACCOUNT_ID, INITIAL_KIND);
      return ingestionJobResult(current ?? existing, false, await sliceCount(env.DB, jobId));
    }
  }

  const planningHolder = crypto.randomUUID();
  if (!await acquireInitialIngestionLease(env.DB, env.BROLLY_ACCOUNT_ID, planningHolder)) {
    const current = await initialJob(env.DB, env.BROLLY_ACCOUNT_ID, INITIAL_KIND);
    return ingestionJobResult(current ?? { id: jobId, status: "planning" }, false, await sliceCount(env.DB, jobId));
  }
  try {
    const discoveryQuota = await loadInitialGraphqlQuota(env.DB, env.BROLLY_ACCOUNT_ID, jobId, now);
    if (!discoveryQuota.canCharge({ kind: "account" }, 1)) {
      await env.DB.prepare(`UPDATE backfill_jobs SET status='planning',updated_at=?2 WHERE id=?1`).bind(jobId, now).run();
      return { id: jobId, created, status: "planning", slices: await sliceCount(env.DB, jobId) };
    }
    const discoveryLedger = new LedgerRunBudget({
      graphqlQueries: discoveryQuota.logicalRemaining,
      restRequests: 20,
      d1RowsRead: 1_000,
      d1RowsWritten: 1_000,
      backfillSlices: 1,
      wallMs: 45_000,
    });
    const discoveryBudget = new RunBudget({
      apiCalls: INITIAL_PHYSICAL_GRAPHQL_QUOTA + 10,
      databaseRows: 2_000,
      samples: 1,
      wallMs: 45_000,
    });
    try {
      const capabilitySeed = await loadInitialCapabilities(env.DB, jobId, discoveryLedger);
      const capabilities = await new CloudflareClient(env, discoveryBudget, discoveryLedger, {
        accountBasedRateLimit: true,
        rateBudget: discoveryQuota,
      }).historicalCapabilities({
        seed: capabilitySeed,
        onProgress: values => saveInitialCapabilities(env.DB, jobId, values, discoveryLedger),
      });
      const billingAvailable = options.billingAvailable ?? await billingIngestionAvailable(env);
      const slices = initialIngestionSlicePlan(now, billingAvailable, capabilities);
      for (let offset = 0; offset < slices.length; offset += 100) {
        await env.DB.batch(slices.slice(offset, offset + 100).map(slice => env.DB.prepare(
          `INSERT OR IGNORE INTO backfill_slices(
             id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,
             retry_count,next_eligible_at,coverage_status,error,updated_at
           ) VALUES(?1,?2,?3,?4,?5,?6,?7,0,?8,?9,?10,?8)`,
        ).bind(
          crypto.randomUUID(), jobId, slice.collector, slice.scopeKey, slice.startsAt, slice.endsAt,
          slice.status, now, slice.coverageStatus, slice.error,
        )));
      }
      await saveCoverageIntervals(env.DB, slices.filter(slice => {
        const metadata = parseSliceMetadata(slice.scopeKey, slice.startsAt, slice.endsAt);
        return metadata.availability === "unavailable";
      }).flatMap(slice => {
        const metadata = parseSliceMetadata(slice.scopeKey, slice.startsAt, slice.endsAt);
        return (metadata.zoneIds.length ? metadata.zoneIds : [""]).map(scopeKey => ({
          accountId: env.BROLLY_ACCOUNT_ID,
          dataset: metadata.dataset,
          scopeKey,
          startsAt: slice.startsAt,
          endsAt: slice.endsAt,
          state: "unavailable" as const,
          reason: slice.error ?? undefined,
          recordedAt: now,
        }));
      }));
      const clearedCapabilities = await env.DB.prepare(`DELETE FROM settings WHERE key=?1`)
        .bind(`${INITIAL_CAPABILITY_KEY_PREFIX}${jobId}`).run();
      chargeMeta(discoveryLedger, clearedCapabilities.meta);
      await updateInitialJobStatus(env.DB, jobId);
    } finally {
      await saveInitialGraphqlQuota(env.DB, env.BROLLY_ACCOUNT_ID, discoveryQuota);
    }
  } catch (error) {
    if (isHistoricalRateLimitError(error)) {
      await env.DB.prepare(`UPDATE backfill_jobs SET status='planning',updated_at=?2 WHERE id=?1`).bind(jobId, Date.now()).run();
      return { id: jobId, created, status: "planning", slices: await sliceCount(env.DB, jobId) };
    }
    await env.DB.prepare(`UPDATE backfill_jobs SET status='planning_failed',updated_at=?2 WHERE id=?1`).bind(jobId, Date.now()).run();
    throw error;
  } finally {
    await releaseInitialIngestionLease(env.DB, env.BROLLY_ACCOUNT_ID, planningHolder);
  }
  const current = await initialJob(env.DB, env.BROLLY_ACCOUNT_ID, INITIAL_KIND);
  return { id: jobId, created, status: current?.status ?? "pending", slices: await sliceCount(env.DB, jobId) };
}

/** Build newest-first range work from Cloudflare's account-specific limits. */
export function initialIngestionSlicePlan(
  now: number,
  billingAvailable: boolean,
  capabilities: HistoricalDatasetCapability[],
): InitialIngestionSlicePlan[] {
  const slices: InitialIngestionSlicePlan[] = [];
  for (const spec of HISTORICAL_DATASETS) {
    const values = capabilities.filter(item => item.dataset === spec.dataset);
    if (spec.root === "account") {
      const setting = values[0];
      if (!setting?.enabled) {
        slices.push(gapSlice(
          spec.collector,
          spec.dataset,
          [],
          now,
          setting?.detail ?? "Cloudflare did not return dataset settings.",
          capabilityRetentionDays(setting, spec.retentionDays),
        ));
        continue;
      }
      slices.push(...rangeSlices(spec.collector, spec.dataset, [], now, setting));
      continue;
    }

    const applicable = values.filter(item => item.applicable);
    if (!applicable.length) continue;
    const enabled = applicable.filter(item => item.enabled && item.zoneId);
    const unavailable = applicable.filter(item => !item.enabled && item.zoneId);
    for (const group of capabilityGroups(enabled)) {
      for (const zoneIds of chunks(group.map(item => item.zoneId!), MAX_ZONE_BATCH)) {
        slices.push(...rangeSlices(spec.collector, spec.dataset, zoneIds, now, group[0]!));
      }
    }
    for (const group of capabilityGroups(unavailable)) {
      for (const zoneIds of chunks(group.map(item => item.zoneId!), MAX_ZONE_BATCH)) {
        const setting = group[0]!;
        slices.push(gapSlice(
          spec.collector,
          spec.dataset,
          zoneIds,
          now,
          setting.detail ?? "Cloudflare denied access to this zone dataset.",
          capabilityRetentionDays(setting, spec.retentionDays),
        ));
      }
    }
  }
  if (billingAvailable) slices.push(...boundedRanges("billing", "billable-usage", [], now, HISTORY_DAYS, BILLING_MAX_DAYS, 10_000));
  else slices.push(gapRange(
    "billing", "billable-usage", [], historyStart(now, HISTORY_DAYS), now,
    "Billing Read access is unavailable.", true,
  ));
  return slices.sort((left, right) => right.endsAt - left.endsAt || left.collector.localeCompare(right.collector));
}

function capabilityGroups(values: HistoricalDatasetCapability[]): HistoricalDatasetCapability[][] {
  const groups = new Map<string, HistoricalDatasetCapability[]>();
  for (const value of values) {
    const key = JSON.stringify([
      value.enabled,
      value.maxDurationSeconds,
      value.notOlderThanSeconds,
      value.maxPageSize,
      value.state,
      value.detail,
    ]);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function chunks<T>(values: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

/** Return progress weighted by dataset-days (and zone-days), not request count. */
export async function initialIngestionProgress(db: D1Database, accountId: string): Promise<InitialIngestionProgress> {
  const job = await db.prepare(
    `SELECT id,status,created_at,updated_at,kind,requested_start_at,requested_end_at FROM backfill_jobs
     WHERE account_id=?1 AND kind IN (?2,?3)
     ORDER BY CASE kind WHEN ?2 THEN 0 ELSE 1 END,created_at DESC LIMIT 1`,
  ).bind(accountId, INITIAL_KIND, LEGACY_INITIAL_KIND).first<{ id: string; status: string; created_at: number; updated_at: number; kind: string; requested_start_at: number; requested_end_at: number }>();
  if (!job) return { job: null, collectors: [], days: null, readiness: emptyInitialIngestionReadiness() };
  const rows = await db.prepare(
    `SELECT collector_key,scope_key,starts_at,ends_at,status,error
     FROM backfill_slices WHERE backfill_job_id=?1 AND status!='superseded'
     ORDER BY collector_key,ends_at DESC`,
  ).bind(job.id).all<{ collector_key: string; scope_key: string; starts_at: number; ends_at: number; status: string; error: string | null }>();
  const quota = await loadInitialGraphqlQuota(db, accountId, job.id, Date.now());
  const grouped = new Map<string, InitialIngestionProgress["collectors"][number]>();
  for (const row of rows.results) {
    const units = sliceUnits(row.scope_key, row.starts_at, row.ends_at);
    const current = grouped.get(row.collector_key) ?? {
      collector: row.collector_key,
      label: collectorLabel(row.collector_key),
      total: 0,
      complete: 0,
      failed: 0,
      pending: 0,
      totalUnits: 0,
      completeUnits: 0,
      failedUnits: 0,
      oldestCompleteAt: null,
      errors: [],
    };
    current.total += 1;
    current.totalUnits += units;
    if (row.status === "complete") {
      current.complete += 1;
      current.completeUnits += units;
      current.oldestCompleteAt = Math.min(current.oldestCompleteAt ?? row.starts_at, row.starts_at);
    } else if (row.status === "failed") {
      current.failed += 1;
      current.failedUnits += units;
      if (row.error && !current.errors.includes(row.error) && current.errors.length < 3) current.errors.push(row.error);
    } else {
      current.pending += 1;
    }
    grouped.set(row.collector_key, current);
  }
  return {
    job: {
      id: job.id,
      status: job.status,
      startedAt: job.created_at,
      updatedAt: job.updated_at,
      limiterMode: quota.mode,
      resumeAt: quota.resumeAt,
      sharedQueryLimit: quota.fallbackLimit,
      queryWindowStartedAt: quota.windowStartedAt,
      physicalRequestsUsed: quota.physicalUsed,
      physicalRequestLimit: INITIAL_PHYSICAL_GRAPHQL_QUOTA,
      logicalQueryUnitsUsed: quota.logicalUsed,
    },
    collectors: [...grouped.values()].sort((left, right) => left.collector === "billing" ? 1 : right.collector === "billing" ? -1 : left.label.localeCompare(right.label)),
    days: initialIngestionDays(job, rows.results),
    readiness: initialIngestionReadiness(job.status, rows.results),
  };
}

/** Drain bounded v2 slices with a fresh budget isolated from monitoring. */
export async function runInitialIngestion(env: Env, jobId: string): Promise<void> {
  const holder = crypto.randomUUID();
  if (!await acquireInitialIngestionLease(env.DB, env.BROLLY_ACCOUNT_ID, holder)) return;
  let quota: InitialGraphqlQuota;
  try {
    await requeueRunningInitialSlices(env.DB, jobId);
    quota = await loadInitialGraphqlQuota(env.DB, env.BROLLY_ACCOUNT_ID, jobId, Date.now());
  } catch (error) {
    await releaseInitialIngestionLease(env.DB, env.BROLLY_ACCOUNT_ID, holder);
    throw error;
  }
  if (quota.physicalRemaining < 1) {
    await releaseInitialIngestionLease(env.DB, env.BROLLY_ACCOUNT_ID, holder);
    return;
  }
  const ledgerBudget = new LedgerRunBudget(
    { ...INITIAL_INGESTION_LIMITS, graphqlQueries: quota.logicalRemaining },
    "initial_ingestion",
  );
  const budget = new RunBudget({
    apiCalls: INITIAL_PHYSICAL_GRAPHQL_QUOTA + INITIAL_INGESTION_LIMITS.restRequests,
    databaseRows: INITIAL_INGESTION_LIMITS.d1RowsRead + INITIAL_INGESTION_LIMITS.d1RowsWritten,
    samples: 100_000,
    wallMs: INITIAL_INGESTION_LIMITS.wallMs,
  });
  const client = new CloudflareClient(env, budget, ledgerBudget, {
    accountBasedRateLimit: true,
    rateBudget: quota,
  });
  const ledger = new LedgerStore(env.DB, ledgerBudget);
  const timeZone = env.BROLLY_TIMEZONE ?? "UTC";
  const claimSlice = serializedInitialSliceClaimer(env, ledgerBudget, quota, jobId);
  const claimReadySlice = async (
    mode: "analytics" | "billing" | "persistence_retry",
  ): Promise<ClaimedInitialSlice | null> => {
    while (canStartInitialSlice(ledgerBudget)) {
      const result = await claimSlice(mode);
      if (!isInitialClaimWait(result)) return result;
      await quota.waitForClaim(result.waitUntil, ledgerBudget.signal);
    }
    return null;
  };

  try {
    // Give one persistence-retry slice the first D1 work of this invocation.
    // Other marked slices wait for later invocations so each split decision is
    // based on a fresh run budget.
    if (canStartInitialSlice(ledgerBudget)) {
      const persistenceProbe = await claimReadySlice("persistence_retry");
      if (persistenceProbe) {
        await finalizeInitialSlice(
          env, ledger, ledgerBudget, jobId, timeZone, persistenceProbe,
          await fetchInitialSlice(env, client, ledgerBudget, quota, persistenceProbe, timeZone),
        );
        if (ledgerBudget.signal.aborted) return;
      }
    }

    // Billing reconciliation performs D1 writes during collection. Finish its
    // due slices before starting the parallel Analytics producer pool.
    while (canStartInitialSlice(ledgerBudget)) {
      const claimed = await claimReadySlice("billing");
      if (!claimed) break;
      await finalizeInitialSlice(
        env, ledger, ledgerBudget, jobId, timeZone, claimed,
        await fetchInitialSlice(env, client, ledgerBudget, quota, claimed, timeZone),
      );
    }

    // Producers fetch independently into a bounded ready queue. The single
    // consumer owns all normalization and D1 read-modify-write persistence.
    // A new wave handles range and zone partitions created by finalization.
    while (canStartInitialSlice(ledgerBudget)) {
      const ready = new InitialFetchQueue(INITIAL_FETCH_QUEUE_CAPACITY);
      let claimedInWave = 0;
      let producerError: unknown;
      let producerBudgetExhausted = false;
      const producer = async (): Promise<void> => {
        while (producerError === undefined && !producerBudgetExhausted && canStartInitialSlice(ledgerBudget)) {
          let claimed: ClaimedInitialSlice | null;
          try {
            claimed = await claimReadySlice("analytics");
          } catch (error) {
            if (error instanceof LedgerBudgetExceededError || error instanceof MonitoringBudgetExceededError) {
              producerBudgetExhausted = true;
              return;
            }
            producerError ??= error;
            return;
          }
          if (!claimed) return;
          claimedInWave += 1;
          if (!await ready.push(await fetchInitialSlice(env, client, ledgerBudget, quota, claimed, timeZone))) return;
        }
      };
      const producerCompletion = Promise.all(
        Array.from({ length: INITIAL_FETCH_CONCURRENCY }, () => producer()),
      ).then(() => ready.close());
      let consumerError: unknown;
      try {
        while (true) {
          const fetched = await ready.next();
          if (!fetched) break;
          await finalizeInitialSlice(env, ledger, ledgerBudget, jobId, timeZone, fetched.claimed, fetched);
          if (ledgerBudget.signal.aborted) {
            ready.close();
            break;
          }
        }
      } catch (error) {
        consumerError = error;
        ready.close();
      }
      await producerCompletion;
      if (consumerError !== undefined) throw consumerError;
      if (producerError !== undefined) throw producerError;
      if (ledgerBudget.signal.aborted) {
        await requeueRunningInitialSlices(env.DB, jobId);
        await updateInitialJobStatus(env.DB, jobId);
        return;
      }
      if (producerBudgetExhausted) {
        await requeueRunningInitialSlices(env.DB, jobId);
        await updateInitialJobStatus(env.DB, jobId);
        return;
      }
      if (claimedInWave === 0) break;
      if (!await initialSlicesPending(env.DB, jobId)) break;
    }
    if (ledgerBudget.signal.aborted) {
      await updateInitialJobStatus(env.DB, jobId);
      return;
    }
    await updateInitialJobStatus(env.DB, jobId, ledgerBudget);
  } catch (error) {
    await requeueRunningInitialSlices(env.DB, jobId).catch(() => undefined);
    await updateInitialJobStatus(env.DB, jobId).catch(() => undefined);
    throw error;
  } finally {
    try {
      await saveInitialGraphqlQuota(env.DB, env.BROLLY_ACCOUNT_ID, quota);
    } finally {
      await releaseInitialIngestionLease(env.DB, env.BROLLY_ACCOUNT_ID, holder);
    }
  }
}

/** Resume the account's active range import, if one exists. */
export async function resumeInitialIngestion(env: Env): Promise<void> {
  const job = await env.DB.prepare(
    `SELECT id,status FROM backfill_jobs
     WHERE account_id=?1 AND kind=?2 AND status IN ('planning','planning_failed','pending','running') LIMIT 1`,
  ).bind(env.BROLLY_ACCOUNT_ID, INITIAL_KIND).first<{ id: string; status: string }>();
  if (!job) return;
  if (job.status === "planning" || job.status === "planning_failed") {
    const planned = await ensureInitialIngestionJob(env);
    if (planned.status === "pending" || planned.status === "running") await runInitialIngestion(env, planned.id);
    return;
  }
  await runInitialIngestion(env, job.id);
}

/** Choose cron work without starting the monitor before first-run protection is configured. */
export async function initialIngestionSchedulingState(db: D1Database, accountId: string): Promise<{
  importActive: boolean;
  onboardingComplete: boolean;
}> {
  const row = await db.prepare(
    `SELECT
       EXISTS(SELECT 1 FROM backfill_jobs
         WHERE account_id=?1 AND kind=?2 AND status IN ('planning','planning_failed','pending','running')) AS import_active,
       EXISTS(SELECT 1 FROM settings WHERE key='onboarding_complete' AND value='true') AS onboarding_complete`,
  ).bind(accountId, INITIAL_KIND).first<{ import_active: number; onboarding_complete: number }>();
  return {
    importActive: Number(row?.import_active ?? 0) === 1,
    onboardingComplete: Number(row?.onboarding_complete ?? 0) === 1,
  };
}

interface ClaimedInitialSlice {
  slice: InitialSliceRow;
  metadata: InitialIngestionSliceMetadata;
  persistenceReservation: { reads: number; writes: number } | null;
  rateScope: HistoricalRateScope | null;
}

interface InitialClaimWait {
  waitUntil: number | null;
}

type InitialClaimResult = ClaimedInitialSlice | InitialClaimWait | null;

interface InitialSliceFetch {
  claimed: ClaimedInitialSlice;
  usage?: Awaited<ReturnType<CloudflareClient["historicalUsage"]>>;
  billing?: Awaited<ReturnType<typeof ingestWindow>>;
  error?: unknown;
}

class InitialFetchQueue {
  private readonly values: InitialSliceFetch[] = [];
  private readonly readers: Array<(value: InitialSliceFetch | null) => void> = [];
  private readonly writers: Array<() => void> = [];
  private closed = false;

  constructor(private readonly capacity: number) {}

  async push(value: InitialSliceFetch): Promise<boolean> {
    while (!this.closed && this.values.length >= this.capacity) {
      await new Promise<void>(resolve => this.writers.push(resolve));
    }
    if (this.closed) return false;
    const reader = this.readers.shift();
    if (reader) reader(value);
    else this.values.push(value);
    return true;
  }

  async next(): Promise<InitialSliceFetch | null> {
    const value = this.values.shift();
    if (value) {
      this.writers.shift()?.();
      return value;
    }
    if (this.closed) return null;
    return new Promise(resolve => this.readers.push(resolve));
  }

  close(): void {
    this.closed = true;
    for (const resolve of this.readers.splice(0)) resolve(null);
    for (const resolve of this.writers.splice(0)) resolve();
  }
}

function canStartInitialSlice(budget: LedgerRunBudget): boolean {
  return budget.remaining("backfillSlices") > 0 && budget.remaining("wallMs") >= 8_000;
}

function serializedInitialSliceClaimer(
  env: Env,
  budget: LedgerRunBudget,
  quota: InitialGraphqlQuota,
  jobId: string,
): (mode: "analytics" | "billing" | "persistence_retry") => Promise<InitialClaimResult> {
  let previous = Promise.resolve();
  return async mode => {
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const turn = previous;
    previous = current;
    await turn;
    try {
      return await claimInitialSlice(env, budget, quota, jobId, mode);
    } finally {
      release();
    }
  };
}

function isInitialClaimWait(result: InitialClaimResult): result is InitialClaimWait {
  return result !== null && "waitUntil" in result;
}

async function claimInitialSlice(
  env: Env,
  budget: LedgerRunBudget,
  quota: InitialGraphqlQuota,
  jobId: string,
  mode: "analytics" | "billing" | "persistence_retry",
): Promise<InitialClaimResult> {
  const modeCode = mode === "billing" ? 1 : mode === "persistence_retry" ? 2 : 0;
  const candidates = await env.DB.prepare(
    `SELECT * FROM backfill_slices
     WHERE backfill_job_id=?1 AND status='pending' AND (next_eligible_at IS NULL OR next_eligible_at<=?2)
       AND ((?3=1 AND collector_key='billing')
         OR (?3=0 AND collector_key!='billing' AND COALESCE(json_extract(scope_key,'$.persistenceRetry'),0)=0)
         OR (?3=2 AND collector_key!='billing' AND json_extract(scope_key,'$.persistenceRetry')=1))
     ORDER BY CASE WHEN json_extract(scope_key,'$.persistenceRetry')=1 THEN 0 ELSE 1 END,
       CASE WHEN COALESCE(json_array_length(json_extract(scope_key,'$.zoneIds')),0)=0 THEN 0 ELSE 1 END,
       ends_at DESC,collector_key LIMIT 100`,
  ).bind(jobId, Date.now(), modeCode).all<InitialSliceRow>();
  budget.charge("d1RowsRead", candidates.results.length);
  let slice: InitialSliceRow | undefined;
  let metadata: InitialIngestionSliceMetadata | undefined;
  let earliestAdmission: number | null | undefined;
  for (const candidate of candidates.results) {
    const parsed = parseSliceMetadata(candidate.scope_key, candidate.starts_at, candidate.ends_at);
    if (mode !== "billing") {
      const admission = quota.claimAdmission(rateScope(parsed), 1, parsed.zoneIds);
      if (admission.kind === "quota") continue;
      if (admission.kind === "paced") {
        if (admission.waitUntil === null) earliestAdmission ??= null;
        else if (earliestAdmission !== null) {
          earliestAdmission = Math.min(earliestAdmission ?? Number.POSITIVE_INFINITY, admission.waitUntil);
        }
        continue;
      }
    }
    slice = candidate;
    metadata = parsed;
    break;
  }
  if (!slice || !metadata) {
    if (earliestAdmission === undefined) return null;
    if (earliestAdmission !== null
      && earliestAdmission - Date.now() > Math.max(0, budget.remaining("wallMs") - 5_000)) return null;
    return { waitUntil: earliestAdmission };
  }
  const requiredQueries = slice.collector_key === "billing" ? 0 : 1;
  if (budget.remaining("backfillSlices") < 1
    || budget.remaining("d1RowsWritten") < INITIAL_D1_WRITE_RESERVATION + 1
    || budget.remaining("d1RowsRead") < INITIAL_D1_READ_RESERVATION
    || budget.remaining("wallMs") < 8_000
    || budget.remaining("graphqlQueries") < requiredQueries
    || slice.collector_key === "billing" && budget.remaining("restRequests") < BILLING_REQUESTS_PER_SLICE) return null;

  budget.charge("backfillSlices");
  const claimed = await env.DB.prepare(
    `UPDATE backfill_slices SET status='running',updated_at=?2 WHERE id=?1 AND status='pending'`,
  ).bind(slice.id, Date.now()).run();
  chargeMeta(budget, claimed.meta);
  // Several producers can observe the same pending row before one wins the
  // conditional update. Retry the selection so each producer can claim work.
  if (Number(claimed.meta.changes ?? 0) !== 1) {
    // The slice budget represents owned slices, so a failed conditional claim
    // must not consume one of the bounded work units.
    budget.refund("backfillSlices");
    return claimInitialSlice(env, budget, quota, jobId, mode);
  }
  await env.DB.prepare(`UPDATE backfill_jobs SET status='running',updated_at=?2 WHERE id=?1`).bind(jobId, Date.now()).run();
  const persistenceReservation = mode !== "billing"
    ? { reads: INITIAL_D1_READ_RESERVATION, writes: INITIAL_D1_WRITE_RESERVATION }
    : null;
  if (persistenceReservation) {
    budget.charge("d1RowsRead", persistenceReservation.reads);
    budget.charge("d1RowsWritten", persistenceReservation.writes);
  }
  const claimedRateScope = mode === "billing" ? null : rateScope(metadata);
  if (claimedRateScope) quota.reserveClaim(claimedRateScope);
  return { slice, metadata, persistenceReservation, rateScope: claimedRateScope };
}

async function fetchInitialSlice(
  env: Env,
  client: CloudflareClient,
  budget: LedgerRunBudget,
  quota: InitialGraphqlQuota,
  claimed: ClaimedInitialSlice,
  timeZone: string,
): Promise<InitialSliceFetch> {
  const { slice, metadata } = claimed;
  try {
    if (slice.collector_key === "billing") {
      const billing = await ingestWindow({
        env, client, ledger: new LedgerStore(env.DB, budget), collector: "billing",
        startsAt: slice.starts_at, endsAt: slice.ends_at, budget, timeZone, historical: true,
      });
      if (!billing.complete) throw new Error(billing.coverage[0]?.detail ?? "Billing history was incomplete");
      return { claimed, billing };
    }
    return {
      claimed,
      usage: await client.historicalUsage({
        dataset: metadata.dataset,
        startsAt: slice.starts_at,
        endsAt: slice.ends_at,
        maxPageSize: metadata.maxPageSize,
        zoneIds: metadata.zoneIds,
      }),
    };
  } catch (error) {
    return { claimed, error };
  } finally {
    if (claimed.rateScope) quota.releaseClaim(claimed.rateScope);
  }
}

async function finalizeInitialSlice(
  env: Env,
  ledger: LedgerStore,
  budget: LedgerRunBudget,
  jobId: string,
  timeZone: string,
  claimed: ClaimedInitialSlice,
  fetched: InitialSliceFetch,
): Promise<boolean> {
  const slice = claimed.slice;
  const metadata = claimed.metadata;
  const budgetAbortedAtEntry = budget.signal.aborted;
  releasePersistenceReservation(budget, claimed);
  try {
    if (slice.collector_key === "billing") {
      if (fetched.error) throw fetched.error;
      await saveCoverageInterval(env.DB, {
        accountId: env.BROLLY_ACCOUNT_ID,
        dataset: "billable-usage",
        startsAt: slice.starts_at,
        endsAt: slice.ends_at,
        state: "measured",
      }, budget);
    } else {
      if (fetched.error) throw fetched.error;
      const result = fetched.usage;
      if (!result) throw new Error("Historical Analytics returned no result");
      if (result.zoneGaps?.length && metadata.zoneIds.length) {
        await splitZoneGapSlice(env.DB, env.BROLLY_ACCOUNT_ID, slice, metadata, result.zoneGaps, budget);
        await updateInitialJobStatus(env.DB, jobId, budget);
        return true;
      }
      if (!result.complete && calendarDays(slice.starts_at, slice.ends_at) > 1) {
        await splitSlice(env.DB, slice, metadata, "Cloudflare row limit", budget);
        await updateInitialJobStatus(env.DB, jobId, budget);
        return true;
      }
      const observations = expandUsageObservations(
        result.samples,
        result.collector,
        result.dataset,
        result.complete ? "complete" : "partial",
        { watermarkAt: slice.ends_at, historical: true },
      );
      await ledger.applyObservations(observations, timeZone);
      if (!result.complete) {
        const detail = "Cloudflare's row limit was reached for a single day; retained rows are marked partial";
        await saveDatasetSliceCoverage(env, slice, metadata, "partial", detail, budget);
        await markSliceTerminalGap(env.DB, slice, metadata, detail, budget);
        await finishSlice(env.DB, budget, slice.id, "failed", detail, "partial");
        await updateInitialJobStatus(env.DB, jobId, budget);
        return true;
      }
      await saveDatasetSliceCoverage(env, slice, metadata, "measured", undefined, budget);
    }
    await finishSlice(env.DB, budget, slice.id, "complete", null, "complete");
    await updateInitialJobStatus(env.DB, jobId, budget);
    return true;
  } catch (error) {
    if (isHistoricalRateLimitError(error)) {
      const now = Date.now();
      await env.DB.prepare(
        `UPDATE backfill_slices SET status='pending',error=?2,next_eligible_at=?3,
          coverage_status='missing',updated_at=?4 WHERE id=?1`,
      ).bind(slice.id, error.message.slice(0, 2_000), Math.max(now + 1_000, error.retryAt), now).run();
      await updateInitialJobStatus(env.DB, jobId);
      return false;
    }
    if (error instanceof LedgerBudgetExceededError || error instanceof MonitoringBudgetExceededError) {
      const densityFailure = !budgetAbortedAtEntry
        && error instanceof LedgerBudgetExceededError
        && (error.kind === "d1RowsRead" || error.kind === "d1RowsWritten");
      if (!densityFailure) {
        const now = Date.now();
        await env.DB.prepare(
          `UPDATE backfill_slices SET status='pending',error=?2,next_eligible_at=?3,
             coverage_status='missing',updated_at=?4 WHERE id=?1`,
        ).bind(
          slice.id,
          `Deferred after the import run reached its bounded limit: ${error.message}`,
          now + 60_000,
          now,
        ).run();
        await updateInitialJobStatus(env.DB, jobId);
        return false;
      }
      if (metadata.persistenceRetry && calendarDays(slice.starts_at, slice.ends_at) > 1) {
        await splitSlice(env.DB, slice, metadata, "bounded persistence budget");
        await updateInitialJobStatus(env.DB, jobId);
        return false;
      }
      if (!metadata.persistenceRetry) {
        const now = Date.now();
        await env.DB.prepare(
          `UPDATE backfill_slices SET status='pending',scope_key=?2,error=?3,next_eligible_at=?4,
             coverage_status='missing',updated_at=?5 WHERE id=?1`,
        ).bind(
          slice.id,
          serializeMetadata({ ...metadata, persistenceRetry: true }),
          `Deferred after reaching a bounded persistence limit: ${error.message}`,
          now + 60_000,
          now,
        ).run();
        await updateInitialJobStatus(env.DB, jobId);
        return false;
      }
      const previous = Math.min(3, Number(slice.retry_count ?? 0));
      const failed = previous >= 3;
      const retryCount = failed ? 3 : previous + 1;
      if (failed) {
        await saveDatasetSliceCoverage(env, slice, metadata, "unavailable", error.message, budget);
        await markSliceTerminalGap(env.DB, slice, metadata, error.message);
      }
      await env.DB.prepare(
        `UPDATE backfill_slices SET status=?2,error=?3,retry_count=?4,next_eligible_at=?5,
           coverage_status=?6,updated_at=?7 WHERE id=?1`,
      ).bind(
        slice.id,
        failed ? "failed" : "pending",
        `${failed ? "Single-day import could not fit within" : "Deferred after reaching"} a bounded run limit: ${error.message}`,
        retryCount,
        failed ? null : Date.now() + 60_000,
        failed ? "partial" : "missing",
        Date.now(),
      ).run();
      await updateInitialJobStatus(env.DB, jobId);
      return false;
    }
    const previous = Math.min(3, Number(slice.retry_count ?? 0));
    const failed = previous >= 3;
    const retryCount = failed ? 3 : previous + 1;
    const nextEligibleAt = failed ? null : Date.now() + [30_000, 120_000, 480_000][retryCount - 1]!;
    if (failed) {
      await saveDatasetSliceCoverage(env, slice, metadata, "unavailable", errorMessage(error), budget);
      await markSliceTerminalGap(env.DB, slice, metadata, errorMessage(error), budget);
    }
    const result = await env.DB.prepare(
      `UPDATE backfill_slices SET status=?2,error=?3,retry_count=?4,next_eligible_at=?5,coverage_status='missing',updated_at=?6 WHERE id=?1`,
    ).bind(slice.id, failed ? "failed" : "pending", errorMessage(error).slice(0, 2_000), retryCount, nextEligibleAt, Date.now()).run();
    chargeMeta(budget, result.meta);
    await updateInitialJobStatus(env.DB, jobId, budget);
    return true;
  }
}

async function splitZoneGapSlice(
  db: D1Database,
  accountId: string,
  slice: InitialSliceRow,
  metadata: InitialIngestionSliceMetadata,
  gaps: NonNullable<Awaited<ReturnType<CloudflareClient["historicalUsage"]>>["zoneGaps"]>,
  budget?: LedgerRunBudget,
): Promise<void> {
  const gapByZone = new Map(gaps.map(gap => [gap.zoneId, gap]));
  const availableZoneIds = metadata.zoneIds.filter(zoneId => !gapByZone.has(zoneId));
  const now = Date.now();
  const days = calendarDays(slice.starts_at, slice.ends_at);
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE backfill_slices SET status='superseded',error=?2,updated_at=?3 WHERE id=?1`)
      .bind(slice.id, "Zone availability changed during import; isolated unavailable partitions", now),
  ];
  if (availableZoneIds.length) statements.push(db.prepare(
    `INSERT INTO backfill_slices(
       id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,next_eligible_at,coverage_status,error,updated_at
     ) VALUES(?1,?2,?3,?4,?5,?6,'pending',0,?7,'missing',NULL,?7)`,
  ).bind(
    crypto.randomUUID(), slice.backfill_job_id, slice.collector_key,
    serializeMetadata({ ...metadata, zoneIds: availableZoneIds, units: days * availableZoneIds.length }),
    slice.starts_at, slice.ends_at, now,
  ));
  for (const gap of gaps) statements.push(db.prepare(
    `INSERT INTO backfill_slices(
       id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,next_eligible_at,coverage_status,error,updated_at
     ) VALUES(?1,?2,?3,?4,?5,?6,?7,0,?8,'missing',?9,?10)`,
  ).bind(
    crypto.randomUUID(), slice.backfill_job_id, slice.collector_key,
    serializeMetadata({
      ...metadata,
      zoneIds: [gap.zoneId],
      units: days,
      availability: gap.state === "delayed" ? "available" : "unavailable",
      terminalGap: gap.state === "delayed" ? undefined : true,
    }),
    slice.starts_at,
    slice.ends_at,
    gap.state === "delayed" ? "pending" : "failed",
    gap.state === "delayed" ? Math.max(now + 1_000, gap.retryAt ?? now + GRAPHQL_WINDOW_MS) : null,
    `${metadata.dataset}: ${gap.detail}`,
    now,
  ));
  const results = await db.batch(statements);
  if (budget) for (const result of results) chargeMeta(budget, result.meta);
  for (const gap of gaps.filter(item => item.state !== "delayed")) await saveCoverageInterval(db, {
    accountId,
    dataset: metadata.dataset,
    scopeKey: gap.zoneId,
    startsAt: slice.starts_at,
    endsAt: slice.ends_at,
    state: "unavailable",
    reason: gap.detail,
    recordedAt: now,
  }, budget);
}

function releasePersistenceReservation(budget: LedgerRunBudget, claimed: ClaimedInitialSlice): void {
  const reservation = claimed.persistenceReservation;
  if (!reservation) return;
  budget.refund("d1RowsRead", reservation.reads);
  budget.refund("d1RowsWritten", reservation.writes);
  claimed.persistenceReservation = null;
}

async function splitSlice(
  db: D1Database,
  slice: InitialSliceRow,
  metadata: InitialIngestionSliceMetadata,
  reason: string,
  budget?: LedgerRunBudget,
): Promise<void> {
  const children = bisectInitialIngestionRange(slice.starts_at, slice.ends_at, metadata.zoneIds.length);
  const now = Date.now();
  const results = await db.batch([
    db.prepare(`UPDATE backfill_slices SET status='superseded',error=?2,updated_at=?3 WHERE id=?1`)
      .bind(slice.id, `Range split after reaching the ${reason}`, now),
    ...children.map(({ startsAt, endsAt, units }) => db.prepare(
      `INSERT OR IGNORE INTO backfill_slices(
         id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,next_eligible_at,coverage_status,updated_at
       ) VALUES(?1,?2,?3,?4,?5,?6,'pending',0,?7,'missing',?7)`,
    ).bind(crypto.randomUUID(), slice.backfill_job_id, slice.collector_key, serializeMetadata({
      ...metadata,
      units,
      persistenceRetry: undefined,
    }), startsAt, endsAt, now)),
  ]);
  if (budget) for (const result of results) chargeMeta(budget, result.meta);
}

/** Split a dense range while preserving its exact progress denominator. */
export function bisectInitialIngestionRange(
  startsAt: number,
  endsAt: number,
  partitions: number,
): Array<{ startsAt: number; endsAt: number; units: number }> {
  const middle = splitPoint(startsAt, endsAt);
  const multiplier = Math.max(1, partitions);
  const bounds = [[startsAt, middle], [middle, endsAt]] as const;
  return bounds.map(([start, end]) => ({
    startsAt: start,
    endsAt: end,
    units: calendarDays(start, end) * multiplier,
  }));
}

async function finishSlice(db: D1Database, budget: LedgerRunBudget, id: string, status: string, error: string | null, coverage: string): Promise<void> {
  const result = await db.prepare(
    `UPDATE backfill_slices SET status=?2,error=?3,next_eligible_at=NULL,coverage_status=?4,updated_at=?5 WHERE id=?1`,
  ).bind(id, status, error, coverage, Date.now()).run();
  chargeMeta(budget, result.meta);
}

async function markSliceTerminalGap(
  db: D1Database,
  slice: InitialSliceRow,
  metadata: InitialIngestionSliceMetadata,
  reason: string,
  budget?: LedgerRunBudget,
): Promise<void> {
  const result = await db.prepare(
    `UPDATE backfill_slices SET scope_key=?2,error=COALESCE(error,?3),updated_at=?4 WHERE id=?1`,
  ).bind(
    slice.id,
    serializeMetadata({ ...metadata, availability: metadata.availability ?? "available", terminalGap: true }),
    reason.slice(0, 2_000),
    Date.now(),
  ).run();
  if (budget) chargeMeta(budget, result.meta);
}

async function updateInitialJobStatus(db: D1Database, jobId: string, budget?: LedgerRunBudget): Promise<void> {
  const result = await db.prepare(
    `UPDATE backfill_jobs SET status=CASE
       WHEN EXISTS(SELECT 1 FROM backfill_slices WHERE backfill_job_id=?1 AND status IN ('pending','running')) THEN 'running'
       WHEN EXISTS(SELECT 1 FROM backfill_slices WHERE backfill_job_id=?1 AND status='failed') THEN 'complete_with_gaps'
       ELSE 'complete' END,
       updated_at=?2 WHERE id=?1`,
  ).bind(jobId, Date.now()).run();
  if (budget) chargeMeta(budget, result.meta);
}

function rangeSlices(collector: string, dataset: string, zoneIds: string[], now: number, setting: HistoricalDatasetCapability): InitialIngestionSlicePlan[] {
  const retentionDays = Math.max(1, Math.min(HISTORY_DAYS, Math.floor(setting.notOlderThanSeconds / 86_400)));
  const maxDays = Math.max(1, Math.floor(setting.maxDurationSeconds / 86_400));
  const ranges = boundedRanges(collector, dataset, zoneIds, now, retentionDays, maxDays, setting.maxPageSize);
  if (retentionDays >= HISTORY_DAYS) return ranges;
  const requestedStart = historyStart(now, HISTORY_DAYS);
  const availableStart = historyStart(now, retentionDays);
  return [gapRange(collector, dataset, zoneIds, requestedStart, availableStart,
    `Cloudflare retains ${retentionDays} days for this dataset.`, true), ...ranges];
}

function initialIngestionDays(
  job: { kind: string; requested_start_at: number; requested_end_at: number },
  rows: Array<{ scope_key: string; starts_at: number; ends_at: number; status: string; error: string | null }>,
): InitialIngestionProgress["days"] {
  const end = job.requested_end_at;
  const requestedStart = startOfUtcDay(job.requested_start_at);
  const latestStart = startOfUtcDay(end) - 89 * DAY_MS;
  const start = Math.max(requestedStart, latestStart);
  const total = Math.max(1, Math.min(90, Math.ceil((end - start) / DAY_MS)));
  let complete = 0;
  let pending = 0;
  let gaps = 0;
  const errors: string[] = [];
  let failedWindows = 0;

  for (const row of rows) {
    if (row.status !== "failed") continue;
    failedWindows += 1;
    if (row.error && !errors.includes(row.error) && errors.length < 3) errors.push(row.error);
  }

  for (let offset = 0; offset < total; offset += 1) {
    const dayStart = start + offset * DAY_MS;
    const dayEnd = Math.min(end, dayStart + DAY_MS);
    const overlapping = rows.filter(row => row.starts_at < dayEnd && row.ends_at > dayStart);
    const parsed = overlapping.map(row => ({ row, metadata: parseSliceMetadata(row.scope_key, row.starts_at, row.ends_at) }));
    if (parsed.length === 0) {
      gaps += 1;
      continue;
    }
    const terminalGaps = parsed.filter(({ row, metadata }) => metadata.terminalGap || row.status === "failed");
    if (terminalGaps.length) gaps += 1;
    const available = parsed.filter(({ row, metadata }) => metadata.availability !== "unavailable" || row.status !== "failed");
    const active = available.some(({ row }) => row.status === "pending" || row.status === "running");
    const failed = available.some(({ row }) => row.status === "failed");
    if (active) pending += 1;
    else if (!failed) complete += 1;
  }

  return { total, complete, pending, gaps, failedWindows, errors };
}

function emptyInitialIngestionReadiness(): InitialIngestionReadiness {
  return { billing: "pending", account: "pending", products: {} };
}

function initialIngestionReadiness(
  jobStatus: string,
  rows: Array<{ collector_key: string; scope_key: string; starts_at: number; ends_at: number; status: string; error: string | null }>,
): InitialIngestionReadiness {
  const parsedRows = rows.map(row => ({ row, metadata: parseSliceMetadata(row.scope_key, row.starts_at, row.ends_at) }));
  const activeJob = jobStatus === "planning" || jobStatus === "pending" || jobStatus === "running";
  const billingRows = parsedRows.filter(item => item.row.collector_key === "billing");
  const billingActive = billingRows.length === 0 || billingRows.some(item => item.row.status === "pending" || item.row.status === "running");
  const billingUsable = billingRows.some(item => item.row.status === "complete" && item.metadata.availability !== "unavailable");
  const billing = billingActive ? "pending" : billingUsable ? "ready" : "unavailable";
  const specByDataset = new Map(HISTORICAL_DATASETS.map(spec => [spec.dataset, spec]));
  const accountRows = parsedRows.filter(item => specByDataset.get(item.metadata.dataset)?.root === "account");
  const accountActive = accountRows.some(item => item.row.status === "pending" || item.row.status === "running")
    || accountRows.length === 0 && activeJob;
  const accountUsable = accountRows.some(item => item.row.status === "complete"
    && item.metadata.availability !== "unavailable"
    && !item.metadata.expectedGap);
  const accountUnexpected = accountRows.some(item => !item.metadata.expectedGap
    && (item.row.status === "failed" || item.metadata.terminalGap));
  const account = billing === "pending" || accountActive
    ? "pending"
    : accountUsable && !accountUnexpected
      ? "ready"
      : "limited";
  const families = [...new Set(HISTORICAL_DATASETS.map(spec => spec.family))];
  const rowsByFamily = new Map<string, typeof parsedRows>();
  for (const item of parsedRows) {
    const family = specByDataset.get(item.metadata.dataset)?.family;
    if (!family) continue;
    const familyRows = rowsByFamily.get(family) ?? [];
    familyRows.push(item);
    rowsByFamily.set(family, familyRows);
  }
  const products: InitialIngestionReadiness["products"] = {};

  for (const family of families) {
    const parsed = rowsByFamily.get(family) ?? [];
    const totalUnits = parsed.reduce((sum, item) => sum + item.metadata.units, 0);
    const processedUnits = parsed.reduce((sum, item) => (
      item.row.status === "complete" || item.row.status === "failed" ? sum + item.metadata.units : sum
    ), 0);
    const active = parsed.some(item => item.row.status === "pending" || item.row.status === "running");
    const usable = parsed.some(item => item.row.status === "complete"
      && item.metadata.availability !== "unavailable"
      && !item.metadata.expectedGap);
    const unexpected = parsed.filter(item => !item.metadata.expectedGap
      && (item.row.status === "failed" || item.metadata.terminalGap));
    const state: InitialIngestionReadinessState = active || parsed.length === 0 && activeJob
      ? "importing"
      : usable && unexpected.length > 0
        ? "limited"
        : usable
          ? "ready"
          : "unavailable";
    products[family] = {
      state,
      percent: totalUnits > 0 ? Math.round(Math.min(totalUnits, processedUnits) / totalUnits * 100) : state === "importing" ? 0 : 100,
      errors: unexpected.length,
    };
  }

  return { billing, account, products };
}

function boundedRanges(collector: string, dataset: string, zoneIds: string[], now: number, retentionDays: number, maxDays: number, maxPageSize: number): InitialIngestionSlicePlan[] {
  const startsAt = startOfUtcDay(now) - (retentionDays - 1) * DAY_MS;
  const slices: InitialIngestionSlicePlan[] = [];
  for (let end = now; end > startsAt;) {
    const start = Math.max(startsAt, startOfUtcDay(end) - (maxDays - (end === startOfUtcDay(end) ? 0 : 1)) * DAY_MS);
    const safeStart = start >= end ? Math.max(startsAt, end - DAY_MS) : start;
    const units = calendarDays(safeStart, end) * Math.max(1, zoneIds.length);
    slices.push({
      collector,
      startsAt: safeStart,
      endsAt: end,
      scopeKey: serializeMetadata({ version: 2, dataset, zoneIds, maxPageSize, units, availability: "available" }),
      status: "pending",
      coverageStatus: "missing",
      error: null,
    });
    end = safeStart;
  }
  return slices;
}

function gapSlice(
  collector: string,
  dataset: string,
  zoneIds: string[],
  now: number,
  detail: string,
  _retentionDays: number,
): InitialIngestionSlicePlan {
  return gapRange(collector, dataset, zoneIds, historyStart(now, HISTORY_DAYS), now, detail);
}

function gapRange(
  collector: string,
  dataset: string,
  zoneIds: string[],
  startsAt: number,
  endsAt: number,
  detail: string,
  expected = false,
): InitialIngestionSlicePlan {
  return {
    collector,
    startsAt,
    endsAt,
    scopeKey: serializeMetadata({
      version: 2, dataset, zoneIds, maxPageSize: 10_000,
      units: calendarDays(startsAt, endsAt) * Math.max(1, zoneIds.length),
      availability: "unavailable", terminalGap: !expected, expectedGap: expected,
    }),
    status: expected ? "complete" : "failed",
    coverageStatus: "missing",
    error: `${dataset}: ${detail}`,
  };
}

async function saveDatasetSliceCoverage(
  env: Env,
  slice: InitialSliceRow,
  metadata: InitialIngestionSliceMetadata,
  state: "measured" | "partial" | "unavailable",
  reason: string | undefined,
  budget: LedgerRunBudget,
): Promise<void> {
  await saveCoverageIntervals(env.DB, (metadata.zoneIds.length ? metadata.zoneIds : [""]).map(scopeKey => ({
    accountId: env.BROLLY_ACCOUNT_ID,
    dataset: metadata.dataset,
    scopeKey,
    startsAt: slice.starts_at,
    endsAt: slice.ends_at,
    state,
    reason,
  })), budget);
}

function parseSliceMetadata(value: string, startsAt: number, endsAt: number): InitialIngestionSliceMetadata {
  try {
    const parsed = JSON.parse(value) as Partial<InitialIngestionSliceMetadata>;
    if (parsed.version === 2 && typeof parsed.dataset === "string") {
      return {
        version: 2,
        dataset: parsed.dataset,
        zoneIds: Array.isArray(parsed.zoneIds) ? parsed.zoneIds.filter(item => typeof item === "string") : [],
        maxPageSize: Number.isFinite(parsed.maxPageSize) ? Number(parsed.maxPageSize) : 10_000,
        units: Number.isFinite(parsed.units) ? Number(parsed.units) : calendarDays(startsAt, endsAt),
        availability: parsed.availability === "unavailable" ? "unavailable" : parsed.availability === "available" ? "available" : undefined,
        terminalGap: parsed.terminalGap === true,
        expectedGap: parsed.expectedGap === true,
        persistenceRetry: parsed.persistenceRetry === true,
      };
    }
  } catch {
    // Legacy slices use an empty scope key and are reported by duration.
  }
  return { version: 2, dataset: "unknown", zoneIds: [], maxPageSize: 10_000, units: calendarDays(startsAt, endsAt) };
}

function serializeMetadata(value: InitialIngestionSliceMetadata): string { return JSON.stringify(value); }
function sliceUnits(scopeKey: string, startsAt: number, endsAt: number): number { return parseSliceMetadata(scopeKey, startsAt, endsAt).units; }
function capabilityRetentionDays(setting: HistoricalDatasetCapability | undefined, fallback: number): number {
  return Math.max(1, Math.min(HISTORY_DAYS, Math.floor((setting?.notOlderThanSeconds ?? fallback * 86_400) / 86_400)));
}
function historyStart(now: number, days = HISTORY_DAYS): number {
  const dayStart = startOfUtcDay(now);
  return dayStart - (days - (now === dayStart ? 0 : 1)) * DAY_MS;
}
function startOfUtcDay(timestamp: number): number { const date = new Date(timestamp); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()); }
function calendarDays(startsAt: number, endsAt: number): number { return Math.max(1, Math.ceil((endsAt - startOfUtcDay(startsAt)) / DAY_MS)); }
function splitPoint(startsAt: number, endsAt: number): number {
  const days = calendarDays(startsAt, endsAt);
  return Math.min(endsAt - 1, startsAt + Math.max(1, Math.floor(days / 2)) * DAY_MS);
}
function collectorLabel(collector: string): string {
  if (collector === "billing") return "Billing";
  return HISTORICAL_DATASETS.find(item => item.collector === collector)?.label ?? collector;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function chargeMeta(budget: LedgerRunBudget, meta: { rows_read?: number; rows_written?: number; changes?: number }): void {
  budget.charge("d1RowsRead", meta.rows_read ?? 0);
  budget.charge("d1RowsWritten", meta.rows_written ?? meta.changes ?? 0);
}

interface InitialGraphqlQuotaState {
  jobId: string;
  limiterMode: "shared-paced" | "shared-fallback";
  adaptiveLimit: number | null;
  windowStartedAt: number;
  physicalUsed: number;
  sharedUsed: number;
  accountUsed: number;
  zoneUsed: Record<string, number>;
  accountLastAdmissionAt: number | null;
  zoneLastAdmissionAt: Record<string, number>;
  sharedNextAdmissionAt: number | null;
  pausedUntil: number | null;
  accountPausedUntil: number | null;
  zonePausedUntil: Record<string, number>;
}

class InitialGraphqlQuota implements HistoricalRateBudget {
  private readonly inFlightClaims = new Set<string>();
  private readonly admissionTails = new Map<string, Promise<void>>();
  private readonly claimWaiters = new Set<() => void>();

  constructor(
    private readonly state: InitialGraphqlQuotaState,
    private readonly baseSharedLimit: number,
  ) {}

  get physicalRemaining(): number {
    this.rollover();
    if (this.state.pausedUntil && Date.now() < this.state.pausedUntil) return 0;
    const physical = Math.max(0, INITIAL_PHYSICAL_GRAPHQL_QUOTA - this.state.physicalUsed);
    return this.state.sharedUsed < this.activeSharedLimit ? physical : 0;
  }

  get logicalRemaining(): number {
    this.rollover();
    return Math.max(0, this.activeSharedLimit - this.state.sharedUsed);
  }

  get windowStartedAt(): number { return this.state.windowStartedAt; }
  get physicalUsed(): number { return this.state.physicalUsed; }
  get logicalUsed(): number { return this.state.sharedUsed; }

  get resetAt(): number {
    return Math.max(this.state.windowStartedAt + GRAPHQL_WINDOW_MS, this.state.pausedUntil ?? 0);
  }

  canCharge(scope: HistoricalRateScope, logicalQueries: number): boolean {
    this.rollover();
    if (this.physicalRemaining < 1) return false;
    const amount = Math.max(1, Math.floor(logicalQueries));
    void scope;
    return this.state.sharedUsed + amount <= this.activeSharedLimit;
  }

  claimAdmission(scope: HistoricalRateScope, logicalQueries: number, zoneIds: readonly string[] = []):
    | { kind: "ready" }
    | { kind: "paced"; waitUntil: number | null }
    | { kind: "quota" } {
    this.rollover();
    const scopePause = Math.max(
      this.scopePausedUntil(scope) ?? 0,
      ...zoneIds.map(zoneId => this.state.zonePausedUntil[zoneId] ?? 0),
    );
    if (scopePause && scopePause > Date.now()) return { kind: "paced", waitUntil: scopePause };
    if (!this.canCharge(scope, logicalQueries)) return { kind: "quota" };
    const key = "shared";
    if (this.inFlightClaims.has(key)) return { kind: "paced", waitUntil: null };
    const waitUntil = Math.max(
      this.lastAdmissionAt(scope) + GRAPHQL_SCOPE_INTERVAL_MS,
      this.state.sharedNextAdmissionAt ?? 0,
    );
    return waitUntil > Date.now() ? { kind: "paced", waitUntil } : { kind: "ready" };
  }

  reserveClaim(scope: HistoricalRateScope): void {
    void scope;
    this.inFlightClaims.add("shared");
  }

  releaseClaim(scope: HistoricalRateScope): void {
    this.inFlightClaims.delete(rateScopeKey(scope));
    this.inFlightClaims.delete("shared");
    for (const resolve of this.claimWaiters) resolve();
    this.claimWaiters.clear();
  }

  async waitForClaim(waitUntil: number | null, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.claimWaiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      signal.addEventListener("abort", done, { once: true });
      if (waitUntil === null) {
        this.claimWaiters.add(done);
        timer = setTimeout(done, GRAPHQL_SCOPE_INTERVAL_MS);
      } else timer = setTimeout(done, Math.max(1, waitUntil - Date.now()));
    });
  }

  async admit(scope: HistoricalRateScope, logicalQueries: number): Promise<void> {
    const key = "shared";
    const previous = this.admissionTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => gate);
    this.admissionTails.set(key, queued);
    await previous;
    try {
      const delay = Math.max(
        this.lastAdmissionAt(scope) + GRAPHQL_SCOPE_INTERVAL_MS,
        this.state.sharedNextAdmissionAt ?? 0,
      ) - Date.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      this.setLastAdmissionAt(scope, Date.now());
      this.charge(scope, logicalQueries);
    } finally {
      release();
      if (this.admissionTails.get(key) === queued) this.admissionTails.delete(key);
    }
  }

  pauseUntil(retryAt: number, scope: HistoricalRateScope | null): void {
    const until = Math.max(Date.now() + 1_000, retryAt);
    if (scope?.kind === "account") {
      this.state.accountPausedUntil = Math.max(this.state.accountPausedUntil ?? 0, until);
    } else if (scope?.kind === "zone") {
      this.state.zonePausedUntil[scope.zoneId] = Math.max(this.state.zonePausedUntil[scope.zoneId] ?? 0, until);
    } else {
      this.state.pausedUntil = Math.max(this.state.pausedUntil ?? 0, until);
      this.state.limiterMode = "shared-fallback";
      this.state.adaptiveLimit = Math.max(
        MIN_ADAPTIVE_SHARED_QUERY_QUOTA,
        Math.min(this.baseSharedLimit, Math.floor(this.state.sharedUsed * 0.8)),
      );
      this.state.sharedUsed = this.activeSharedLimit;
    }
    for (const resolve of this.claimWaiters) resolve();
    this.claimWaiters.clear();
  }

  charge(scope: HistoricalRateScope, logicalQueries: number): void {
    if (!this.canCharge(scope, logicalQueries)) {
      throw new HistoricalRateLimitError(429, Math.max(Date.now() + 1_000, this.resetAt), "Initial Analytics quota is reserved until the next Cloudflare window");
    }
    const amount = Math.max(1, Math.floor(logicalQueries));
    this.state.physicalUsed += 1;
    this.state.sharedUsed += amount;
    this.state.sharedNextAdmissionAt = Date.now() + GRAPHQL_SCOPE_INTERVAL_MS;
    if (scope.kind === "account") this.state.accountUsed += amount;
    else this.state.zoneUsed[scope.zoneId] = (this.state.zoneUsed[scope.zoneId] ?? 0) + amount;
  }

  snapshot(): InitialGraphqlQuotaState {
    return {
      jobId: this.state.jobId,
      limiterMode: this.state.limiterMode,
      adaptiveLimit: this.state.adaptiveLimit,
      windowStartedAt: this.state.windowStartedAt,
      physicalUsed: this.state.physicalUsed,
      sharedUsed: this.state.sharedUsed,
      accountUsed: this.state.accountUsed,
      zoneUsed: { ...this.state.zoneUsed },
      accountLastAdmissionAt: this.state.accountLastAdmissionAt,
      zoneLastAdmissionAt: { ...this.state.zoneLastAdmissionAt },
      sharedNextAdmissionAt: this.state.sharedNextAdmissionAt,
      pausedUntil: this.state.pausedUntil,
      accountPausedUntil: this.state.accountPausedUntil,
      zonePausedUntil: { ...this.state.zonePausedUntil },
    };
  }

  get mode(): InitialGraphqlQuotaState["limiterMode"] { return this.state.limiterMode; }
  get fallbackLimit(): number { return this.activeSharedLimit; }

  get resumeAt(): number | null {
    this.rollover();
    if (this.state.pausedUntil && this.state.pausedUntil > Date.now()) return this.state.pausedUntil;
    if (this.state.sharedUsed >= this.activeSharedLimit) {
      return this.state.windowStartedAt + GRAPHQL_WINDOW_MS;
    }
    return null;
  }

  private lastAdmissionAt(scope: HistoricalRateScope): number {
    return scope.kind === "account"
      ? this.state.accountLastAdmissionAt ?? 0
      : this.state.zoneLastAdmissionAt[scope.zoneId] ?? 0;
  }

  private setLastAdmissionAt(scope: HistoricalRateScope, admittedAt: number): void {
    if (scope.kind === "account") this.state.accountLastAdmissionAt = admittedAt;
    else this.state.zoneLastAdmissionAt[scope.zoneId] = admittedAt;
  }

  private scopePausedUntil(scope: HistoricalRateScope): number | null {
    return scope.kind === "account"
      ? this.state.accountPausedUntil
      : this.state.zonePausedUntil[scope.zoneId] ?? null;
  }

  private rollover(now = Date.now()): void {
    if (this.state.pausedUntil && now < this.state.pausedUntil) return;
    this.state.pausedUntil = null;
    if (now >= this.state.windowStartedAt && now - this.state.windowStartedAt < GRAPHQL_WINDOW_MS) return;
    this.state.windowStartedAt = now;
    this.state.physicalUsed = 0;
    this.state.sharedUsed = 0;
    this.state.accountUsed = 0;
    this.state.zoneUsed = {};
    this.state.sharedNextAdmissionAt = null;
  }

  private get activeSharedLimit(): number {
    return this.state.limiterMode === "shared-fallback" && this.state.adaptiveLimit
      ? Math.min(this.baseSharedLimit, this.state.adaptiveLimit)
      : this.baseSharedLimit;
  }
}

function rateScopeKey(scope: HistoricalRateScope): string {
  return scope.kind === "account" ? "account" : `zone:${scope.zoneId}`;
}

function rateScope(metadata: InitialIngestionSliceMetadata): HistoricalRateScope {
  void metadata;
  return { kind: "account" };
}

async function loadInitialCapabilities(
  db: D1Database,
  jobId: string,
  budget: LedgerRunBudget,
): Promise<HistoricalDatasetCapability[]> {
  const row = await db.prepare(`SELECT value FROM settings WHERE key=?1 LIMIT 1`)
    .bind(`${INITIAL_CAPABILITY_KEY_PREFIX}${jobId}`).first<{ value: string }>();
  budget.charge("d1RowsRead");
  if (!row) return [];
  try {
    const values = JSON.parse(row.value) as unknown;
    return Array.isArray(values) ? values.filter(isCachedHistoricalCapability) : [];
  } catch {
    return [];
  }
}

async function saveInitialCapabilities(
  db: D1Database,
  jobId: string,
  capabilities: readonly HistoricalDatasetCapability[],
  budget: LedgerRunBudget,
): Promise<void> {
  const result = await db.prepare(
    `INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  ).bind(
    `${INITIAL_CAPABILITY_KEY_PREFIX}${jobId}`,
    JSON.stringify(capabilities),
    Date.now(),
  ).run();
  chargeMeta(budget, result.meta);
}

function isCachedHistoricalCapability(value: unknown): value is HistoricalDatasetCapability {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HistoricalDatasetCapability>;
  return typeof candidate.collector === "string"
    && typeof candidate.label === "string"
    && typeof candidate.dataset === "string"
    && typeof candidate.family === "string"
    && (candidate.root === "account" || candidate.root === "zone")
    && (candidate.zoneId === null || typeof candidate.zoneId === "string")
    && typeof candidate.applicable === "boolean"
    && typeof candidate.enabled === "boolean"
    && Number.isFinite(candidate.maxDurationSeconds)
    && Number.isFinite(candidate.notOlderThanSeconds)
    && Number.isFinite(candidate.maxPageSize)
    && typeof candidate.state === "string"
    && typeof candidate.detail === "string";
}

async function loadInitialGraphqlQuota(db: D1Database, accountId: string, jobId: string, now: number): Promise<InitialGraphqlQuota> {
  const [row, onboarding] = await Promise.all([
    db.prepare(`SELECT value FROM settings WHERE key=?1 LIMIT 1`)
      .bind(`${INITIAL_QUOTA_KEY_PREFIX}${accountId}`).first<{ value: string }>(),
    db.prepare(`SELECT value FROM settings WHERE key='onboarding_complete' LIMIT 1`).first<{ value: string }>(),
  ]);
  const sharedLimit = onboarding?.value === "true" ? CONFIGURED_SHARED_QUERY_QUOTA : INITIAL_SHARED_QUERY_QUOTA;
  let state: InitialGraphqlQuotaState = {
    jobId,
    limiterMode: "shared-paced",
    adaptiveLimit: null,
    windowStartedAt: now,
    physicalUsed: 0,
    sharedUsed: 0,
    accountUsed: 0,
    zoneUsed: {},
    accountLastAdmissionAt: null,
    zoneLastAdmissionAt: {},
    sharedNextAdmissionAt: null,
    pausedUntil: null,
    accountPausedUntil: null,
    zonePausedUntil: {},
  };
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as Partial<InitialGraphqlQuotaState> & { used?: number };
      const sameJob = parsed.jobId === jobId;
      state.limiterMode = sameJob && parsed.limiterMode === "shared-fallback" ? "shared-fallback" : "shared-paced";
      state.adaptiveLimit = sameJob && Number.isFinite(parsed.adaptiveLimit)
        ? Math.max(MIN_ADAPTIVE_SHARED_QUERY_QUOTA, Math.min(sharedLimit, Number(parsed.adaptiveLimit)))
        : null;
      const activeWindow = Number.isFinite(parsed.windowStartedAt)
        && now - Number(parsed.windowStartedAt) < GRAPHQL_WINDOW_MS && now >= Number(parsed.windowStartedAt);
      if (activeWindow) {
        const legacyUsed = Number.isFinite(parsed.used) ? Number(parsed.used) : 0;
        state.windowStartedAt = Number(parsed.windowStartedAt);
        state.physicalUsed = boundedUsage(parsed.physicalUsed ?? legacyUsed, INITIAL_PHYSICAL_GRAPHQL_QUOTA);
        state.sharedUsed = sameJob ? boundedUsage(parsed.sharedUsed, sharedLimit) : 0;
        state.accountUsed = boundedUsage(parsed.accountUsed ?? legacyUsed, sharedLimit);
        state.zoneUsed = Object.fromEntries(Object.entries(parsed.zoneUsed ?? {}).map(([zoneId, used]) => [
          zoneId,
          boundedUsage(used, sharedLimit),
        ]));
      }
      state.accountLastAdmissionAt = boundedAdmissionAt(parsed.accountLastAdmissionAt, now);
      state.zoneLastAdmissionAt = Object.fromEntries(Object.entries(parsed.zoneLastAdmissionAt ?? {}).flatMap(([zoneId, admittedAt]) => {
        const bounded = boundedAdmissionAt(admittedAt, now);
        return bounded === null ? [] : [[zoneId, bounded]];
      }));
      state.pausedUntil = Number.isFinite(parsed.pausedUntil) && Number(parsed.pausedUntil) > now
        ? Number(parsed.pausedUntil)
        : null;
      state.accountPausedUntil = boundedPauseAt(parsed.accountPausedUntil, now);
      state.zonePausedUntil = Object.fromEntries(Object.entries(parsed.zonePausedUntil ?? {}).flatMap(([zoneId, until]) => {
        const bounded = boundedPauseAt(until, now);
        return bounded === null ? [] : [[zoneId, bounded]];
      }));
      state.sharedNextAdmissionAt = boundedFutureAdmissionAt(parsed.sharedNextAdmissionAt, now);
    } catch {
      // Corrupt quota state starts a fresh bounded window.
    }
  }
  return new InitialGraphqlQuota(state, sharedLimit);
}

async function saveInitialGraphqlQuota(
  db: D1Database,
  accountId: string,
  quota: InitialGraphqlQuota,
): Promise<void> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  ).bind(
    `${INITIAL_QUOTA_KEY_PREFIX}${accountId}`,
    JSON.stringify(quota.snapshot()),
    now,
  ).run();
}

function boundedUsage(value: unknown, limit: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(limit, parsed)) : 0;
}

function boundedAdmissionAt(value: unknown, now: number): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed <= now && parsed > now - GRAPHQL_SCOPE_INTERVAL_MS ? parsed : null;
}

function boundedFutureAdmissionAt(value: unknown, now: number): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > now - GRAPHQL_SCOPE_INTERVAL_MS && parsed < now + GRAPHQL_WINDOW_MS ? parsed : null;
}

function boundedPauseAt(value: unknown, now: number): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > now ? parsed : null;
}

async function acquireInitialIngestionLease(db: D1Database, accountId: string, holder: string): Promise<boolean> {
  const now = Date.now();
  const result = await db.prepare(
    `INSERT INTO cron_lease(name,holder,expires_at) VALUES(?1,?2,?3)
     ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at
     WHERE cron_lease.expires_at<?4 OR cron_lease.holder=?2`,
  ).bind(`${INITIAL_LEASE_NAME}:${accountId}`, holder, now + INITIAL_LEASE_TTL_MS, now).run();
  return Number(result.meta.changes ?? 0) === 1;
}

async function releaseInitialIngestionLease(db: D1Database, accountId: string, holder: string): Promise<void> {
  await db.prepare(`DELETE FROM cron_lease WHERE name=?1 AND holder=?2`)
    .bind(`${INITIAL_LEASE_NAME}:${accountId}`, holder).run();
}

async function requeueRunningInitialSlices(db: D1Database, jobId: string): Promise<void> {
  const now = Date.now();
  await db.prepare(
    `UPDATE backfill_slices SET status='pending',next_eligible_at=?2,updated_at=?2
     WHERE backfill_job_id=?1 AND status='running'`,
  ).bind(jobId, now).run();
}

async function initialSlicesPending(db: D1Database, jobId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS pending FROM backfill_slices WHERE backfill_job_id=?1 AND status='pending'
       AND (next_eligible_at IS NULL OR next_eligible_at<=?2) LIMIT 1`,
  ).bind(jobId, Date.now()).first<{ pending: number }>();
  return Boolean(row);
}
async function initialJob(db: D1Database, accountId: string, kind: string): Promise<{ id: string; status: string; updatedAt: number } | null> {
  const row = await db.prepare(`SELECT id,status,updated_at FROM backfill_jobs WHERE account_id=?1 AND kind=?2 LIMIT 1`)
    .bind(accountId, kind).first<{ id: string; status: string; updated_at: number }>();
  return row ? { id: row.id, status: row.status, updatedAt: row.updated_at } : null;
}
async function sliceCount(db: D1Database, jobId: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM backfill_slices WHERE backfill_job_id=?1 AND status!='superseded'`).bind(jobId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}
function ingestionJobResult(job: { id: string; status: string }, created: boolean, slices: number): InitialIngestionJobResult {
  return { id: job.id, status: job.status, created, slices };
}
