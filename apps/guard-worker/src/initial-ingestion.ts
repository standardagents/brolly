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
import { HISTORICAL_DATASETS, type HistoricalDatasetCapability } from "./historical-analytics.js";

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 90;
const BILLING_MAX_DAYS = 31;
const INITIAL_KIND = "initial_v2";
const LEGACY_INITIAL_KIND = "initial";

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

  try {
    const discoveryLedger = new LedgerRunBudget({
      graphqlQueries: 300,
      restRequests: 20,
      d1RowsRead: 1_000,
      d1RowsWritten: 1_000,
      backfillSlices: 1,
      wallMs: 45_000,
    });
    const discoveryBudget = new RunBudget({ apiCalls: 320, databaseRows: 2_000, samples: 1, wallMs: 45_000 });
    const capabilities = await new CloudflareClient(env, discoveryBudget, discoveryLedger).historicalCapabilities();
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
  } catch (error) {
    await env.DB.prepare(`UPDATE backfill_jobs SET status='planning_failed',updated_at=?2 WHERE id=?1`).bind(jobId, Date.now()).run();
    throw error;
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
    for (const group of groupEquivalentCapabilities(enabled)) {
      for (let offset = 0; offset < group.length; offset += 10) {
        const chunk = group.slice(offset, offset + 10);
        slices.push(...rangeSlices(spec.collector, spec.dataset, chunk.flatMap(item => item.zoneId ? [item.zoneId] : []), now, mergedCapability(chunk)));
      }
    }
    for (let offset = 0; offset < unavailable.length; offset += 10) {
      const chunk = unavailable.slice(offset, offset + 10);
      slices.push(gapSlice(
        spec.collector,
        spec.dataset,
        chunk.flatMap(item => item.zoneId ? [item.zoneId] : []),
        now,
        chunk[0]?.detail ?? "Cloudflare denied access to this zone dataset.",
        capabilityRetentionDays(chunk[0], spec.retentionDays),
      ));
    }
  }
  if (billingAvailable) slices.push(...boundedRanges("billing", "billable-usage", [], now, HISTORY_DAYS, BILLING_MAX_DAYS, 10_000));
  return slices.sort((left, right) => right.endsAt - left.endsAt || left.collector.localeCompare(right.collector));
}

/** Return progress weighted by dataset-days (and zone-days), not request count. */
export async function initialIngestionProgress(db: D1Database, accountId: string): Promise<InitialIngestionProgress> {
  const job = await db.prepare(
    `SELECT id,status,created_at,updated_at,kind FROM backfill_jobs
     WHERE account_id=?1 AND kind IN (?2,?3)
     ORDER BY CASE kind WHEN ?2 THEN 0 ELSE 1 END,created_at DESC LIMIT 1`,
  ).bind(accountId, INITIAL_KIND, LEGACY_INITIAL_KIND).first<{ id: string; status: string; created_at: number; updated_at: number; kind: string }>();
  if (!job) return { job: null, collectors: [] };
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
  };
}

/** Drain bounded v2 slices with a fresh budget isolated from monitoring. */
export async function runInitialIngestion(env: Env, jobId: string): Promise<void> {
  const ledgerBudget = new LedgerRunBudget(INITIAL_INGESTION_LIMITS);
  const budget = new RunBudget({
    apiCalls: INITIAL_INGESTION_LIMITS.graphqlQueries + INITIAL_INGESTION_LIMITS.restRequests,
    databaseRows: INITIAL_INGESTION_LIMITS.d1RowsRead + INITIAL_INGESTION_LIMITS.d1RowsWritten,
    samples: 100_000,
    wallMs: INITIAL_INGESTION_LIMITS.wallMs,
  });
  const client = new CloudflareClient(env, budget, ledgerBudget);
  const ledger = new LedgerStore(env.DB, ledgerBudget);
  const timeZone = env.BROLLY_TIMEZONE ?? "UTC";
  while (ledgerBudget.remaining("backfillSlices") > 0 && ledgerBudget.remaining("wallMs") >= 8_000) {
    const worked = await runOneInitialSlice(env, client, ledger, ledgerBudget, jobId, timeZone);
    if (!worked) break;
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

async function runOneInitialSlice(
  env: Env,
  client: CloudflareClient,
  ledger: LedgerStore,
  budget: LedgerRunBudget,
  jobId: string,
  timeZone: string,
): Promise<boolean> {
  const slice = await env.DB.prepare(
    `SELECT * FROM backfill_slices
     WHERE backfill_job_id=?1 AND status='pending' AND (next_eligible_at IS NULL OR next_eligible_at<=?2)
     ORDER BY ends_at DESC,collector_key LIMIT 1`,
  ).bind(jobId, Date.now()).first<InitialSliceRow>();
  budget.charge("d1RowsRead", slice ? 1 : 0);
  if (!slice) {
    await updateInitialJobStatus(env.DB, jobId, budget);
    return false;
  }
  const metadata = parseSliceMetadata(slice.scope_key, slice.starts_at, slice.ends_at);
  const requiredQueries = slice.collector_key === "billing" ? 0 : Math.max(1, metadata.zoneIds.length);
  if (budget.remaining("backfillSlices") < 1
    || budget.remaining("d1RowsWritten") < 1_000
    || budget.remaining("d1RowsRead") < 10_000
    || budget.remaining("wallMs") < 8_000
    || budget.remaining("graphqlQueries") < requiredQueries
    || slice.collector_key === "billing" && budget.remaining("restRequests") < 1) return false;

  budget.charge("backfillSlices");
  const claimed = await env.DB.prepare(
    `UPDATE backfill_slices SET status='running',updated_at=?2 WHERE id=?1 AND status='pending'`,
  ).bind(slice.id, Date.now()).run();
  chargeMeta(budget, claimed.meta);
  if (Number(claimed.meta.changes ?? 0) !== 1) return false;
  await env.DB.prepare(`UPDATE backfill_jobs SET status='running',updated_at=?2 WHERE id=?1`).bind(jobId, Date.now()).run();

  try {
    if (slice.collector_key === "billing") {
      const result = await ingestWindow({
        env,
        client,
        ledger,
        collector: "billing",
        startsAt: slice.starts_at,
        endsAt: slice.ends_at,
        budget,
        timeZone,
        historical: true,
      });
      if (!result.complete) throw new Error(result.coverage[0]?.detail ?? "Billing history was incomplete");
    } else {
      const result = await client.historicalUsage({
        dataset: metadata.dataset,
        startsAt: slice.starts_at,
        endsAt: slice.ends_at,
        maxPageSize: metadata.maxPageSize,
        zoneIds: metadata.zoneIds,
      });
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
        await finishSlice(env.DB, budget, slice.id, "failed", "Cloudflare's row limit was reached for a single day; retained rows are marked partial", "partial");
        await updateInitialJobStatus(env.DB, jobId, budget);
        return true;
      }
    }
    await finishSlice(env.DB, budget, slice.id, "complete", null, "complete");
    await updateInitialJobStatus(env.DB, jobId, budget);
    return true;
  } catch (error) {
    if (error instanceof LedgerBudgetExceededError || error instanceof MonitoringBudgetExceededError) {
      if (calendarDays(slice.starts_at, slice.ends_at) > 1) {
        await splitSlice(env.DB, slice, metadata, "bounded persistence budget");
        await updateInitialJobStatus(env.DB, jobId);
        return false;
      }
      const previous = Math.min(3, Number(slice.retry_count ?? 0));
      const failed = previous >= 3;
      const retryCount = failed ? 3 : previous + 1;
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
    const result = await env.DB.prepare(
      `UPDATE backfill_slices SET status=?2,error=?3,retry_count=?4,next_eligible_at=?5,coverage_status='missing',updated_at=?6 WHERE id=?1`,
    ).bind(slice.id, failed ? "failed" : "pending", errorMessage(error).slice(0, 2_000), retryCount, nextEligibleAt, Date.now()).run();
    chargeMeta(budget, result.meta);
    await updateInitialJobStatus(env.DB, jobId, budget);
    return true;
  }
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
      scopeKey: serializeMetadata({ version: 2, dataset, zoneIds, maxPageSize, units }),
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
    scopeKey: serializeMetadata({ version: 2, dataset, zoneIds, maxPageSize: 10_000, units: calendarDays(startsAt, now) * Math.max(1, zoneIds.length) }),
    status: "failed",
    coverageStatus: "missing",
    error: `${dataset}: ${detail}`,
  };
}

function groupEquivalentCapabilities(values: HistoricalDatasetCapability[]): HistoricalDatasetCapability[][] {
  const groups = new Map<string, HistoricalDatasetCapability[]>();
  for (const value of values) {
    const key = [value.maxDurationSeconds, value.notOlderThanSeconds, value.maxPageSize].join(":");
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return [...groups.values()];
}

function mergedCapability(values: HistoricalDatasetCapability[]): HistoricalDatasetCapability {
  const first = values[0]!;
  return {
    ...first,
    maxDurationSeconds: Math.min(...values.map(item => item.maxDurationSeconds)),
    notOlderThanSeconds: Math.min(...values.map(item => item.notOlderThanSeconds)),
    maxPageSize: Math.min(...values.map(item => item.maxPageSize)),
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
