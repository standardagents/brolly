import { capacityDecision, localDayAt, type LedgerRunBudget } from "@standardagents/brolly-core";

export interface RetentionResult {
  usedBytes: number;
  capacityBytes: number;
  pressure: number;
  backfillPaused: boolean;
  prunedRows: number;
  oldestResourceDay: string | null;
}

export async function runRetentionMaintenance(
  db: D1Database,
  accountId: string,
  budget?: LedgerRunBudget,
  now = Date.now(),
  timeZone = "UTC",
): Promise<RetentionResult> {
  const [capacitySetting, pageCountRow, pageSizeRow, rowEstimate] = await Promise.all([
    db.prepare(`SELECT value FROM settings WHERE key='d1_capacity_bytes' LIMIT 1`).first<{ value: string }>(),
    db.prepare(`PRAGMA page_count`).first<Record<string, number>>(),
    db.prepare(`PRAGMA page_size`).first<Record<string, number>>(),
    db.prepare(
      `SELECT COUNT(*) AS rows,AVG(length(u.metrics_json)+length(u.sampling_json)+192) AS average_bytes
       FROM usage_daily u JOIN resources r ON r.id=u.resource_id
       WHERE r.account_id=?1 AND r.resource_type NOT IN ('account','product')
         AND r.resource_type NOT LIKE '%:namespace'`,
    ).bind(accountId).first<{ rows: number; average_bytes: number | null }>(),
  ]);
  budget?.charge("d1RowsRead", 4 + Number(rowEstimate?.rows ?? 0));
  const pageCount = firstNumber(pageCountRow) ?? 0;
  const pageSize = firstNumber(pageSizeRow) ?? 4096;
  const usedBytes = pageCount * pageSize;
  const capacityBytes = positiveNumber(capacitySetting?.value) ?? 500_000_000;
  const decision = capacityDecision(usedBytes, capacityBytes);
  const today = localDayAt(now, timeZone);
  const retentionCutoff = localDayAt(now - 730 * 86_400_000, timeZone);
  let prunedRows = 0;

  const routine = await db.batch([
    db.prepare(
      `DELETE FROM usage_daily WHERE rowid IN (
         SELECT u.rowid FROM usage_daily u JOIN resources r ON r.id=u.resource_id
         WHERE r.account_id=?1 AND u.local_day<?2 ORDER BY u.local_day ASC LIMIT 5000
       )`,
    ).bind(accountId, retentionCutoff),
    db.prepare(
      `DELETE FROM usage_accumulator_shards WHERE rowid IN (
         SELECT rowid FROM usage_accumulator_shards
         WHERE local_day<?1 AND json_extract(payload_json,'$.sealedAt') IS NOT NULL
         ORDER BY local_day ASC LIMIT 500
       )`,
    ).bind(localDayAt(now - 3 * 86_400_000, timeZone)),
  ]);
  for (const result of routine) chargeMeta(budget, result.meta);

  if (decision.pauseBackfill) {
    const result = await db.prepare(
      `UPDATE backfill_jobs SET status='paused',paused_reason='d1_capacity',updated_at=?1
       WHERE account_id=?2 AND status IN ('pending','running')`,
    ).bind(now, accountId).run();
    chargeMeta(budget, result.meta);
  } else {
    const result = await db.prepare(
      `UPDATE backfill_jobs SET status='pending',paused_reason=NULL,updated_at=?1
       WHERE account_id=?2 AND status='paused' AND paused_reason='d1_capacity'`,
    ).bind(now, accountId).run();
    chargeMeta(budget, result.meta);
  }

  if (decision.pruneIndividualHistory) {
    const averageBytes = Math.max(256, Number(rowEstimate?.average_bytes ?? 512));
    const needed = Math.ceil((usedBytes - decision.targetBytes) / averageBytes);
    const limit = Math.min(20_000, Math.max(1, needed));
    const result = await db.prepare(
      `DELETE FROM usage_daily WHERE rowid IN (
         SELECT u.rowid FROM usage_daily u JOIN resources r ON r.id=u.resource_id
         WHERE r.account_id=?1 AND r.resource_type NOT IN ('account','product')
           AND r.resource_type NOT LIKE '%:namespace'
         ORDER BY u.local_day ASC,u.resource_id ASC LIMIT ?2
       )`,
    ).bind(accountId, limit).run();
    chargeMeta(budget, result.meta);
    prunedRows = Number(result.meta.changes ?? result.meta.rows_written ?? 0);
  }

  const oldest = await db.prepare(
     `SELECT MIN(u.local_day) AS oldest FROM usage_daily u JOIN resources r ON r.id=u.resource_id
     WHERE r.account_id=?1 AND r.resource_type NOT IN ('account','product')
       AND r.resource_type NOT LIKE '%:namespace'`,
  ).bind(accountId).first<{ oldest: string | null }>();
  budget?.charge("d1RowsRead", 1);
  const oldestResourceDay = oldest?.oldest ?? null;
  const status = await db.prepare(
    `INSERT INTO monitor_usage_daily(
       account_id,local_day,storage_bytes,storage_capacity_bytes,oldest_resource_day,updated_at
     ) VALUES(?1,?2,?3,?4,?5,?6)
     ON CONFLICT(account_id,local_day) DO UPDATE SET
       storage_bytes=excluded.storage_bytes,storage_capacity_bytes=excluded.storage_capacity_bytes,
       oldest_resource_day=excluded.oldest_resource_day,updated_at=excluded.updated_at`,
  ).bind(accountId, today, usedBytes, capacityBytes, oldestResourceDay, now).run();
  chargeMeta(budget, status.meta);

  if (decision.warn) {
    const warningKey = `capacity-warning:${today}`;
    const result = await db.prepare(
      `INSERT INTO audit_log(id,actor,action,target,detail_json,created_at)
       SELECT ?1,'brolly-retention','d1.capacity.warning',?2,?3,?4
       WHERE NOT EXISTS(
         SELECT 1 FROM audit_log WHERE action='d1.capacity.warning' AND target=?2
       )`,
    ).bind(crypto.randomUUID(), warningKey, JSON.stringify({ usedBytes, capacityBytes, pressure: decision.pressure, prunedRows }), now).run();
    chargeMeta(budget, result.meta);
  }
  return {
    usedBytes, capacityBytes, pressure: decision.pressure,
    backfillPaused: decision.pauseBackfill, prunedRows, oldestResourceDay,
  };
}

function firstNumber(row: Record<string, number> | null): number | null {
  if (!row) return null;
  const value = Object.values(row).find(item => typeof item === "number");
  return value ?? null;
}

function positiveNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function chargeMeta(budget: LedgerRunBudget | undefined, meta: { rows_read?: number; rows_written?: number; changes?: number }): void {
  budget?.charge("d1RowsRead", meta.rows_read ?? 0);
  budget?.charge("d1RowsWritten", meta.rows_written ?? meta.changes ?? 0);
}
