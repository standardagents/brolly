import {
  INITIAL_INGESTION_LIMITS,
  LedgerRunBudget,
  RunBudget,
} from "@standardagents/brolly-core";
import { CloudflareClient } from "./cloudflare.js";
import type { Env } from "./env.js";
import { LedgerStore } from "./ledger-store.js";
import { configuredBillingToken } from "./credentials.js";
import { runOneBackfillSlice } from "./backfill.js";

const DAY_MS = 86_400_000;
const NINETY_DAYS_MS = 90 * DAY_MS;
const MAX_SLICE_MS = 32 * DAY_MS;

export const INITIAL_USAGE_COLLECTORS = [
  { collector: "graphql:durable-objects", label: "Durable Objects", dataset: "durable-object-usage" },
  { collector: "graphql:workers", label: "Workers", dataset: "workersInvocationsAdaptive" },
] as const;

export const INITIAL_BILLING_COLLECTOR = {
  collector: "billing",
  label: "Billing",
  dataset: "billable-usage",
} as const;

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
}

export interface InitialIngestionProgress {
  job: {
    id: string;
    status: string;
    startedAt: number | null;
    updatedAt: number;
  } | null;
  collectors: Array<{
    collector: string;
    label: string;
    total: number;
    complete: number;
    failed: number;
    oldestCompleteAt: number | null;
  }>;
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
 * Create the single initial job and its fixed 90-day slices.  The partial
 * unique index in migration 0004 makes this safe when two onboarding tabs race.
 */
export async function ensureInitialIngestionJob(
  db: D1Database,
  accountId: string,
  options: { billingAvailable?: boolean; now?: number } = {},
): Promise<InitialIngestionJobResult> {
  const now = options.now ?? Date.now();
  const existing = await db.prepare(
    `SELECT id,status,updated_at FROM backfill_jobs
     WHERE account_id=?1 AND kind='initial' LIMIT 1`,
  ).bind(accountId).first<{ id: string; status: string; updated_at: number }>();
  if (existing) {
    const count = await db.prepare(
      `SELECT COUNT(*) AS count FROM backfill_slices WHERE backfill_job_id=?1`,
    ).bind(existing.id).first<{ count: number }>();
    return { id: existing.id, created: false, status: existing.status, slices: Number(count?.count ?? 0) };
  }

  const startsAt = now - NINETY_DAYS_MS;
  const jobId = crypto.randomUUID();
  const billingAvailable = options.billingAvailable === true;
  const slices = initialIngestionSlicePlan(now, billingAvailable);

  const statements: D1PreparedStatement[] = [db.prepare(
    `INSERT INTO backfill_jobs(
       id,account_id,kind,requested_start_at,requested_end_at,newest_first,status,created_at,updated_at
     ) VALUES(?1,?2,'initial',?3,?4,1,'pending',?5,?5)`,
  ).bind(jobId, accountId, startsAt, now, now)];
  for (const slice of slices) {
    statements.push(db.prepare(
      `INSERT INTO backfill_slices(
         id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,
         retry_count,next_eligible_at,coverage_status,updated_at
       ) VALUES(?1,?2,?3,'',?4,?5,'pending',0,?6,'missing',?7)`,
    ).bind(crypto.randomUUID(), jobId, slice.collector, slice.startsAt, slice.endsAt, now, now));
  }
  try {
    for (let offset = 0; offset < statements.length; offset += 100) {
      await db.batch(statements.slice(offset, offset + 100));
    }
  } catch (error) {
    // Another isolate may have won the unique initial-job race.
    const raced = await db.prepare(
      `SELECT id,status,updated_at FROM backfill_jobs
       WHERE account_id=?1 AND kind='initial' LIMIT 1`,
    ).bind(accountId).first<{ id: string; status: string; updated_at: number }>();
    if (!raced) throw error;
    const count = await db.prepare(`SELECT COUNT(*) AS count FROM backfill_slices WHERE backfill_job_id=?1`).bind(raced.id).first<{ count: number }>();
    return { id: raced.id, created: false, status: raced.status, slices: Number(count?.count ?? 0) };
  }
  return { id: jobId, created: true, status: "pending", slices: slices.length };
}

/** Return the immutable newest-first import plan for a given request time. */
export function initialIngestionSlicePlan(now: number, billingAvailable: boolean): InitialIngestionSlicePlan[] {
  const startsAt = now - NINETY_DAYS_MS;
  const slices: InitialIngestionSlicePlan[] = [];
  for (const collector of INITIAL_USAGE_COLLECTORS) {
    for (let end = now; end > startsAt;) {
      const start = Math.max(startsAt, end - MAX_SLICE_MS);
      slices.push({ collector: collector.collector, startsAt: start, endsAt: end });
      end = start;
    }
  }
  if (billingAvailable) slices.push({ collector: INITIAL_BILLING_COLLECTOR.collector, startsAt, endsAt: now });
  return slices;
}

/** Build the progress response directly from backfill_slices counts. */
export async function initialIngestionProgress(
  db: D1Database,
  accountId: string,
): Promise<InitialIngestionProgress> {
  const [job, rows] = await Promise.all([
    db.prepare(
      `SELECT id,status,created_at,updated_at FROM backfill_jobs
       WHERE account_id=?1 AND kind='initial' LIMIT 1`,
    ).bind(accountId).first<{ id: string; status: string; created_at: number; updated_at: number }>(),
    db.prepare(
      `SELECT s.collector_key,
         COUNT(*) AS total,
         SUM(CASE WHEN s.status='complete' THEN 1 ELSE 0 END) AS complete,
         SUM(CASE WHEN s.status='failed' OR (s.status='complete' AND s.coverage_status!='complete') THEN 1 ELSE 0 END) AS failed,
         MIN(CASE WHEN s.status='complete' THEN s.starts_at END) AS oldest_complete_at
       FROM backfill_slices s JOIN backfill_jobs j ON j.id=s.backfill_job_id
       WHERE j.account_id=?1 AND j.kind='initial'
       GROUP BY s.collector_key ORDER BY s.collector_key`,
    ).bind(accountId).all<{ collector_key: string; total: number; complete: number; failed: number; oldest_complete_at: number | null }>(),
  ]);
  return {
    job: job ? {
      id: job.id, status: job.status, startedAt: job.created_at, updatedAt: job.updated_at,
    } : null,
    collectors: rows.results.map(row => ({
      collector: row.collector_key,
      label: collectorLabel(row.collector_key),
      total: Number(row.total ?? 0), complete: Number(row.complete ?? 0), failed: Number(row.failed ?? 0),
      oldestCompleteAt: row.oldest_complete_at == null ? null : Number(row.oldest_complete_at),
    })),
  };
}

/**
 * Drain eligible slices for one initial job.  A fresh budget belongs to this
 * invocation and is never shared with the recurring monitor.
 */
export async function runInitialIngestion(
  env: Env,
  jobId: string,
  now = Date.now(),
): Promise<void> {
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
  while (true) {
    if (ledgerBudget.remaining("wallMs") < 8_000 || budget.remaining("wallMs") < 8_000) break;
    const result = await runOneBackfillSlice(env, client, ledger, ledgerBudget, timeZone, { jobId, kind: "initial" });
    if (!result.worked) break;
  }
}

function collectorLabel(collector: string): string {
  if (collector === INITIAL_BILLING_COLLECTOR.collector) return INITIAL_BILLING_COLLECTOR.label;
  return INITIAL_USAGE_COLLECTORS.find(item => item.collector === collector)?.label ?? collector;
}
