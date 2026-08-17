import { type DurableObjectUsageCursor, CloudflareClient } from "./cloudflare.js";
import type { Env } from "./env.js";
import { LedgerStore } from "./ledger-store.js";
import type { LedgerRunBudget } from "@standardagents/brolly-core";
import { ingestWindow, type UsageCollector } from "./ingest.js";
import { productUsageDefinition } from "./product-usage.js";

interface SliceRow {
  id: string;
  backfill_job_id: string;
  collector_key: string;
  starts_at: number;
  ends_at: number;
  cursor_json: string | null;
  retry_count?: number;
}

export async function runOneBackfillSlice(
  env: Env,
  client: CloudflareClient,
  ledger: LedgerStore,
  budget: LedgerRunBudget,
  timeZone: string,
  options: { jobId?: string; kind?: string } = {},
): Promise<{ worked: boolean; complete: boolean; samples: number }> {
  if (budget.remaining("d1RowsWritten") < 1_000 || budget.remaining("wallMs") < 8_000) {
    return { worked: false, complete: false, samples: 0 };
  }
  const slice = await env.DB.prepare(
    `SELECT s.* FROM backfill_slices s JOIN backfill_jobs j ON j.id=s.backfill_job_id
     WHERE s.status='pending' AND j.status IN ('pending','running')
       AND (?1 IS NULL OR j.id=?1)
       AND (?2 IS NULL OR j.kind=?2)
       AND (s.next_eligible_at IS NULL OR s.next_eligible_at<=?3)
     ORDER BY s.ends_at DESC,s.collector_key LIMIT 1`,
  ).bind(options.jobId ?? null, options.kind ?? null, Date.now()).first<SliceRow>();
  budget.charge("d1RowsRead", slice ? 1 : 0);
  if (!slice) return { worked: false, complete: true, samples: 0 };
  const collector = toUsageCollector(slice.collector_key);
  const product = collector ? productUsageDefinition(collector) : undefined;
  const requiredQueries = product?.datasets.length
    ?? (collector === "graphql:durable-objects" || collector === "graphql:workers" ? 16 : 1);
  if (collector === "billing" ? budget.remaining("restRequests") < 1 : budget.remaining("graphqlQueries") < requiredQueries) {
    return { worked: false, complete: false, samples: 0 };
  }
  budget.charge("backfillSlices");
  const claimed = await env.DB.prepare(
    `UPDATE backfill_slices SET status='running',updated_at=?2 WHERE id=?1 AND status='pending'`,
  ).bind(slice.id, Date.now()).run();
  budget.charge("d1RowsWritten", Number(claimed.meta.rows_written ?? claimed.meta.changes ?? 0));
  if (Number(claimed.meta.changes ?? 0) !== 1) return { worked: false, complete: false, samples: 0 };
  try {
    if (!collector) {
      await finishSlice(env.DB, budget, slice, "complete", null, "Collector has no historical implementation", "missing");
      await updateJobStatus(env.DB, budget, slice.backfill_job_id);
      return { worked: true, complete: true, samples: 0 };
    }
    const result = await ingestWindow({
      env, client, ledger, collector, startsAt: slice.starts_at, endsAt: slice.ends_at,
      cursor: collector === "graphql:durable-objects"
        ? parseCursor(slice.cursor_json)
        : collector === "graphql:workers" ? parseWorkerCursor(slice.cursor_json) : undefined,
      budget, timeZone, historical: true, maxPages: 2,
    });
    const unavailable = result.coverage.find(item =>
      (item.state === "permission_denied" || item.state === "unavailable")
      && !(collector === "graphql:workers" && item.metric === "cache_requests")
      && !item.detail?.startsWith("This metric is retained through authoritative billing")
    );
    if (unavailable) throw new Error(unavailable.detail ?? `${collector} telemetry is ${unavailable.state}`);
    const terminal = collector === "billing" || result.complete;
    const coverage = collector === "billing"
      ? result.coverage.some(item => item.metric === "initial_import_gaps" && item.state !== "healthy") ? "partial" : "complete"
      : result.complete && !result.coverage.some(item => item.state === "delayed") ? "complete" : "partial";
    await finishSlice(
      env.DB, budget, slice, terminal ? "complete" : "pending", result.continuation,
      terminal ? null : "Continuation saved after the bounded page budget",
      coverage,
    );
    await updateJobStatus(env.DB, budget, slice.backfill_job_id);
    return { worked: true, complete: result.complete, samples: result.observations };
  } catch (error) {
    const previousRetryCount = Math.min(3, Number(slice.retry_count ?? 0));
    const failed = previousRetryCount >= 3;
    // Keep retry_count as the number of retries scheduled. A terminal attempt
    // does not advance it beyond the configured maximum.
    const retryCount = failed ? 3 : previousRetryCount + 1;
    await finishSlice(
      env.DB, budget, slice, failed ? "failed" : "pending", parseCursor(slice.cursor_json),
      error instanceof Error ? error.message : String(error), "missing", !failed, retryCount,
    );
    await updateJobStatus(env.DB, budget, slice.backfill_job_id);
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
  retryCount?: number,
): Promise<void> {
  const nextEligibleAt = retry && (retryCount ?? 0) <= 3
    ? Date.now() + [30_000, 120_000, 480_000][Math.max(0, (retryCount ?? 1) - 1)]!
    : null;
  const result = await db.prepare(
    `UPDATE backfill_slices SET
       status=?2,cursor_json=?3,error=?4,coverage_status=?5,
       retry_count=COALESCE(?6,retry_count),next_eligible_at=?7,updated_at=?8 WHERE id=?1`,
  ).bind(
    slice.id, status, cursor ? JSON.stringify(cursor) : null, error?.slice(0, 2000) ?? null,
    coverage, retryCount ?? null, nextEligibleAt, Date.now(),
  ).run();
  budget.charge("d1RowsWritten", Number(result.meta.rows_written ?? result.meta.changes ?? 0));
}

async function updateJobStatus(db: D1Database, budget: LedgerRunBudget, jobId: string): Promise<void> {
  const result = await db.prepare(
    `UPDATE backfill_jobs SET
       status=CASE WHEN EXISTS(
         SELECT 1 FROM backfill_slices WHERE backfill_job_id=?1 AND status IN ('pending','running')
       ) THEN 'running' ELSE 'complete' END,
       updated_at=?2 WHERE id=?1`,
  ).bind(jobId, Date.now()).run();
  budget.charge("d1RowsWritten", Number(result.meta.rows_written ?? result.meta.changes ?? 0));
}

function toUsageCollector(value: string): UsageCollector | null {
  if (value === "billing" || value.includes("billing")) return "billing";
  if (value.includes("durable")) return "graphql:durable-objects";
  if (value === "graphql:workers" || value === "graphql:workersInvocationsAdaptive") return "graphql:workers";
  if (productUsageDefinition(value)) return value as UsageCollector;
  return null;
}

function parseCursor(value: string | null): DurableObjectUsageCursor | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as DurableObjectUsageCursor; } catch { return undefined; }
}

function parseWorkerCursor(value: string | null): import("./cloudflare.js").WorkerUsageCursor | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as import("./cloudflare.js").WorkerUsageCursor; } catch { return undefined; }
}
