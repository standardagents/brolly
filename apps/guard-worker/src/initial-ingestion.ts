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

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 90;
const BILLING_MAX_DAYS = 31;
const INITIAL_KIND = "initial_v2";
const LEGACY_INITIAL_KIND = "initial";
const INITIAL_FETCH_CONCURRENCY = 6;
const INITIAL_ACCOUNT_QUERY_QUOTA = 240;
const INITIAL_ZONE_QUERY_QUOTA = 240;
const INITIAL_PHYSICAL_GRAPHQL_QUOTA = 700;
const GRAPHQL_WINDOW_MS = 5 * 60_000;
const INITIAL_LEASE_TTL_MS = 120_000;
const INITIAL_LEASE_NAME = "initial-ingestion";
const BILLING_REQUESTS_PER_SLICE = 3;
const INITIAL_QUOTA_KEY_PREFIX = "initial_ingestion_quota:";
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
  status: "pending" | "failed";
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
  persistenceRetry?: boolean;
}

export interface InitialIngestionProgress {
  job: {
    id: string;
    status: string;
    startedAt: number;
    updatedAt: number;
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
    const discoveryQuota = await loadInitialGraphqlQuota(env.DB, env.BROLLY_ACCOUNT_ID, now);
    if (!discoveryQuota.canCharge({ kind: "account" }, 1)) {
      await env.DB.prepare(`UPDATE backfill_jobs SET status='planning',updated_at=?2 WHERE id=?1`).bind(jobId, now).run();
      return { id: jobId, created, status: "planning", slices: await sliceCount(env.DB, jobId) };
    }
    const discoveryLedger = new LedgerRunBudget({
      graphqlQueries: discoveryQuota.physicalRemaining,
      restRequests: 20,
      d1RowsRead: 1_000,
      d1RowsWritten: 1_000,
      backfillSlices: 1,
      wallMs: 45_000,
    });
    const discoveryBudget = new RunBudget({ apiCalls: 320, databaseRows: 2_000, samples: 1, wallMs: 45_000 });
    try {
      const capabilities = await new CloudflareClient(env, discoveryBudget, discoveryLedger, {
        accountBasedRateLimit: true,
        rateBudget: discoveryQuota,
      }).historicalCapabilities();
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
      await updateInitialJobStatus(env.DB, jobId);
    } finally {
      await saveInitialGraphqlQuota(env.DB, env.BROLLY_ACCOUNT_ID, discoveryQuota);
    }
  } catch (error) {
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
    for (const setting of enabled) {
      slices.push(...rangeSlices(spec.collector, spec.dataset, [setting.zoneId!], now, setting));
    }
    for (const setting of unavailable) {
      slices.push(gapSlice(
        spec.collector,
        spec.dataset,
        [setting.zoneId!],
        now,
        setting.detail ?? "Cloudflare denied access to this zone dataset.",
        capabilityRetentionDays(setting, spec.retentionDays),
      ));
    }
  }
  if (billingAvailable) slices.push(...boundedRanges("billing", "billable-usage", [], now, HISTORY_DAYS, BILLING_MAX_DAYS, 10_000));
  return slices.sort((left, right) => right.endsAt - left.endsAt || left.collector.localeCompare(right.collector));
}

/** Return progress weighted by dataset-days (and zone-days), not request count. */
export async function initialIngestionProgress(db: D1Database, accountId: string): Promise<InitialIngestionProgress> {
  const job = await db.prepare(
    `SELECT id,status,created_at,updated_at,kind,requested_start_at,requested_end_at FROM backfill_jobs
     WHERE account_id=?1 AND kind IN (?2,?3)
     ORDER BY CASE kind WHEN ?2 THEN 0 ELSE 1 END,created_at DESC LIMIT 1`,
  ).bind(accountId, INITIAL_KIND, LEGACY_INITIAL_KIND).first<{ id: string; status: string; created_at: number; updated_at: number; kind: string; requested_start_at: number; requested_end_at: number }>();
  if (!job) return { job: null, collectors: [], days: null };
  const rows = await db.prepare(
    `SELECT collector_key,scope_key,starts_at,ends_at,status,error
     FROM backfill_slices WHERE backfill_job_id=?1 AND status!='superseded'
     ORDER BY collector_key,ends_at DESC`,
  ).bind(job.id).all<{ collector_key: string; scope_key: string; starts_at: number; ends_at: number; status: string; error: string | null }>();
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
    job: { id: job.id, status: job.status, startedAt: job.created_at, updatedAt: job.updated_at },
    collectors: [...grouped.values()].sort((left, right) => left.collector === "billing" ? 1 : right.collector === "billing" ? -1 : left.label.localeCompare(right.label)),
    days: initialIngestionDays(job, rows.results),
  };
}

/** Drain bounded v2 slices with a fresh budget isolated from monitoring. */
export async function runInitialIngestion(env: Env, jobId: string): Promise<void> {
  const holder = crypto.randomUUID();
  if (!await acquireInitialIngestionLease(env.DB, env.BROLLY_ACCOUNT_ID, holder)) return;
  let quota: InitialGraphqlQuota;
  try {
    await requeueRunningInitialSlices(env.DB, jobId);
    quota = await loadInitialGraphqlQuota(env.DB, env.BROLLY_ACCOUNT_ID, Date.now());
  } catch (error) {
    await releaseInitialIngestionLease(env.DB, env.BROLLY_ACCOUNT_ID, holder);
    throw error;
  }
  if (quota.physicalRemaining < 1) {
    await releaseInitialIngestionLease(env.DB, env.BROLLY_ACCOUNT_ID, holder);
    return;
  }
  const ledgerBudget = new LedgerRunBudget(
    { ...INITIAL_INGESTION_LIMITS, graphqlQueries: quota.physicalRemaining },
    "initial_ingestion",
  );
  const budget = new RunBudget({
    apiCalls: quota.physicalRemaining + INITIAL_INGESTION_LIMITS.restRequests,
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

  try {
    // Give one persistence-retry slice the first D1 work of this invocation.
    // Other marked slices wait for later invocations so each split decision is
    // based on a fresh run budget.
    if (canStartInitialSlice(ledgerBudget)) {
      const persistenceProbe = await claimInitialSlice(env, ledgerBudget, quota, jobId, "persistence_retry");
      if (persistenceProbe) {
        await finalizeInitialSlice(
          env, ledger, ledgerBudget, jobId, timeZone, persistenceProbe,
          await fetchInitialSlice(env, client, ledgerBudget, persistenceProbe, timeZone),
        );
        if (ledgerBudget.signal.aborted) return;
      }
    }

    // Billing reconciliation performs D1 writes during collection. Finish its
    // due slices before starting the parallel Analytics producer pool.
    while (canStartInitialSlice(ledgerBudget)) {
      const claimed = await claimInitialSlice(env, ledgerBudget, quota, jobId, "billing");
      if (!claimed) break;
      await finalizeInitialSlice(
        env, ledger, ledgerBudget, jobId, timeZone, claimed,
        await fetchInitialSlice(env, client, ledgerBudget, claimed, timeZone),
      );
    }

    // Producers fetch independently into a bounded ready queue. The single
    // consumer owns all normalization and D1 read-modify-write persistence.
    // A new wave handles range and zone partitions created by finalization.
    while (canStartInitialSlice(ledgerBudget)) {
      const ready = new InitialFetchQueue(INITIAL_FETCH_CONCURRENCY);
      let claimedInWave = 0;
      let producerError: unknown;
      let producerBudgetExhausted = false;
      const producer = async (): Promise<void> => {
        while (producerError === undefined && !producerBudgetExhausted && canStartInitialSlice(ledgerBudget)) {
          let claimed: ClaimedInitialSlice | null;
          try {
            claimed = await claimInitialSlice(env, ledgerBudget, quota, jobId, "analytics");
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
          if (!await ready.push(await fetchInitialSlice(env, client, ledgerBudget, claimed, timeZone))) return;
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
        }
      } catch (error) {
        consumerError = error;
        ready.close();
      }
      await producerCompletion;
      if (consumerError !== undefined) throw consumerError;
      if (producerError !== undefined) throw producerError;
      if (producerBudgetExhausted) {
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

interface ClaimedInitialSlice {
  slice: InitialSliceRow;
  metadata: InitialIngestionSliceMetadata;
  persistenceReservation: { reads: number; writes: number } | null;
}

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

async function claimInitialSlice(
  env: Env,
  budget: LedgerRunBudget,
  quota: InitialGraphqlQuota,
  jobId: string,
  mode: "analytics" | "billing" | "persistence_retry",
): Promise<ClaimedInitialSlice | null> {
  const modeCode = mode === "billing" ? 1 : mode === "persistence_retry" ? 2 : 0;
  const candidates = await env.DB.prepare(
    `SELECT * FROM backfill_slices
     WHERE backfill_job_id=?1 AND status='pending' AND (next_eligible_at IS NULL OR next_eligible_at<=?2)
       AND ((?3=1 AND collector_key='billing')
         OR (?3=0 AND collector_key!='billing' AND COALESCE(json_extract(scope_key,'$.persistenceRetry'),0)=0)
         OR (?3=2 AND collector_key!='billing' AND json_extract(scope_key,'$.persistenceRetry')=1))
     ORDER BY CASE WHEN json_extract(scope_key,'$.persistenceRetry')=1 THEN 0 ELSE 1 END,
       ends_at DESC,collector_key LIMIT 100`,
  ).bind(jobId, Date.now(), modeCode).all<InitialSliceRow>();
  budget.charge("d1RowsRead", candidates.results.length);
  let slice: InitialSliceRow | undefined;
  let metadata: InitialIngestionSliceMetadata | undefined;
  for (const candidate of candidates.results) {
    const parsed = parseSliceMetadata(candidate.scope_key, candidate.starts_at, candidate.ends_at);
    if (mode !== "billing" && parsed.zoneIds.length > 1) {
      await migrateLegacyZoneSlice(env.DB, candidate, parsed, budget);
      return claimInitialSlice(env, budget, quota, jobId, mode);
    }
    if (mode !== "billing" && !quota.canCharge(rateScope(parsed), 1)) continue;
    slice = candidate;
    metadata = parsed;
    break;
  }
  if (!slice || !metadata) return null;
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
  return { slice, metadata, persistenceReservation };
}

async function fetchInitialSlice(
  env: Env,
  client: CloudflareClient,
  budget: LedgerRunBudget,
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
  releasePersistenceReservation(budget, claimed);
  try {
    if (slice.collector_key === "billing") {
      if (fetched.error) throw fetched.error;
    } else {
      if (fetched.error) throw fetched.error;
      const result = fetched.usage;
      if (!result) throw new Error("Historical Analytics returned no result");
      if (result.zoneGaps?.length && metadata.zoneIds.length) {
        await splitZoneGapSlice(env.DB, slice, metadata, result.zoneGaps, budget);
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
        await markSliceTerminalGap(env.DB, slice, metadata, detail, budget);
        await finishSlice(env.DB, budget, slice.id, "failed", detail, "partial");
        await updateInitialJobStatus(env.DB, jobId, budget);
        return true;
      }
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
      if (failed) await markSliceTerminalGap(env.DB, slice, metadata, error.message);
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
    if (failed) await markSliceTerminalGap(env.DB, slice, metadata, errorMessage(error), budget);
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
     ) VALUES(?1,?2,?3,?4,?5,?6,'failed',0,NULL,'missing',?7,?8)`,
  ).bind(
    crypto.randomUUID(), slice.backfill_job_id, slice.collector_key,
    serializeMetadata({ ...metadata, zoneIds: [gap.zoneId], units: days, availability: "unavailable", terminalGap: true }),
    slice.starts_at, slice.ends_at, `${metadata.dataset}: ${gap.detail}`, now,
  ));
  const results = await db.batch(statements);
  if (budget) for (const result of results) chargeMeta(budget, result.meta);
}

async function migrateLegacyZoneSlice(
  db: D1Database,
  slice: InitialSliceRow,
  metadata: InitialIngestionSliceMetadata,
  budget: LedgerRunBudget,
): Promise<void> {
  const now = Date.now();
  const units = calendarDays(slice.starts_at, slice.ends_at);
  const superseded = await db.prepare(
    `UPDATE backfill_slices SET status='superseded',error=?2,updated_at=?3 WHERE id=?1 AND status='pending'`,
  ).bind(slice.id, "Migrated to exact-zone rate-limit partitions", now).run();
  chargeMeta(budget, superseded.meta);
  if (Number(superseded.meta.changes ?? 0) !== 1) return;
  const results = await db.batch(metadata.zoneIds.map(zoneId => db.prepare(
      `INSERT INTO backfill_slices(
         id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,next_eligible_at,coverage_status,error,updated_at
       ) VALUES(?1,?2,?3,?4,?5,?6,'pending',0,?7,'missing',NULL,?7)`,
    ).bind(
      crypto.randomUUID(),
      slice.backfill_job_id,
      slice.collector_key,
      serializeMetadata({ ...metadata, zoneIds: [zoneId], units, persistenceRetry: undefined }),
      slice.starts_at,
      slice.ends_at,
      now,
    )));
  for (const result of results) chargeMeta(budget, result.meta);
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
  return boundedRanges(collector, dataset, zoneIds, now, retentionDays, maxDays, setting.maxPageSize);
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
  retentionDays: number,
): InitialIngestionSlicePlan {
  const startsAt = historyStart(now, retentionDays);
  return {
    collector,
    startsAt,
    endsAt: now,
    scopeKey: serializeMetadata({ version: 2, dataset, zoneIds, maxPageSize: 10_000, units: calendarDays(startsAt, now) * Math.max(1, zoneIds.length), availability: "unavailable", terminalGap: true }),
    status: "failed",
    coverageStatus: "missing",
    error: `${dataset}: ${detail}`,
  };
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
  windowStartedAt: number;
  physicalUsed: number;
  accountUsed: number;
  zoneUsed: Record<string, number>;
}

class InitialGraphqlQuota implements HistoricalRateBudget {
  constructor(private readonly state: InitialGraphqlQuotaState) {}

  get physicalRemaining(): number {
    return Math.max(0, INITIAL_PHYSICAL_GRAPHQL_QUOTA - this.state.physicalUsed);
  }

  get resetAt(): number {
    return this.state.windowStartedAt + GRAPHQL_WINDOW_MS;
  }

  canCharge(scope: HistoricalRateScope, logicalQueries: number): boolean {
    this.rollover();
    if (this.physicalRemaining < 1) return false;
    const amount = Math.max(1, Math.floor(logicalQueries));
    return scope.kind === "account"
      ? this.state.accountUsed + amount <= INITIAL_ACCOUNT_QUERY_QUOTA
      : (this.state.zoneUsed[scope.zoneId] ?? 0) + amount <= INITIAL_ZONE_QUERY_QUOTA;
  }

  charge(scope: HistoricalRateScope, logicalQueries: number): void {
    if (!this.canCharge(scope, logicalQueries)) {
      throw new HistoricalRateLimitError(429, Math.max(Date.now() + 1_000, this.resetAt), "Initial Analytics quota is reserved until the next Cloudflare window");
    }
    const amount = Math.max(1, Math.floor(logicalQueries));
    this.state.physicalUsed += 1;
    if (scope.kind === "account") this.state.accountUsed += amount;
    else this.state.zoneUsed[scope.zoneId] = (this.state.zoneUsed[scope.zoneId] ?? 0) + amount;
  }

  snapshot(): InitialGraphqlQuotaState {
    return {
      windowStartedAt: this.state.windowStartedAt,
      physicalUsed: this.state.physicalUsed,
      accountUsed: this.state.accountUsed,
      zoneUsed: { ...this.state.zoneUsed },
    };
  }

  private rollover(now = Date.now()): void {
    if (now >= this.state.windowStartedAt && now - this.state.windowStartedAt < GRAPHQL_WINDOW_MS) return;
    this.state.windowStartedAt = now;
    this.state.physicalUsed = 0;
    this.state.accountUsed = 0;
    this.state.zoneUsed = {};
  }
}

function rateScope(metadata: InitialIngestionSliceMetadata): HistoricalRateScope {
  const zoneId = metadata.zoneIds[0];
  return zoneId ? { kind: "zone", zoneId } : { kind: "account" };
}

async function loadInitialGraphqlQuota(db: D1Database, accountId: string, now: number): Promise<InitialGraphqlQuota> {
  const row = await db.prepare(`SELECT value FROM settings WHERE key=?1 LIMIT 1`)
    .bind(`${INITIAL_QUOTA_KEY_PREFIX}${accountId}`).first<{ value: string }>();
  let state: InitialGraphqlQuotaState = { windowStartedAt: now, physicalUsed: 0, accountUsed: 0, zoneUsed: {} };
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as Partial<InitialGraphqlQuotaState> & { used?: number };
      if (Number.isFinite(parsed.windowStartedAt)
        && now - Number(parsed.windowStartedAt) < GRAPHQL_WINDOW_MS && now >= Number(parsed.windowStartedAt)) {
        const legacyUsed = Number.isFinite(parsed.used) ? Number(parsed.used) : 0;
        state = {
          windowStartedAt: Number(parsed.windowStartedAt),
          physicalUsed: boundedUsage(parsed.physicalUsed ?? legacyUsed, INITIAL_PHYSICAL_GRAPHQL_QUOTA),
          accountUsed: boundedUsage(parsed.accountUsed ?? legacyUsed, INITIAL_ACCOUNT_QUERY_QUOTA),
          zoneUsed: Object.fromEntries(Object.entries(parsed.zoneUsed ?? {}).map(([zoneId, used]) => [
            zoneId,
            boundedUsage(used, INITIAL_ZONE_QUERY_QUOTA),
          ])),
        };
      }
    } catch {
      // Corrupt quota state starts a fresh bounded window.
    }
  }
  return new InitialGraphqlQuota(state);
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
