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
  historicalQueryPageSize,
  isHistoricalRateLimitError,
  type HistoricalDatasetCapability,
  type HistoricalRateBudget,
  type HistoricalRateObservation,
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
// Cloudflare's account-based limiter permits 300 physical requests per five
// minutes at one request per second. Its separate GraphQL budget reports exact
// query cost and remaining capacity in each response. Use those server values
// to distribute measured debit across the rolling window. Retain a conservative
// local fallback for older responses.
const GRAPHQL_MIN_QUERY_INTERVAL_MS = 1_200;
const INITIAL_PHYSICAL_GRAPHQL_QUOTA = 300;
const INITIAL_SHARED_QUERY_QUOTA = 270;
const CONFIGURED_SHARED_QUERY_QUOTA = 270;
const MIN_ADAPTIVE_SHARED_QUERY_QUOTA = 60;
const GRAPHQL_REPORTED_BUDGET_RESERVE = 10;
const GRAPHQL_BUDGET_DEBIT_SAFETY = 1.25;
// An unseen bounded result row reserves 16 GraphQL budget units before the
// standard 25% safety factor. Persisted observations can raise this floor.
const DEFAULT_UNSEEN_PAGE_UNIT_DEBIT = 16;
// Transformations are grouped into a small daily result, but Cloudflare charges
// their GraphQL budget for the underlying event scan. A result-page estimate
// cannot safely predict that scan cost.
const FRESH_WINDOW_DATASETS = new Set(["imagesTransformationsAdaptiveGroups"]);
const MAX_ZONE_BATCH = 10;
const GRAPHQL_WINDOW_MS = 5 * 60_000;
const INITIAL_LEASE_TTL_MS = 120_000;
const INITIAL_LEASE_NAME = "initial-ingestion";
const BILLING_REQUESTS_PER_SLICE = 3;
const INITIAL_QUOTA_KEY_PREFIX = "initial_ingestion_quota:";
const INITIAL_CAPABILITY_KEY_PREFIX = "initial_ingestion_capabilities:";
const INITIAL_D1_READ_RESERVATION = 10_000;
const INITIAL_D1_WRITE_RESERVATION = 1_000;
const INITIAL_REMOTE_WORK_WALL_RESERVE_MS = 12_000;

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
  family?: string;
  priority?: number;
  pageSizeHint?: number;
  graphqlBudgetFailures?: number;
  freshGraphqlBudgetRequired?: boolean;
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
    waitReason: "pacing" | "capacity" | "rate_limit" | null;
    sharedQueryLimit: number;
    queryWindowStartedAt: number;
    physicalRequestsUsed: number;
    physicalRequestLimit: number;
    logicalQueryUnitsUsed: number;
    queryIntervalMs: number;
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
  if (existing && existing.status !== "planning" && existing.status !== "planning_failed") {
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
  }

  const planningHolder = crypto.randomUUID();
  if (!await acquireInitialIngestionLease(env.DB, env.BROLLY_ACCOUNT_ID, planningHolder)) {
    const current = await initialJob(env.DB, env.BROLLY_ACCOUNT_ID, INITIAL_KIND);
    return ingestionJobResult(current ?? { id: jobId, status: "planning" }, false, await sliceCount(env.DB, jobId));
  }
  try {
    if (existing) await env.DB.prepare(
      `UPDATE backfill_jobs SET status='planning',updated_at=?2
       WHERE id=?1 AND status IN ('planning','planning_failed')`,
    ).bind(jobId, now).run();
    const billingAvailable = options.billingAvailable ?? await billingIngestionAvailable(env);
    await ensureInitialBillingSlices(env.DB, jobId, now, billingAvailable);
    await runInitialBillingSlices(env, jobId);
    const discoveryQuota = await loadInitialGraphqlQuota(env.DB, env.BROLLY_ACCOUNT_ID, jobId, Date.now());
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
    discoveryQuota.useRunBudget(discoveryLedger);
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
      const familyCosts = await initialBillingFamilyCosts(env.DB, env.BROLLY_ACCOUNT_ID);
      const slices = prioritizeInitialIngestionSlices(
        initialIngestionSlicePlan(now, billingAvailable, capabilities),
        familyCosts,
      );
      await insertInitialSlices(env.DB, jobId, slices.filter(slice => slice.collector !== "billing"), now);
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
    if (isHistoricalRateLimitError(error)
      || error instanceof LedgerBudgetExceededError
      || error instanceof MonitoringBudgetExceededError) {
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

export function prioritizeInitialIngestionSlices(
  slices: InitialIngestionSlicePlan[],
  familyCosts: Readonly<Record<string, number>>,
): InitialIngestionSlicePlan[] {
  const collectorFamilies = new Map<string, string>();
  for (const spec of HISTORICAL_DATASETS) collectorFamilies.set(spec.collector, spec.family);
  const remaining = [...new Set(slices.map(slice => slice.collector)
    .filter(collector => collector !== "billing" && collector !== "graphql:durable-objects" && collector !== "graphql:workers"))]
    .sort((left, right) => {
      const leftCost = familyCosts[collectorFamilies.get(left) ?? ""] ?? 0;
      const rightCost = familyCosts[collectorFamilies.get(right) ?? ""] ?? 0;
      return rightCost - leftCost || left.localeCompare(right);
    });
  const priorities = new Map<string, number>([
    ["billing", -1],
    ["graphql:durable-objects", 0],
    ["graphql:workers", 1],
    ...remaining.map((collector, index) => [collector, index + 10] as const),
  ]);
  return slices.map(slice => {
    const metadata = parseSliceMetadata(slice.scopeKey, slice.startsAt, slice.endsAt);
    return {
      ...slice,
      scopeKey: serializeMetadata({
        ...metadata,
        family: collectorFamilies.get(slice.collector) ?? (slice.collector === "billing" ? "account" : undefined),
        priority: priorities.get(slice.collector) ?? 10_000,
      }),
    };
  });
}

async function initialBillingFamilyCosts(db: D1Database, accountId: string): Promise<Record<string, number>> {
  const rows = await db.prepare(
    `SELECT product_family,SUM(COALESCE(billed_cost,effective_cost,list_cost,0)) AS cost
     FROM billing_line_items WHERE account_id=?1 GROUP BY product_family`,
  ).bind(accountId).all<{ product_family: string; cost: number | null }>();
  return Object.fromEntries(rows.results.map(row => [row.product_family, Number(row.cost ?? 0)]));
}

async function insertInitialSlices(
  db: D1Database,
  jobId: string,
  slices: InitialIngestionSlicePlan[],
  now: number,
): Promise<void> {
  for (let offset = 0; offset < slices.length; offset += 100) {
    await db.batch(slices.slice(offset, offset + 100).map(slice => db.prepare(
      `INSERT OR IGNORE INTO backfill_slices(
         id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,
         retry_count,next_eligible_at,coverage_status,error,updated_at
       ) VALUES(?1,?2,?3,?4,?5,?6,?7,0,?8,?9,?10,?8)`,
    ).bind(
      crypto.randomUUID(), jobId, slice.collector, slice.scopeKey, slice.startsAt, slice.endsAt,
      slice.status, now, slice.coverageStatus, slice.error,
    )));
  }
}

async function ensureInitialBillingSlices(
  db: D1Database,
  jobId: string,
  now: number,
  billingAvailable: boolean,
): Promise<void> {
  const existing = await db.prepare(
    `SELECT 1 AS present FROM backfill_slices WHERE backfill_job_id=?1 AND collector_key='billing' LIMIT 1`,
  ).bind(jobId).first<{ present: number }>();
  if (existing) return;
  const billing = initialIngestionSlicePlan(now, billingAvailable, [])
    .filter(slice => slice.collector === "billing");
  await insertInitialSlices(db, jobId, billing, now);
}

async function runInitialBillingSlices(env: Env, jobId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE backfill_slices SET status='pending',updated_at=?2
     WHERE backfill_job_id=?1 AND collector_key='billing' AND status='running'`,
  ).bind(jobId, Date.now()).run();
  const rows = await env.DB.prepare(
    `SELECT * FROM backfill_slices
     WHERE backfill_job_id=?1 AND collector_key='billing' AND status='pending'
       AND (next_eligible_at IS NULL OR next_eligible_at<=?2)
     ORDER BY ends_at DESC`,
  ).bind(jobId, Date.now()).all<InitialSliceRow>();
  if (!rows.results.length) return;
  const budget = new LedgerRunBudget({
    ...INITIAL_INGESTION_LIMITS,
    graphqlQueries: 1,
    backfillSlices: Math.min(3, rows.results.length),
    wallMs: 30_000,
  }, "initial_ingestion");
  const client = new CloudflareClient(env, new RunBudget({
    apiCalls: INITIAL_INGESTION_LIMITS.restRequests,
    databaseRows: INITIAL_INGESTION_LIMITS.d1RowsRead + INITIAL_INGESTION_LIMITS.d1RowsWritten,
    samples: 100_000,
    wallMs: 30_000,
  }), budget);
  const ledger = new LedgerStore(env.DB, budget);
  const timeZone = env.BROLLY_TIMEZONE ?? "UTC";

  for (const slice of rows.results) {
    if (!canStartInitialSlice(budget)) break;
    budget.charge("backfillSlices");
    const claimed = await env.DB.prepare(
      `UPDATE backfill_slices SET status='running',updated_at=?2 WHERE id=?1 AND status='pending'`,
    ).bind(slice.id, Date.now()).run();
    chargeMeta(budget, claimed.meta);
    if (Number(claimed.meta.changes ?? 0) !== 1) {
      budget.refund("backfillSlices");
      continue;
    }
    const owned: ClaimedInitialSlice = {
      slice,
      metadata: parseSliceMetadata(slice.scope_key, slice.starts_at, slice.ends_at),
      persistenceReservation: null,
      rateScope: null,
    };
    try {
      const fetched = await fetchInitialSlice(env, client, budget, null, owned, timeZone);
      await finalizeInitialSlice(env, ledger, budget, jobId, timeZone, owned, fetched, false);
    } catch (error) {
      const retryAt = Date.now() + 2_000;
      await env.DB.prepare(
        `UPDATE backfill_slices SET status='pending',error=?2,next_eligible_at=?3,updated_at=?4 WHERE id=?1`,
      ).bind(slice.id, errorMessage(error).slice(0, 2_000), retryAt, Date.now()).run();
      if (budget.signal.aborted) break;
    }
  }
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
      waitReason: quota.waitReason,
      sharedQueryLimit: quota.fallbackLimit,
      queryWindowStartedAt: quota.windowStartedAt,
      physicalRequestsUsed: quota.physicalUsed,
      physicalRequestLimit: INITIAL_PHYSICAL_GRAPHQL_QUOTA,
      logicalQueryUnitsUsed: quota.logicalUsed,
      queryIntervalMs: quota.pacingIntervalMs,
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
  quota.useRunBudget(ledgerBudget);
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
          true,
          quota,
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
        true,
        quota,
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
          await finalizeInitialSlice(env, ledger, ledgerBudget, jobId, timeZone, fetched.claimed, fetched, true, quota);
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
  return budget.remaining("backfillSlices") > 0
    && budget.remaining("wallMs") >= INITIAL_REMOTE_WORK_WALL_RESERVE_MS;
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
  const persistenceRetry = mode === "persistence_retry" ? 1 : 0;
  const collectorPredicate = mode === "billing" ? "collector_key='billing'" : "collector_key!='billing'";
  const candidates = await env.DB.prepare(
    `SELECT * FROM backfill_slices
     WHERE backfill_job_id=?1 AND status='pending' AND (next_eligible_at IS NULL OR next_eligible_at<=?2)
       AND ${collectorPredicate}
       AND COALESCE(json_extract(scope_key,'$.persistenceRetry'),0)=?3
     ORDER BY COALESCE(json_extract(scope_key,'$.priority'),10000),
       COALESCE(json_array_length(json_extract(scope_key,'$.zoneIds')),0),
       ends_at DESC,collector_key LIMIT 100`,
  ).bind(jobId, Date.now(), persistenceRetry).all<InitialSliceRow>();
  budget.charge("d1RowsRead", candidates.results.length);
  let slice: InitialSliceRow | undefined;
  let metadata: InitialIngestionSliceMetadata | undefined;
  let earliestAdmission: number | null | undefined;
  for (const candidate of candidates.results) {
    const parsed = parseSliceMetadata(candidate.scope_key, candidate.starts_at, candidate.ends_at);
    if (mode !== "billing") {
      const pageSize = historicalQueryPageSize({
        dataset: parsed.dataset,
        startsAt: candidate.starts_at,
        endsAt: candidate.ends_at,
        maxPageSize: parsed.pageSizeHint ?? parsed.maxPageSize,
        zoneIds: parsed.zoneIds,
      });
      const logicalQueries = initialSliceLogicalQueries(parsed);
      if (parsed.freshGraphqlBudgetRequired) {
        const freshAt = quota.freshBudgetAvailableAt;
        if (freshAt > Date.now()) {
          if (earliestAdmission !== null) {
            earliestAdmission = Math.min(earliestAdmission ?? Number.POSITIVE_INFINITY, freshAt);
          }
          continue;
        }
      }
      const admission = quota.claimAdmission(
        rateScope(parsed),
        logicalQueries,
        parsed.zoneIds,
        parsed.dataset,
        pageSize,
      );
      if (admission.kind === "quota") {
        continue;
      }
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
    quota.scheduleNextAdmissionAt(earliestAdmission);
    if (earliestAdmission !== null
      && earliestAdmission - Date.now() > Math.max(
        0,
        budget.remaining("wallMs") - INITIAL_REMOTE_WORK_WALL_RESERVE_MS,
      )) return null;
    return { waitUntil: earliestAdmission };
  }
  quota.scheduleNextAdmissionAt(null);
  const requiredQueries = slice.collector_key === "billing" ? 0 : initialSliceLogicalQueries(metadata);
  if (budget.remaining("backfillSlices") < 1
    || budget.remaining("d1RowsWritten") < INITIAL_D1_WRITE_RESERVATION + 1
    || budget.remaining("d1RowsRead") < INITIAL_D1_READ_RESERVATION
    || budget.remaining("wallMs") < INITIAL_REMOTE_WORK_WALL_RESERVE_MS
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
  quota: InitialGraphqlQuota | null,
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
        maxPageSize: metadata.pageSizeHint ?? metadata.maxPageSize,
        zoneIds: metadata.zoneIds,
      }),
    };
  } catch (error) {
    return { claimed, error };
  } finally {
    if (claimed.rateScope && quota) quota.releaseClaim(claimed.rateScope);
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
  updateJob = true,
  quota: InitialGraphqlQuota | null = null,
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
        if (updateJob) await updateInitialJobStatus(env.DB, jobId, budget);
        return true;
      }
      if (!result.complete && calendarDays(slice.starts_at, slice.ends_at) > 1) {
        await splitSlice(env.DB, slice, metadata, "Cloudflare row limit", budget);
        if (updateJob) await updateInitialJobStatus(env.DB, jobId, budget);
        return true;
      }
      const observations = expandUsageObservations(
        result.samples,
        result.collector,
        result.dataset,
        result.complete ? "complete" : "partial",
        { watermarkAt: slice.ends_at, historical: true },
      );
      await ledger.applyObservations(observations, timeZone, { reconcileChanges: false });
      await updatePendingResourcePageHints(env.DB, env.BROLLY_ACCOUNT_ID, slice.backfill_job_id, metadata.dataset, budget);
      if (!result.complete) {
        const detail = "Cloudflare's row limit was reached for a single day; retained rows are marked partial";
        await saveDatasetSliceCoverage(env, slice, metadata, "partial", detail, budget);
        await markSliceTerminalGap(env.DB, slice, metadata, detail, budget);
        await finishSlice(env.DB, budget, slice.id, "failed", detail, "partial");
        if (updateJob) await updateInitialJobStatus(env.DB, jobId, budget);
        return true;
      }
      await saveDatasetSliceCoverage(env, slice, metadata, "measured", undefined, budget);
      if (metadata.freshGraphqlBudgetRequired && quota?.hasReliableDebit(metadata.dataset)) {
        const relaxed = await env.DB.prepare(
          `UPDATE backfill_slices
           SET scope_key=json_set(scope_key,'$.freshGraphqlBudgetRequired',json('false')),updated_at=?3
           WHERE backfill_job_id=?1 AND status='pending'
             AND json_extract(scope_key,'$.dataset')=?2
             AND COALESCE(json_extract(scope_key,'$.freshGraphqlBudgetRequired'),0)=1`,
        ).bind(slice.backfill_job_id, metadata.dataset, Date.now()).run();
        chargeMeta(budget, relaxed.meta);
        if (Number(relaxed.meta.changes ?? 0) > 0) {
          console.info("brolly.initial_graphql_measured_pacing", JSON.stringify({
            dataset: metadata.dataset,
            pendingSlices: Number(relaxed.meta.changes ?? 0),
          }));
        }
      }
    }
    await finishSlice(env.DB, budget, slice.id, "complete", null, "complete");
    if (updateJob) await updateInitialJobStatus(env.DB, jobId, budget);
    return true;
  } catch (error) {
    if (isHistoricalRateLimitError(error)) {
      const now = Date.now();
      const oversizedQuery = error.remote
        && error.status === 200
        && error.telemetry?.limiterScope === "shared";
      const graphqlBudgetFailures = (metadata.graphqlBudgetFailures ?? 0) + 1;
      if (oversizedQuery && !metadata.freshGraphqlBudgetRequired) {
        console.info("brolly.initial_graphql_fresh_retry", JSON.stringify({
          dataset: metadata.dataset,
          startsAt: slice.starts_at,
          endsAt: slice.ends_at,
        }));
        await env.DB.prepare(
          `UPDATE backfill_slices SET status='pending',scope_key=?2,error=?3,next_eligible_at=?4,
            coverage_status='missing',updated_at=?5 WHERE id=?1`,
        ).bind(
          slice.id,
          serializeMetadata({ ...metadata, freshGraphqlBudgetRequired: true }),
          error.message.slice(0, 2_000),
          Math.max(now + 1_000, error.retryAt),
          now,
        ).run();
        if (updateJob) await updateInitialJobStatus(env.DB, jobId);
        return false;
      }
      if (oversizedQuery
        && slice.ends_at - slice.starts_at > DAY_MS
        && graphqlBudgetFailures >= 4) {
        const detail = "Cloudflare's GraphQL budget could not return this dataset after progressively smaller ranges.";
        console.warn("brolly.initial_graphql_unavailable", JSON.stringify({
          dataset: metadata.dataset,
          startsAt: slice.starts_at,
          endsAt: slice.ends_at,
          reason: "repeated_range_budget_exhaustion",
          failures: graphqlBudgetFailures,
        }));
        await markDatasetBudgetUnavailable(env, slice.backfill_job_id, metadata.dataset, detail, budget);
        if (updateJob) await updateInitialJobStatus(env.DB, jobId, budget);
        return false;
      }
      if (oversizedQuery && slice.ends_at - slice.starts_at > DAY_MS) {
        console.info("brolly.initial_graphql_split", JSON.stringify({
          dataset: metadata.dataset,
          startsAt: slice.starts_at,
          endsAt: slice.ends_at,
          days: calendarDays(slice.starts_at, slice.ends_at),
          failures: graphqlBudgetFailures,
        }));
        await splitOversizedDatasetRanges(
          env.DB,
          slice,
          { ...metadata, graphqlBudgetFailures },
          budget,
        );
        if (updateJob) await updateInitialJobStatus(env.DB, jobId, budget);
        return false;
      }
      if (oversizedQuery && Number(slice.retry_count ?? 0) >= 1) {
        const detail = "Cloudflare's GraphQL budget could not return this dataset for a single day.";
        console.warn("brolly.initial_graphql_unavailable", JSON.stringify({
          dataset: metadata.dataset,
          startsAt: slice.starts_at,
          endsAt: slice.ends_at,
          reason: "single_day_budget_exhausted",
        }));
        await saveDatasetSliceCoverage(env, slice, metadata, "unavailable", detail, budget);
        await markSliceTerminalGap(env.DB, slice, metadata, detail, budget);
        await finishSlice(env.DB, budget, slice.id, "failed", detail, "missing");
        if (updateJob) await updateInitialJobStatus(env.DB, jobId, budget);
        return false;
      }
      await env.DB.prepare(
        `UPDATE backfill_slices SET status='pending',error=?2,retry_count=retry_count+?3,next_eligible_at=?4,
          coverage_status='missing',updated_at=?5 WHERE id=?1`,
      ).bind(
        slice.id,
        error.message.slice(0, 2_000),
        oversizedQuery ? 1 : 0,
        Math.max(now + 1_000, error.retryAt),
        now,
      ).run();
      if (updateJob) await updateInitialJobStatus(env.DB, jobId);
      return false;
    }
    if (error instanceof LedgerBudgetExceededError || error instanceof MonitoringBudgetExceededError) {
      const densityFailure = !budgetAbortedAtEntry
        && error instanceof LedgerBudgetExceededError
        && (error.kind === "d1RowsRead" || error.kind === "d1RowsWritten");
      if (!densityFailure) {
        const now = Date.now();
        const retryDelay = error instanceof LedgerBudgetExceededError && error.kind === "wallMs" ? 1_000 : 60_000;
        await env.DB.prepare(
          `UPDATE backfill_slices SET status='pending',error=?2,next_eligible_at=?3,
             coverage_status='missing',updated_at=?4 WHERE id=?1`,
        ).bind(
          slice.id,
          `Deferred after the import run reached its bounded limit: ${error.message}`,
          now + retryDelay,
          now,
        ).run();
        if (updateJob) await updateInitialJobStatus(env.DB, jobId);
        return false;
      }
      if (metadata.persistenceRetry && calendarDays(slice.starts_at, slice.ends_at) > 1) {
        await splitSlice(env.DB, slice, metadata, "bounded persistence budget");
        if (updateJob) await updateInitialJobStatus(env.DB, jobId);
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
        if (updateJob) await updateInitialJobStatus(env.DB, jobId);
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
      if (updateJob) await updateInitialJobStatus(env.DB, jobId);
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
    if (updateJob) await updateInitialJobStatus(env.DB, jobId, budget);
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
  subdivisions: 2 | 4 = 2,
): Promise<void> {
  const halves = bisectInitialIngestionRange(slice.starts_at, slice.ends_at, metadata.zoneIds.length);
  const children = subdivisions === 4 && halves.every(child => calendarDays(child.startsAt, child.endsAt) > 1)
    ? halves.flatMap(child => bisectRangeWithUnits(
      child.startsAt,
      child.endsAt,
      metadata.zoneIds.length,
      child.units,
    ))
    : halves;
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

async function splitOversizedDatasetRanges(
  db: D1Database,
  slice: InitialSliceRow,
  metadata: InitialIngestionSliceMetadata,
  budget: LedgerRunBudget,
): Promise<void> {
  const failedDuration = slice.ends_at - slice.starts_at;
  const subdivisions = metadata.graphqlBudgetFailures === 1 ? 4 : 2;
  await splitSlice(db, slice, metadata, "Cloudflare GraphQL query budget", budget, subdivisions);
  const siblings = await db.prepare(
    `SELECT * FROM backfill_slices
     WHERE backfill_job_id=?1 AND status='pending'
       AND json_extract(scope_key,'$.dataset')=?2
       AND ends_at-starts_at>?3 AND ends_at-starts_at>=?4
     ORDER BY ends_at DESC LIMIT 20`,
  ).bind(
    slice.backfill_job_id,
    metadata.dataset,
    DAY_MS,
    Math.max(DAY_MS + 1, failedDuration - DAY_MS),
  ).all<InitialSliceRow>();
  budget.charge("d1RowsRead", siblings.results.length);
  for (const sibling of siblings.results) {
    await splitSlice(
      db,
      sibling,
      {
        ...parseSliceMetadata(sibling.scope_key, sibling.starts_at, sibling.ends_at),
        graphqlBudgetFailures: metadata.graphqlBudgetFailures,
      },
      "same dataset's observed GraphQL query budget",
      budget,
      subdivisions,
    );
  }
  if (siblings.results.length) {
    console.info("brolly.initial_graphql_sibling_splits", JSON.stringify({
      dataset: metadata.dataset,
      count: siblings.results.length,
      minimumDurationMs: Math.max(DAY_MS + 1, failedDuration - DAY_MS),
    }));
  }
}

function resourcePageShape(dataset: string): { family: string; resourceType: string; rowsPerResourceDay: number } | null {
  const spec = HISTORICAL_DATASETS.find(candidate => candidate.dataset === dataset);
  if (!spec) return null;
  if (spec.kind === "workers") {
    return { family: "workers", resourceType: "workers:resource", rowsPerResourceDay: 1 };
  }
  if (spec.kind === "durable_invocations") {
    return { family: "durable_objects", resourceType: "durable_objects:object", rowsPerResourceDay: 2 };
  }
  if (spec.kind === "durable_periodic") {
    return { family: "durable_objects", resourceType: "durable_objects:object", rowsPerResourceDay: 1 };
  }
  if (spec.kind === "durable_sql_storage") {
    return { family: "durable_objects", resourceType: "durable_objects:namespace", rowsPerResourceDay: 1 };
  }
  if (spec.kind !== "product" || spec.source?.timeKind !== "date" || !spec.source.resourceDimension) return null;
  const dimensions = spec.source.dimensions ?? [];
  const unboundedDimensions = dimensions.filter(dimension => (
    dimension !== spec.source?.resourceDimension && dimension !== spec.source?.parentDimension
  ));
  if (unboundedDimensions.length) return null;
  return {
    family: spec.family,
    resourceType: `${spec.family}:${spec.scope}`,
    rowsPerResourceDay: 1,
  };
}

export function resourceAwarePageSize(
  maximum: number,
  days: number,
  resources: number,
  rowsPerResourceDay = 1,
): number {
  const boundedMaximum = Math.max(1, Math.min(10_000, Math.floor(maximum)));
  const expectedRows = Math.max(1, Math.ceil(days) * Math.ceil(resources) * Math.ceil(rowsPerResourceDay));
  const headroom = Math.max(8, Math.ceil(expectedRows * 0.2));
  return Math.min(boundedMaximum, expectedRows + headroom + 1);
}

async function updatePendingResourcePageHints(
  db: D1Database,
  accountId: string,
  jobId: string,
  dataset: string,
  budget: LedgerRunBudget,
): Promise<void> {
  const shape = resourcePageShape(dataset);
  if (!shape) return;
  const countResult = await db.prepare(
    `SELECT COUNT(*) AS count FROM resources
     WHERE account_id=?1 AND product_family=?2 AND resource_type=?3`,
  ).bind(accountId, shape.family, shape.resourceType).first<{ count: number }>();
  budget.charge("d1RowsRead", 1);
  const resourceCount = Math.max(0, Number(countResult?.count ?? 0));
  if (!resourceCount) return;
  const siblings = await db.prepare(
    `SELECT id,scope_key,starts_at,ends_at FROM backfill_slices
     WHERE backfill_job_id=?1 AND status='pending'
       AND json_extract(scope_key,'$.dataset')=?2
     ORDER BY ends_at DESC LIMIT 100`,
  ).bind(jobId, dataset).all<Pick<InitialSliceRow, "id" | "scope_key" | "starts_at" | "ends_at">>();
  budget.charge("d1RowsRead", siblings.results.length);
  const statements = siblings.results.flatMap(row => {
    const metadata = parseSliceMetadata(row.scope_key, row.starts_at, row.ends_at);
    const pageSizeHint = resourceAwarePageSize(
      metadata.maxPageSize,
      calendarDays(row.starts_at, row.ends_at),
      resourceCount,
      shape.rowsPerResourceDay,
    );
    if (pageSizeHint >= metadata.maxPageSize || pageSizeHint === metadata.pageSizeHint) return [];
    return [db.prepare(`UPDATE backfill_slices SET scope_key=?2,updated_at=?3 WHERE id=?1 AND status='pending'`)
      .bind(row.id, serializeMetadata({ ...metadata, pageSizeHint }), Date.now())];
  });
  if (!statements.length) return;
  const results = await db.batch(statements);
  for (const result of results) chargeMeta(budget, result.meta);
  console.info("brolly.initial_graphql_page_hints", JSON.stringify({
    dataset,
    resources: resourceCount,
    updatedSlices: statements.length,
  }));
}

async function markDatasetBudgetUnavailable(
  env: Env,
  jobId: string,
  dataset: string,
  detail: string,
  budget: LedgerRunBudget,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT * FROM backfill_slices
     WHERE backfill_job_id=?1 AND status IN ('pending','running')
       AND json_extract(scope_key,'$.dataset')=?2
     ORDER BY starts_at LIMIT 100`,
  ).bind(jobId, dataset).all<InitialSliceRow>();
  budget.charge("d1RowsRead", rows.results.length);
  for (const row of rows.results) {
    const metadata = parseSliceMetadata(row.scope_key, row.starts_at, row.ends_at);
    const unavailable = serializeMetadata({
      ...metadata,
      availability: "unavailable",
      terminalGap: true,
      expectedGap: false,
    });
    const result = await env.DB.prepare(
      `UPDATE backfill_slices SET status='failed',scope_key=?2,error=?3,next_eligible_at=NULL,
         coverage_status='missing',updated_at=?4 WHERE id=?1 AND status IN ('pending','running')`,
    ).bind(row.id, unavailable, detail, Date.now()).run();
    chargeMeta(budget, result.meta);
    if (Number(result.meta.changes ?? 0) === 1) {
      await saveDatasetSliceCoverage(env, row, { ...metadata, availability: "unavailable", terminalGap: true }, "unavailable", detail, budget);
    }
  }
}

/** Split a dense range while preserving its exact progress denominator. */
export function bisectInitialIngestionRange(
  startsAt: number,
  endsAt: number,
  partitions: number,
): Array<{ startsAt: number; endsAt: number; units: number }> {
  return bisectRangeWithUnits(
    startsAt,
    endsAt,
    partitions,
    calendarDays(startsAt, endsAt) * Math.max(1, partitions),
  );
}

function bisectRangeWithUnits(
  startsAt: number,
  endsAt: number,
  partitions: number,
  totalUnits: number,
): Array<{ startsAt: number; endsAt: number; units: number }> {
  const middle = splitPoint(startsAt, endsAt);
  const multiplier = Math.max(1, partitions);
  const leftUnits = Math.max(
    multiplier,
    Math.min(totalUnits - multiplier, calendarDays(startsAt, middle) * multiplier),
  );
  return [
    { startsAt, endsAt: middle, units: leftUnits },
    { startsAt: middle, endsAt, units: totalUnits - leftUnits },
  ];
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
      scopeKey: serializeMetadata({
        version: 2,
        dataset,
        zoneIds,
        maxPageSize,
        units,
        availability: "available",
        freshGraphqlBudgetRequired: FRESH_WINDOW_DATASETS.has(dataset),
      }),
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
        family: typeof parsed.family === "string" ? parsed.family : undefined,
        priority: Number.isFinite(parsed.priority) ? Number(parsed.priority) : undefined,
        pageSizeHint: Number.isFinite(parsed.pageSizeHint)
          ? Math.max(1, Math.min(10_000, Math.floor(Number(parsed.pageSizeHint))))
          : undefined,
        graphqlBudgetFailures: Number.isFinite(parsed.graphqlBudgetFailures)
          ? Math.max(0, Math.floor(Number(parsed.graphqlBudgetFailures)))
          : undefined,
        freshGraphqlBudgetRequired: parsed.freshGraphqlBudgetRequired === true,
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

interface InitialGraphqlAdmission {
  admittedAt: number;
  logicalQueries: number;
  physicalRequests: number;
  budgetDebit: number;
  budgetKey: string;
}

interface InitialGraphqlQuotaState {
  jobId: string;
  accounting: "logical_queries";
  limiterMode: "shared-paced" | "shared-fallback";
  adaptiveLimit: number | null;
  reportedRemaining: number | null;
  reportedAt: number | null;
  reportedForRequestAt: number | null;
  observedCapacity: number | null;
  observedMaxCost: number;
  observedMaxDebit: number;
  lastObservedRemaining: number | null;
  lastObservedAt: number | null;
  lastObservedRequestAt: number | null;
  observedCostMultiplier: number;
  observedCosts: Record<string, number>;
  observedDebits: Record<string, number>;
  provisionalDebitKeys: Record<string, true>;
  observedDebitRates: Record<string, number>;
  observedMaxDebitRate: number;
  admissions: InitialGraphqlAdmission[];
  accountLastAdmissionAt: number | null;
  zoneLastAdmissionAt: Record<string, number>;
  sharedNextAdmissionAt: number | null;
  capacityWaitUntil: number | null;
  pausedUntil: number | null;
  rateLimitedAt: number | null;
  accountPausedUntil: number | null;
  zonePausedUntil: Record<string, number>;
}

class InitialGraphqlQuota implements HistoricalRateBudget {
  private readonly inFlightClaims = new Set<string>();
  private readonly admissionTails = new Map<string, Promise<void>>();
  private readonly claimWaiters = new Set<() => void>();
  private runBudget: LedgerRunBudget | null = null;

  constructor(
    private readonly state: InitialGraphqlQuotaState,
    private readonly baseSharedLimit: number,
  ) {}

  useRunBudget(budget: LedgerRunBudget): void {
    this.runBudget = budget;
  }

  get physicalRemaining(): number {
    this.compact();
    if (this.state.pausedUntil && Date.now() < this.state.pausedUntil) return 0;
    const physical = Math.max(0, INITIAL_PHYSICAL_GRAPHQL_QUOTA - this.physicalUsed);
    if (this.state.reportedRemaining === null) {
      return this.logicalUsed < this.activeSharedLimit ? physical : 0;
    }
    return physical;
  }

  get logicalRemaining(): number {
    this.compact();
    return this.state.reportedRemaining === null
      ? Math.max(0, this.activeSharedLimit - this.logicalUsed)
      : this.activeSharedLimit;
  }

  get windowStartedAt(): number {
    this.compact();
    return this.state.admissions[0]?.admittedAt ?? Date.now();
  }

  get physicalUsed(): number {
    this.compact();
    return this.state.admissions.reduce((total, admission) => total + admission.physicalRequests, 0);
  }

  get logicalUsed(): number {
    return this.state.admissions.reduce((total, admission) => total + admission.logicalQueries, 0);
  }

  get resetAt(): number {
    this.compact();
    return Math.max(this.capacityAvailableAt(1), this.state.pausedUntil ?? 0);
  }

  get freshBudgetAvailableAt(): number {
    this.compact();
    const now = Date.now();
    const pausedUntil = Math.max(this.state.pausedUntil ?? 0, this.state.accountPausedUntil ?? 0);
    if (!this.state.admissions.length && pausedUntil <= now) return now;
    return Math.max(
      pausedUntil,
      (this.state.admissions.at(-1)?.admittedAt ?? now) + GRAPHQL_WINDOW_MS,
    );
  }

  get pacingIntervalMs(): number {
    this.compact();
    const lastAdmission = this.state.admissions.at(-1);
    if (!lastAdmission || !this.state.sharedNextAdmissionAt) return GRAPHQL_MIN_QUERY_INTERVAL_MS;
    return Math.max(
      GRAPHQL_MIN_QUERY_INTERVAL_MS,
      this.state.sharedNextAdmissionAt - lastAdmission.admittedAt,
    );
  }

  canCharge(scope: HistoricalRateScope, logicalQueries: number, budgetKey = "", pageSize?: number): boolean {
    this.compact();
    if (this.physicalRemaining < 1) return false;
    const amount = Math.max(1, Math.floor(logicalQueries));
    void scope;
    if (this.state.reportedRemaining === null) return this.logicalUsed + amount <= this.activeSharedLimit;
    return this.estimatedDebit(amount, budgetKey, pageSize) + GRAPHQL_REPORTED_BUDGET_RESERVE <= this.reportedAvailable();
  }

  claimAdmission(scope: HistoricalRateScope, logicalQueries: number, zoneIds: readonly string[] = [], budgetKey = "", pageSize?: number):
    | { kind: "ready" }
    | { kind: "paced"; waitUntil: number | null }
    | { kind: "quota" } {
    this.compact();
    const scopePause = Math.max(
      this.state.pausedUntil ?? 0,
      this.scopePausedUntil(scope) ?? 0,
      ...zoneIds.map(zoneId => this.state.zonePausedUntil[zoneId] ?? 0),
    );
    if (scopePause && scopePause > Date.now()) return { kind: "paced", waitUntil: scopePause };
    if (!this.canCharge(scope, logicalQueries, budgetKey, pageSize)) {
      const waitUntil = this.capacityAvailableAt(logicalQueries, budgetKey, pageSize);
      this.state.capacityWaitUntil = waitUntil;
      return { kind: "paced", waitUntil };
    }
    const key = "shared";
    if (this.inFlightClaims.has(key)) return { kind: "paced", waitUntil: null };
    const waitUntil = Math.max(
      this.lastAdmissionAt(scope) + GRAPHQL_MIN_QUERY_INTERVAL_MS,
      this.pacingAvailableAt(logicalQueries, budgetKey, pageSize),
    );
    return waitUntil > Date.now() ? { kind: "paced", waitUntil } : { kind: "ready" };
  }

  scheduleNextAdmissionAt(waitUntil: number | null): void {
    this.state.sharedNextAdmissionAt = waitUntil && waitUntil > Date.now() ? waitUntil : null;
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
        timer = setTimeout(done, GRAPHQL_MIN_QUERY_INTERVAL_MS);
      } else timer = setTimeout(done, Math.max(1, waitUntil - Date.now()));
    });
  }

  async admit(scope: HistoricalRateScope, logicalQueries: number, budgetKey: string, pageSize?: number): Promise<void> {
    this.assertRemoteWorkTime();
    const key = "shared";
    const previous = this.admissionTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => gate);
    this.admissionTails.set(key, queued);
    await previous;
    try {
      if (!this.canCharge(scope, logicalQueries, budgetKey, pageSize)) {
        const retryAt = this.capacityAvailableAt(logicalQueries, budgetKey, pageSize);
        this.state.capacityWaitUntil = retryAt;
        throw new HistoricalRateLimitError(429, retryAt, "Initial Analytics quota is reserved until rolling budget capacity is available");
      }
      const delay = Math.max(
        this.lastAdmissionAt(scope) + GRAPHQL_MIN_QUERY_INTERVAL_MS,
        this.pacingAvailableAt(logicalQueries, budgetKey, pageSize),
      ) - Date.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      this.assertRemoteWorkTime();
      this.setLastAdmissionAt(scope, Date.now());
      this.charge(scope, logicalQueries, budgetKey, pageSize);
    } finally {
      release();
      if (this.admissionTails.get(key) === queued) this.admissionTails.delete(key);
    }
  }

  observe(
    scope: HistoricalRateScope,
    logicalQueries: number,
    observation: HistoricalRateObservation,
  ): void {
    void scope;
    const predicted = Math.max(1, Math.floor(logicalQueries));
    const cost = Math.max(0, Math.floor(observation.cost));
    const remaining = Math.max(0, Math.floor(observation.remaining));
    this.state.observedCostMultiplier = Math.max(
      this.state.observedCostMultiplier,
      cost / predicted,
    );
    this.state.observedMaxCost = Math.max(this.state.observedMaxCost, cost);
    this.state.observedCosts[String(predicted)] = Math.max(
      this.state.observedCosts[String(predicted)] ?? 0,
      cost,
    );
    this.state.observedCapacity = Math.max(this.state.observedCapacity ?? 0, remaining + cost);
    let debit = 0;
    if (observation.requestedAt >= (this.state.lastObservedRequestAt ?? 0)) {
      if (this.state.lastObservedRemaining !== null) {
        debit = Math.max(0, this.state.lastObservedRemaining - remaining);
      }
      this.state.lastObservedRemaining = remaining;
      this.state.lastObservedAt = observation.observedAt;
      this.state.lastObservedRequestAt = observation.requestedAt;
    }
    const exhausted = remaining === 0;
    const maximumAdmissibleUnknownDebit = this.state.observedCapacity === null
      ? debit
      : Math.max(
        1,
        Math.floor((this.state.observedCapacity - GRAPHQL_REPORTED_BUDGET_RESERVE) / GRAPHQL_BUDGET_DEBIT_SAFETY),
      );
    this.state.observedMaxDebit = Math.max(
      this.state.observedMaxDebit,
      Math.min(debit, maximumAdmissibleUnknownDebit),
    );
    let measuredDebit = Math.max(debit, cost);
    const priorDebitWasProvisional = this.state.provisionalDebitKeys[observation.budgetKey] === true;
    if (exhausted && this.state.observedCapacity !== null) {
      // A zero remainder only reveals a lower bound for this request's debit.
      // Reserve a full recovered window for the same dataset next time while
      // keeping the 110% known-dataset safety factor admissible.
      const fullWindowDebit = Math.max(
        1,
        Math.floor((this.state.observedCapacity - GRAPHQL_REPORTED_BUDGET_RESERVE) / 1.1),
      );
      measuredDebit = fullWindowDebit;
      this.state.observedDebits[observation.budgetKey] = Math.max(
        this.state.observedDebits[observation.budgetKey] ?? 0,
        fullWindowDebit,
      );
      this.state.provisionalDebitKeys[observation.budgetKey] = true;
    } else {
      this.state.observedDebits[observation.budgetKey] = priorDebitWasProvisional
        ? Math.max(measuredDebit, this.unseenDebitBaseline(observation.budgetKey))
        : Math.max(this.state.observedDebits[observation.budgetKey] ?? 0, measuredDebit);
      delete this.state.provisionalDebitKeys[observation.budgetKey];
    }
    if (observation.pageSize && observation.pageSize > 0 && measuredDebit > 0) {
      const requestedRows = observation.pageSize * predicted;
      const rateDebit = priorDebitWasProvisional && !exhausted
        ? this.state.observedDebits[observation.budgetKey] ?? measuredDebit
        : measuredDebit;
      const debitRate = rateDebit / requestedRows;
      this.state.observedDebitRates[observation.budgetKey] = priorDebitWasProvisional && !exhausted
        ? debitRate
        : Math.max(this.state.observedDebitRates[observation.budgetKey] ?? 0, debitRate);
      if (debit > 0 || exhausted) {
        this.state.observedMaxDebitRate = Math.max(this.state.observedMaxDebitRate, debitRate);
      }
    }
    let admission: InitialGraphqlAdmission | undefined;
    for (let index = this.state.admissions.length - 1; index >= 0; index -= 1) {
      const candidate = this.state.admissions[index];
      if (candidate && candidate.admittedAt <= observation.requestedAt) {
        admission = candidate;
        break;
      }
    }
    if (admission) {
      admission.budgetDebit = Math.max(
        admission.budgetDebit,
        cost,
        debit,
        exhausted ? this.state.observedCapacity ?? 0 : 0,
      );
      const pacedDebit = Math.max(
        admission.budgetDebit,
        this.estimatedDebit(predicted, observation.budgetKey, observation.pageSize ?? undefined),
      );
      this.state.sharedNextAdmissionAt = Math.max(
        admission.admittedAt + GRAPHQL_MIN_QUERY_INTERVAL_MS,
        admission.admittedAt + this.pacingIntervalForDebit(Math.ceil(pacedDebit / 2)),
      );
    }
    if (observation.requestedAt >= (this.state.reportedForRequestAt ?? 0)) {
      this.state.reportedRemaining = remaining;
      this.state.reportedAt = observation.observedAt;
      this.state.reportedForRequestAt = observation.requestedAt;
    }
    console.info("brolly.initial_graphql_budget", JSON.stringify({
      budgetKey: observation.budgetKey,
      logicalQueries: predicted,
      cost,
      remaining,
      debit,
      exhausted,
      capacity: this.state.observedCapacity,
      maxCost: this.state.observedMaxCost,
      maxDebit: this.state.observedMaxDebit,
      pageSize: observation.pageSize,
      maxDebitRate: this.state.observedMaxDebitRate,
    }));
  }

  pauseUntil(retryAt: number, scope: HistoricalRateScope | null): void {
    const until = Math.max(Date.now() + 1_000, retryAt);
    if (scope?.kind === "account") {
      this.state.accountPausedUntil = Math.max(this.state.accountPausedUntil ?? 0, until);
    } else if (scope?.kind === "zone") {
      this.state.zonePausedUntil[scope.zoneId] = Math.max(this.state.zonePausedUntil[scope.zoneId] ?? 0, until);
    } else {
      const rateLimitedAt = Date.now();
      this.state.pausedUntil = Math.max(
        this.state.pausedUntil ?? 0,
        until,
        rateLimitedAt + GRAPHQL_WINDOW_MS,
      );
      this.state.rateLimitedAt = rateLimitedAt;
      this.state.limiterMode = "shared-fallback";
      this.state.adaptiveLimit = Math.max(
        MIN_ADAPTIVE_SHARED_QUERY_QUOTA,
        Math.min(this.baseSharedLimit, Math.floor(this.logicalUsed * 0.8)),
      );
    }
    for (const resolve of this.claimWaiters) resolve();
    this.claimWaiters.clear();
  }

  charge(scope: HistoricalRateScope, logicalQueries: number, budgetKey: string, pageSize?: number): void {
    if (!this.canCharge(scope, logicalQueries, budgetKey, pageSize)) {
      const retryAt = Math.max(Date.now() + 1_000, this.capacityAvailableAt(logicalQueries, budgetKey, pageSize));
      this.state.capacityWaitUntil = retryAt;
      throw new HistoricalRateLimitError(429, retryAt, "Initial Analytics quota is reserved until rolling budget capacity is available");
    }
    const amount = Math.max(1, Math.floor(logicalQueries));
    const admittedAt = Date.now();
    const estimatedDebit = this.estimatedDebit(amount, budgetKey, pageSize);
    this.state.admissions.push({ admittedAt, logicalQueries: amount, physicalRequests: 1, budgetDebit: 0, budgetKey });
    if (this.state.reportedRemaining !== null) {
      this.state.reportedRemaining = Math.max(0, this.reportedAvailable() - estimatedDebit);
      this.state.reportedAt = admittedAt;
    }
    this.state.capacityWaitUntil = null;
    this.state.sharedNextAdmissionAt = admittedAt + this.pacingIntervalForDebit(Math.ceil(estimatedDebit / 2));
  }

  snapshot(): InitialGraphqlQuotaState & {
    sharedLimit: number;
    windowStartedAt: number;
    physicalUsed: number;
    sharedUsed: number;
    accountUsed: number;
    zoneUsed: Record<string, number>;
  } {
    this.compact();
    return {
      jobId: this.state.jobId,
      accounting: "logical_queries",
      limiterMode: this.state.limiterMode,
      adaptiveLimit: this.state.adaptiveLimit,
      reportedRemaining: this.state.reportedRemaining,
      reportedAt: this.state.reportedAt,
      reportedForRequestAt: this.state.reportedForRequestAt,
      observedCapacity: this.state.observedCapacity,
      observedMaxCost: this.state.observedMaxCost,
      observedMaxDebit: this.state.observedMaxDebit,
      lastObservedRemaining: this.state.lastObservedRemaining,
      lastObservedAt: this.state.lastObservedAt,
      lastObservedRequestAt: this.state.lastObservedRequestAt,
      observedCostMultiplier: this.state.observedCostMultiplier,
      observedCosts: { ...this.state.observedCosts },
      observedDebits: { ...this.state.observedDebits },
      provisionalDebitKeys: { ...this.state.provisionalDebitKeys },
      observedDebitRates: { ...this.state.observedDebitRates },
      observedMaxDebitRate: this.state.observedMaxDebitRate,
      sharedLimit: this.activeSharedLimit,
      admissions: this.state.admissions.map(admission => ({ ...admission })),
      windowStartedAt: this.windowStartedAt,
      physicalUsed: this.physicalUsed,
      sharedUsed: this.logicalUsed,
      accountUsed: this.logicalUsed,
      zoneUsed: {},
      accountLastAdmissionAt: this.state.accountLastAdmissionAt,
      zoneLastAdmissionAt: { ...this.state.zoneLastAdmissionAt },
      sharedNextAdmissionAt: this.state.sharedNextAdmissionAt,
      capacityWaitUntil: this.state.capacityWaitUntil,
      pausedUntil: this.state.pausedUntil,
      rateLimitedAt: this.state.rateLimitedAt,
      accountPausedUntil: this.state.accountPausedUntil,
      zonePausedUntil: { ...this.state.zonePausedUntil },
    };
  }

  get mode(): InitialGraphqlQuotaState["limiterMode"] { return this.state.limiterMode; }
  get fallbackLimit(): number { return this.activeSharedLimit; }

  hasReliableDebit(budgetKey: string): boolean {
    return (this.state.observedDebits[budgetKey] ?? 0) > 0
      && this.state.provisionalDebitKeys[budgetKey] !== true;
  }

  get waitReason(): "pacing" | "capacity" | "rate_limit" | null {
    this.compact();
    const now = Date.now();
    if (Math.max(this.state.pausedUntil ?? 0, this.state.accountPausedUntil ?? 0) > now) return "rate_limit";
    const capacityAt = (this.state.capacityWaitUntil ?? 0) > now
      ? this.state.capacityWaitUntil!
      : Number.POSITIVE_INFINITY;
    const pacingAt = (this.state.sharedNextAdmissionAt ?? 0) > now
      ? this.state.sharedNextAdmissionAt!
      : Number.POSITIVE_INFINITY;
    if (capacityAt < Number.POSITIVE_INFINITY || pacingAt < Number.POSITIVE_INFINITY) {
      return capacityAt <= pacingAt ? "capacity" : "pacing";
    }
    return null;
  }

  get resumeAt(): number | null {
    this.compact();
    const rateLimitAt = Math.max(this.state.pausedUntil ?? 0, this.state.accountPausedUntil ?? 0);
    if (rateLimitAt > Date.now()) return rateLimitAt;
    const candidates = [this.state.capacityWaitUntil, this.state.sharedNextAdmissionAt]
      .filter((value): value is number => value !== null && value > Date.now());
    return candidates.length ? Math.min(...candidates) : null;
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

  private compact(now = Date.now()): void {
    const expired = this.state.admissions.filter(admission => admission.admittedAt <= now - GRAPHQL_WINDOW_MS);
    if (expired.length && this.state.reportedRemaining !== null) {
      const released = expired.reduce((total, admission) => total + admission.budgetDebit, 0);
      this.state.reportedRemaining = Math.min(
        this.state.observedCapacity ?? Number.POSITIVE_INFINITY,
        this.state.reportedRemaining + released,
      );
    }
    this.state.admissions = this.state.admissions.filter(admission => (
      admission.admittedAt <= now && admission.admittedAt > now - GRAPHQL_WINDOW_MS
    ));
    if (!this.state.admissions.length
      && (expired.length > 0 || this.state.reportedAt && this.state.reportedAt <= now - GRAPHQL_WINDOW_MS)) {
      this.state.reportedRemaining = null;
      this.state.reportedAt = null;
      this.state.reportedForRequestAt = null;
      this.state.lastObservedRemaining = null;
      this.state.lastObservedAt = null;
      this.state.lastObservedRequestAt = null;
    }
    if (this.state.capacityWaitUntil && this.state.capacityWaitUntil <= now) this.state.capacityWaitUntil = null;
    if (this.state.pausedUntil && this.state.pausedUntil <= now) this.state.pausedUntil = null;
    if (!this.state.admissions.length
      && !this.state.pausedUntil
      && this.state.rateLimitedAt
      && now >= this.state.rateLimitedAt + GRAPHQL_WINDOW_MS) {
      this.state.limiterMode = "shared-paced";
      this.state.adaptiveLimit = null;
      this.state.rateLimitedAt = null;
    }
  }

  private capacityAvailableAt(logicalQueries: number, budgetKey = "", pageSize?: number, now = Date.now()): number {
    this.compact(now);
    const amount = Math.max(1, Math.floor(logicalQueries));
    const logicalUsed = this.logicalUsed;
    const physicalUsed = this.physicalUsed;
    const physicalAvailableAt = physicalUsed < INITIAL_PHYSICAL_GRAPHQL_QUOTA
      ? now
      : (this.state.admissions[0]?.admittedAt ?? now) + GRAPHQL_WINDOW_MS;
    if (this.state.reportedRemaining !== null) {
      const deficit = this.estimatedDebit(amount, budgetKey, pageSize) + GRAPHQL_REPORTED_BUDGET_RESERVE - this.reportedAvailable();
      let released = 0;
      let budgetAvailableAt = now;
      if (deficit > 0) {
        budgetAvailableAt = (this.state.admissions.at(-1)?.admittedAt ?? now) + GRAPHQL_WINDOW_MS;
        for (const admission of this.state.admissions) {
          released += admission.budgetDebit;
          if (released >= deficit) {
            budgetAvailableAt = admission.admittedAt + GRAPHQL_WINDOW_MS;
            break;
          }
        }
      }
      return Math.max(physicalAvailableAt, budgetAvailableAt);
    }
    if (logicalUsed + amount <= this.activeSharedLimit) return physicalAvailableAt;
    let released = 0;
    for (const admission of this.state.admissions) {
      released += admission.logicalQueries;
      if (logicalUsed - released + amount <= this.activeSharedLimit) {
        return Math.max(physicalAvailableAt, admission.admittedAt + GRAPHQL_WINDOW_MS);
      }
    }
    return Math.max(physicalAvailableAt, now + GRAPHQL_WINDOW_MS);
  }

  private estimatedCost(logicalQueries: number): number {
    return Math.max(
      1,
      this.state.observedCosts[String(logicalQueries)] ?? Math.ceil(logicalQueries * this.state.observedCostMultiplier),
    );
  }

  private estimatedDebit(logicalQueries: number, budgetKey: string, pageSize?: number): number {
    const observed = budgetKey ? this.state.observedDebits[budgetKey] : undefined;
    const observedRate = budgetKey ? this.state.observedDebitRates[budgetKey] : undefined;
    const requestedRows = pageSize ? Math.max(1, pageSize * logicalQueries) : null;
    const pageRate = observedRate ?? Math.max(DEFAULT_UNSEEN_PAGE_UNIT_DEBIT, this.state.observedMaxDebitRate);
    const shapedDebit = requestedRows === null ? null : Math.ceil(requestedRows * pageRate);
    const globalDebit = observed ?? this.unseenDebitBaseline();
    const debit = observedRate !== undefined && shapedDebit !== null
      ? shapedDebit
      : observed === undefined && shapedDebit !== null
        ? globalDebit > 0 ? Math.min(globalDebit, shapedDebit) : shapedDebit
        : globalDebit;
    const safety = observed === undefined ? GRAPHQL_BUDGET_DEBIT_SAFETY : 1.1;
    const estimate = Math.max(this.estimatedCost(logicalQueries), Math.ceil(debit * safety));
    return this.state.observedCapacity === null
      ? estimate
      : Math.min(estimate, Math.max(1, this.state.observedCapacity - GRAPHQL_REPORTED_BUDGET_RESERVE));
  }

  private pacingIntervalForDebit(debit: number): number {
    const usableCapacity = Math.max(
      1,
      (this.state.observedCapacity ?? 0) - GRAPHQL_REPORTED_BUDGET_RESERVE,
    );
    if (this.state.observedCapacity === null || debit <= 0) return GRAPHQL_MIN_QUERY_INTERVAL_MS;
    return Math.max(
      GRAPHQL_MIN_QUERY_INTERVAL_MS,
      Math.ceil(GRAPHQL_WINDOW_MS * Math.min(debit, usableCapacity) / usableCapacity),
    );
  }

  private pacingAvailableAt(logicalQueries: number, budgetKey: string, pageSize?: number): number {
    const previous = this.state.admissions.at(-1);
    if (!previous) return Date.now();
    const previousDebit = previous.budgetDebit > 0
      ? previous.budgetDebit
      : this.estimatedDebit(previous.logicalQueries, previous.budgetKey);
    const nextDebit = this.estimatedDebit(logicalQueries, budgetKey, pageSize);
    return previous.admittedAt + this.pacingIntervalForDebit(Math.ceil((previousDebit + nextDebit) / 2));
  }

  private assertRemoteWorkTime(): void {
    if (!this.runBudget) return;
    const remaining = this.runBudget.remaining("wallMs");
    if (remaining >= INITIAL_REMOTE_WORK_WALL_RESERVE_MS) return;
    throw new LedgerBudgetExceededError(
      "wallMs",
      this.runBudget.limits.wallMs - remaining,
      this.runBudget.limits.wallMs,
    );
  }

  private unseenDebitBaseline(excludeBudgetKey?: string): number {
    const debits = Object.entries(this.state.observedDebits)
      .filter(([budgetKey, value]) => (
        budgetKey !== excludeBudgetKey
        && this.state.provisionalDebitKeys[budgetKey] !== true
        && Number.isFinite(value)
        && value > 0
      ))
      .map(([, value]) => value)
      .sort((left, right) => left - right);
    if (debits.length < 12) return debits.at(-1) ?? this.state.observedMaxCost;
    return debits[Math.max(0, Math.ceil(debits.length * 0.9) - 1)] ?? this.state.observedMaxDebit;
  }

  private reportedAvailable(): number {
    if (this.state.reportedRemaining === null) return Number.POSITIVE_INFINITY;
    return this.state.reportedRemaining;
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

function initialSliceLogicalQueries(metadata: InitialIngestionSliceMetadata): number {
  return Math.max(1, metadata.zoneIds.length);
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
    accounting: "logical_queries",
    limiterMode: "shared-paced",
    adaptiveLimit: null,
    reportedRemaining: null,
    reportedAt: null,
    reportedForRequestAt: null,
    observedCapacity: null,
    observedMaxCost: 0,
    observedMaxDebit: 0,
    lastObservedRemaining: null,
    lastObservedAt: null,
    lastObservedRequestAt: null,
    observedCostMultiplier: 1,
    observedCosts: {},
    observedDebits: {},
    provisionalDebitKeys: {},
    observedDebitRates: {},
    observedMaxDebitRate: 0,
    admissions: [],
    accountLastAdmissionAt: null,
    zoneLastAdmissionAt: {},
    sharedNextAdmissionAt: null,
    capacityWaitUntil: null,
    pausedUntil: null,
    rateLimitedAt: null,
    accountPausedUntil: null,
    zonePausedUntil: {},
  };
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as Omit<Partial<InitialGraphqlQuotaState>, "accounting"> & {
        used?: number;
        sharedUsed?: number;
        physicalUsed?: number;
        windowStartedAt?: number;
        accounting?: "logical_queries" | "physical_requests";
      };
      const sameJob = parsed.jobId === jobId;
      const persistedPause = Number.isFinite(parsed.pausedUntil) && Number(parsed.pausedUntil) > now;
      const retainFallback = sameJob || persistedPause;
      state.limiterMode = retainFallback && parsed.limiterMode === "shared-fallback" ? "shared-fallback" : "shared-paced";
      state.adaptiveLimit = retainFallback && Number.isFinite(parsed.adaptiveLimit)
        ? Math.max(MIN_ADAPTIVE_SHARED_QUERY_QUOTA, Math.min(sharedLimit, Number(parsed.adaptiveLimit)))
        : null;
      state.reportedRemaining = sameJob && Number.isFinite(parsed.reportedRemaining)
        ? Math.max(0, Math.floor(Number(parsed.reportedRemaining)))
        : null;
      state.reportedAt = sameJob && Number.isFinite(parsed.reportedAt)
        ? Number(parsed.reportedAt)
        : null;
      state.reportedForRequestAt = sameJob && Number.isFinite(parsed.reportedForRequestAt)
        ? Number(parsed.reportedForRequestAt)
        : null;
      state.observedCapacity = sameJob && Number.isFinite(parsed.observedCapacity)
        ? Math.max(1, Math.floor(Number(parsed.observedCapacity)))
        : null;
      state.observedMaxCost = sameJob && Number.isFinite(parsed.observedMaxCost)
        ? Math.max(0, Math.floor(Number(parsed.observedMaxCost)))
        : 0;
      state.observedMaxDebit = sameJob && Number.isFinite(parsed.observedMaxDebit)
        ? Math.max(0, Number(parsed.observedMaxDebit))
        : 0;
      state.lastObservedRemaining = sameJob && Number.isFinite(parsed.lastObservedRemaining)
        ? Math.max(0, Number(parsed.lastObservedRemaining))
        : null;
      state.lastObservedAt = sameJob && Number.isFinite(parsed.lastObservedAt)
        ? Number(parsed.lastObservedAt)
        : null;
      state.lastObservedRequestAt = sameJob && Number.isFinite(parsed.lastObservedRequestAt)
        ? Number(parsed.lastObservedRequestAt)
        : null;
      state.observedCostMultiplier = sameJob && Number.isFinite(parsed.observedCostMultiplier)
        ? Math.max(1, Number(parsed.observedCostMultiplier))
        : 1;
      state.observedCosts = sameJob && parsed.observedCosts && typeof parsed.observedCosts === "object"
        ? Object.fromEntries(Object.entries(parsed.observedCosts).flatMap(([logicalQueries, cost]) => {
          const normalized = Number(cost);
          return Number.isFinite(normalized) && normalized > 0
            ? [[logicalQueries, Math.floor(normalized)]]
            : [];
        }))
        : {};
      state.observedDebits = sameJob && parsed.observedDebits && typeof parsed.observedDebits === "object"
        ? Object.fromEntries(Object.entries(parsed.observedDebits).flatMap(([budgetKey, debit]) => {
          const normalized = Number(debit);
          return Number.isFinite(normalized) && normalized >= 0 ? [[budgetKey, normalized]] : [];
        }))
        : {};
      state.provisionalDebitKeys = sameJob && parsed.provisionalDebitKeys && typeof parsed.provisionalDebitKeys === "object"
        ? Object.fromEntries(Object.entries(parsed.provisionalDebitKeys).flatMap(([budgetKey, provisional]) => (
          provisional === true ? [[budgetKey, true as const]] : []
        )))
        : {};
      if (sameJob && !Object.keys(state.provisionalDebitKeys).length && state.observedCapacity !== null) {
        const legacyFullWindowDebit = Math.max(
          1,
          Math.floor((state.observedCapacity - GRAPHQL_REPORTED_BUDGET_RESERVE) / 1.1),
        );
        for (const [budgetKey, debit] of Object.entries(state.observedDebits)) {
          const legacyTolerance = Math.max(1, Math.ceil(state.observedCapacity * 0.01));
          if (Math.abs(debit - legacyFullWindowDebit) <= legacyTolerance) {
            state.provisionalDebitKeys[budgetKey] = true;
          }
        }
      }
      state.observedDebitRates = sameJob && parsed.observedDebitRates && typeof parsed.observedDebitRates === "object"
        ? Object.fromEntries(Object.entries(parsed.observedDebitRates).flatMap(([budgetKey, debitRate]) => {
          const normalized = Number(debitRate);
          return Number.isFinite(normalized) && normalized >= 0 ? [[budgetKey, normalized]] : [];
        }))
        : {};
      state.observedMaxDebitRate = sameJob && Number.isFinite(parsed.observedMaxDebitRate)
        ? Math.max(0, Number(parsed.observedMaxDebitRate))
        : 0;
      state.admissions = Array.isArray(parsed.admissions)
        ? parsed.admissions.flatMap(admission => {
          const admittedAt = Number(admission?.admittedAt);
          const logicalQueries = Number(admission?.logicalQueries);
          const physicalRequests = Number(admission?.physicalRequests ?? 1);
          const budgetDebit = Number(admission?.budgetDebit ?? 0);
          const budgetKey = typeof admission?.budgetKey === "string" ? admission.budgetKey : "";
          return Number.isFinite(admittedAt)
            && admittedAt > now - 24 * 60 * 60_000
            && admittedAt <= now
            && Number.isFinite(logicalQueries)
            && logicalQueries > 0
            && Number.isFinite(physicalRequests)
            && physicalRequests > 0
            && Number.isFinite(budgetDebit)
            && budgetDebit >= 0
            ? [{
              admittedAt,
              logicalQueries: Math.floor(logicalQueries),
              physicalRequests: Math.floor(physicalRequests),
              budgetDebit,
              budgetKey,
            }]
            : [];
        }).sort((left, right) => left.admittedAt - right.admittedAt)
          .slice(-INITIAL_PHYSICAL_GRAPHQL_QUOTA)
        : [];
      const latestPersistedAdmissionAt = state.admissions.at(-1)?.admittedAt ?? 0;
      if (latestPersistedAdmissionAt && latestPersistedAdmissionAt <= now - GRAPHQL_WINDOW_MS) {
        state.admissions = [];
        state.reportedRemaining = null;
        state.reportedAt = null;
        state.reportedForRequestAt = null;
        state.lastObservedRemaining = null;
        state.lastObservedAt = null;
        state.lastObservedRequestAt = null;
      }
      const legacyLastAdmissionAt = Number(parsed.accountLastAdmissionAt ?? parsed.windowStartedAt);
      const activeLegacyEpoch = !state.admissions.length
        && Number.isFinite(legacyLastAdmissionAt)
        && now - legacyLastAdmissionAt < GRAPHQL_WINDOW_MS
        && now >= legacyLastAdmissionAt;
      if (activeLegacyEpoch) {
        const legacyUsed = Number.isFinite(parsed.used) ? Number(parsed.used) : 0;
        const logicalAccounting = parsed.accounting === "logical_queries";
        const logicalQueries = boundedUsage(
          logicalAccounting ? parsed.sharedUsed : parsed.physicalUsed ?? legacyUsed,
          sharedLimit,
        );
        if (logicalQueries > 0) {
          state.admissions = [{
            admittedAt: legacyLastAdmissionAt,
            logicalQueries,
            physicalRequests: boundedUsage(parsed.physicalUsed ?? legacyUsed, INITIAL_PHYSICAL_GRAPHQL_QUOTA),
            budgetDebit: 0,
            budgetKey: "",
          }];
        }
      }
      state.accountLastAdmissionAt = boundedAdmissionAt(parsed.accountLastAdmissionAt, now);
      state.zoneLastAdmissionAt = Object.fromEntries(Object.entries(parsed.zoneLastAdmissionAt ?? {}).flatMap(([zoneId, admittedAt]) => {
        const bounded = boundedAdmissionAt(admittedAt, now);
        return bounded === null ? [] : [[zoneId, bounded]];
      }));
      state.pausedUntil = Number.isFinite(parsed.pausedUntil) && Number(parsed.pausedUntil) > now
        ? Number(parsed.pausedUntil)
        : null;
      state.rateLimitedAt = Number.isFinite(parsed.rateLimitedAt)
        ? Number(parsed.rateLimitedAt)
        : state.pausedUntil ? state.pausedUntil - GRAPHQL_WINDOW_MS : null;
      state.accountPausedUntil = boundedPauseAt(parsed.accountPausedUntil, now);
      state.zonePausedUntil = Object.fromEntries(Object.entries(parsed.zonePausedUntil ?? {}).flatMap(([zoneId, until]) => {
        const bounded = boundedPauseAt(until, now);
        return bounded === null ? [] : [[zoneId, bounded]];
      }));
      state.sharedNextAdmissionAt = boundedFutureAdmissionAt(parsed.sharedNextAdmissionAt, now);
      state.capacityWaitUntil = boundedPauseAt(parsed.capacityWaitUntil, now);
      if (!sameJob) state.jobId = jobId;
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
  return Number.isFinite(parsed) && parsed <= now && parsed > now - GRAPHQL_WINDOW_MS ? parsed : null;
}

function boundedFutureAdmissionAt(value: unknown, now: number): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > now - GRAPHQL_WINDOW_MS && parsed < now + GRAPHQL_WINDOW_MS ? parsed : null;
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
