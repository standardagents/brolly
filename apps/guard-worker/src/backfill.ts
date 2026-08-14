import { type DurableObjectUsageCursor, CloudflareClient } from "./cloudflare.js";
import { evaluateUsageAlerts } from "./alert-engine.js";
import type { Env } from "./env.js";
import { expandUsageObservations, LedgerStore } from "./ledger-store.js";
import type { LedgerRunBudget } from "@standardagents/brolly-core";

interface SliceRow {
  id: string;
  backfill_job_id: string;
  collector_key: string;
  starts_at: number;
  ends_at: number;
  cursor_json: string | null;
}

export async function ensureOnboardingBackfill(
  db: D1Database,
  accountId: string,
  now = Date.now(),
): Promise<{ jobs: number; slices: number }> {
  const existing = await db.prepare(
    `SELECT 1 AS present FROM backfill_jobs WHERE account_id=?1 LIMIT 1`,
  ).bind(accountId).first<{ present: number }>();
  if (existing) return { jobs: 0, slices: 0 };
  const capabilityRows = await db.prepare(
    `SELECT DISTINCT collector_key FROM collector_capabilities
     WHERE account_id=?1 AND available=1 AND collector_key LIKE 'graphql:%' LIMIT 50`,
  ).bind(accountId).all<{ collector_key: string }>();
  const collectors = capabilityRows.results.length
    ? capabilityRows.results.map(row => row.collector_key)
    : ["graphql:durable-objects", "graphql:workers"];
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const phases = [
    { startsAt: now - 86_400_000, endsAt: now },
    { startsAt: monthStart, endsAt: now - 86_400_000 },
    { startsAt: now - 730 * 86_400_000, endsAt: monthStart },
  ].filter(phase => phase.startsAt < phase.endsAt);
  let slices = 0;
  const statements: D1PreparedStatement[] = [];
  for (const phase of phases) {
    const jobId = crypto.randomUUID();
    statements.push(db.prepare(
      `INSERT INTO backfill_jobs(
         id,account_id,requested_start_at,requested_end_at,newest_first,status,created_at,updated_at
       ) VALUES(?1,?2,?3,?4,1,'pending',?5,?5)`,
    ).bind(jobId, accountId, phase.startsAt, phase.endsAt, now));
    for (let end = phase.endsAt; end > phase.startsAt; end -= 86_400_000) {
      const start = Math.max(phase.startsAt, end - 86_400_000);
      for (const collector of collectors) {
        statements.push(db.prepare(
          `INSERT INTO backfill_slices(
             id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at
           ) VALUES(?1,?2,?3,'',?4,?5,'pending','missing',?6)`,
        ).bind(crypto.randomUUID(), jobId, collector, start, end, now));
        slices += 1;
      }
    }
  }
  for (let offset = 0; offset < statements.length; offset += 100) {
    await db.batch(statements.slice(offset, offset + 100));
  }
  return { jobs: phases.length, slices };
}

export async function runOneBackfillSlice(
  env: Env,
  client: CloudflareClient,
  ledger: LedgerStore,
  budget: LedgerRunBudget,
  timeZone: string,
): Promise<{ worked: boolean; complete: boolean; samples: number }> {
  if (budget.remaining("graphqlQueries") < 16 || budget.remaining("d1RowsWritten") < 1_000 || budget.remaining("wallMs") < 8_000) {
    return { worked: false, complete: false, samples: 0 };
  }
  const slice = await env.DB.prepare(
    `SELECT s.* FROM backfill_slices s JOIN backfill_jobs j ON j.id=s.backfill_job_id
     WHERE s.status='pending' AND j.status IN ('pending','running')
     ORDER BY s.ends_at DESC,s.collector_key LIMIT 1`,
  ).first<SliceRow>();
  budget.charge("d1RowsRead", slice ? 1 : 0);
  if (!slice) return { worked: false, complete: true, samples: 0 };
  budget.charge("backfillSlices");
  const claimed = await env.DB.prepare(
    `UPDATE backfill_slices SET status='running',updated_at=?2 WHERE id=?1 AND status='pending'`,
  ).bind(slice.id, Date.now()).run();
  budget.charge("d1RowsWritten", Number(claimed.meta.rows_written ?? claimed.meta.changes ?? 0));
  if (Number(claimed.meta.changes ?? 0) !== 1) return { worked: false, complete: false, samples: 0 };
  try {
    let observations;
    let complete = true;
    let cursor: unknown;
    if (slice.collector_key.includes("durable")) {
      const result = await client.durableObjectUsagePaged(slice.starts_at, slice.ends_at, {
        cursor: parseCursor(slice.cursor_json), maxPages: 2,
      });
      complete = result.complete;
      cursor = result.continuation;
      observations = expandUsageObservations(
        result.samples, "graphql:durable-objects", "durable-object-usage",
        result.complete ? "complete" : "partial",
        { watermarkAt: result.watermarkAt, historical: true },
      );
    } else if (slice.collector_key.includes("workers")) {
      const result = await client.workerUsage(slice.starts_at, slice.ends_at, {
        cursor: parseWorkerCursor(slice.cursor_json),
        maxPages: 2,
      });
      complete = result.complete;
      cursor = result.continuation;
      observations = expandUsageObservations(
        result.samples, "graphql:workers", "workersInvocationsAdaptive",
        result.complete ? "complete" : "partial",
        { watermarkAt: slice.ends_at, historical: true },
      );
    } else {
      await finishSlice(env.DB, budget, slice, "complete", null, "Collector has no historical implementation", "missing");
      return { worked: true, complete: true, samples: 0 };
    }
    const changes = await ledger.applyObservations(observations, timeZone);
    const cycle = await ledger.currentBillingCycle(env.BROLLY_ACCOUNT_ID, slice.ends_at - 1);
    await evaluateUsageAlerts(env, changes, {
      timeZone, billingCycleId: cycle.id, billingCycleStart: cycle.startsAt,
      billingCycleEnd: cycle.endsAt, now: Date.now(), budget,
    });
    await finishSlice(
      env.DB, budget, slice, complete ? "complete" : "pending", cursor,
      complete ? null : "Continuation saved after the bounded page budget", complete ? "complete" : "partial",
    );
    await updateJobStatus(env.DB, budget, slice.backfill_job_id);
    return { worked: true, complete, samples: observations.length };
  } catch (error) {
    await finishSlice(
      env.DB, budget, slice, "pending", parseCursor(slice.cursor_json),
      error instanceof Error ? error.message : String(error), "missing", true,
    );
    return { worked: true, complete: false, samples: 0 };
  }
}

async function finishSlice(
  db: D1Database,
  budget: LedgerRunBudget,
  slice: SliceRow,
  status: string,
  cursor: unknown,
  error: string | null,
  coverage: string,
  retry = false,
): Promise<void> {
  const result = await db.prepare(
    `UPDATE backfill_slices SET
       status=?2,cursor_json=?3,error=?4,coverage_status=?5,
       retry_count=retry_count+?6,updated_at=?7 WHERE id=?1`,
  ).bind(
    slice.id, status, cursor ? JSON.stringify(cursor) : null, error?.slice(0, 2000) ?? null,
    coverage, retry ? 1 : 0, Date.now(),
  ).run();
  budget.charge("d1RowsWritten", Number(result.meta.rows_written ?? result.meta.changes ?? 0));
}

async function updateJobStatus(db: D1Database, budget: LedgerRunBudget, jobId: string): Promise<void> {
  const result = await db.prepare(
    `UPDATE backfill_jobs SET
       status=CASE WHEN EXISTS(
         SELECT 1 FROM backfill_slices WHERE backfill_job_id=?1 AND status!='complete'
       ) THEN 'running' ELSE 'complete' END,
       updated_at=?2 WHERE id=?1`,
  ).bind(jobId, Date.now()).run();
  budget.charge("d1RowsWritten", Number(result.meta.rows_written ?? result.meta.changes ?? 0));
}

function parseCursor(value: string | null): DurableObjectUsageCursor | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as DurableObjectUsageCursor; } catch { return undefined; }
}

function parseWorkerCursor(value: string | null): import("./cloudflare.js").WorkerUsageCursor | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as import("./cloudflare.js").WorkerUsageCursor; } catch { return undefined; }
}
