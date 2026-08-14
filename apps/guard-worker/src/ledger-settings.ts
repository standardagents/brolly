import {
  DEFAULT_LEDGER_RUN_LIMITS,
  MAX_LEDGER_RUN_LIMITS,
  LedgerRunBudget,
  type LedgerRunLimits,
} from "@standardagents/brolly-core";

const SETTING_KEY = "ledger_run_limits";

export async function configuredLedgerRunLimits(db: D1Database): Promise<LedgerRunLimits> {
  const row = await db.prepare(`SELECT value FROM settings WHERE key=?1 LIMIT 1`)
    .bind(SETTING_KEY).first<{ value: string }>();
  if (!row) return { ...DEFAULT_LEDGER_RUN_LIMITS };
  try {
    return new LedgerRunBudget(JSON.parse(row.value) as Partial<LedgerRunLimits>).limits;
  } catch {
    return { ...DEFAULT_LEDGER_RUN_LIMITS };
  }
}

export function validateLedgerRunLimits(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "Monitoring limits must be an object";
  const values = input as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_LEDGER_RUN_LIMITS) as Array<keyof LedgerRunLimits>) {
    const value = values[key];
    if (!Number.isInteger(value) || Number(value) <= 0) return `${key} must be a positive integer`;
    if (Number(value) > MAX_LEDGER_RUN_LIMITS[key]) return `${key} cannot exceed ${MAX_LEDGER_RUN_LIMITS[key]}`;
  }
  const unknown = Object.keys(values).find(key => !Object.hasOwn(DEFAULT_LEDGER_RUN_LIMITS, key));
  return unknown ? `Unknown monitoring limit: ${unknown}` : null;
}

export async function saveLedgerRunLimits(db: D1Database, input: LedgerRunLimits): Promise<LedgerRunLimits> {
  const error = validateLedgerRunLimits(input);
  if (error) throw new TypeError(error);
  const limits = new LedgerRunBudget(input).limits;
  await db.prepare(
    `INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  ).bind(SETTING_KEY, JSON.stringify(limits), Date.now()).run();
  return limits;
}

export { DEFAULT_LEDGER_RUN_LIMITS, MAX_LEDGER_RUN_LIMITS };
