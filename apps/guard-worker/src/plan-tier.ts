import {
  effectivePlanTier,
  planTierSource,
  type PlanTier,
  type PlanTierSource,
} from "./included-quota.js";

export const PLAN_TIER_SETTING_KEY = "plan_tier";

export interface StoredPlanState {
  detectedTier: PlanTier;
  overrideTier: PlanTier | null;
  checkedAt: number | null;
  error: string | null;
}

export interface PlanState extends StoredPlanState {
  planTier: PlanTier;
  planTierSource: PlanTierSource;
}

export const DEFAULT_PLAN_STATE: StoredPlanState = {
  detectedTier: "unknown",
  overrideTier: null,
  checkedAt: null,
  error: null,
};

export async function readPlanState(db: D1Database): Promise<PlanState> {
  const row = await db.prepare(`SELECT value FROM settings WHERE key=?1 LIMIT 1`).bind(PLAN_TIER_SETTING_KEY).first<{ value: string }>();
  const stored = parseStoredPlanState(row?.value);
  return materializePlanState(stored);
}

export async function saveDetectedPlan(
  db: D1Database,
  detectedTier: PlanTier,
  checkedAt: number,
  error: string | null = null,
): Promise<PlanState> {
  const current = await readStoredPlanState(db);
  const next: StoredPlanState = { ...current, detectedTier, checkedAt, error: error?.slice(0, 2_000) ?? null };
  await writePlanState(db, next, checkedAt);
  return materializePlanState(next);
}

export async function savePlanOverride(
  db: D1Database,
  overrideTier: PlanTier | null,
  updatedAt = Date.now(),
): Promise<PlanState> {
  const current = await readStoredPlanState(db);
  const next: StoredPlanState = { ...current, overrideTier };
  await writePlanState(db, next, updatedAt);
  return materializePlanState(next);
}

export function materializePlanState(stored: StoredPlanState): PlanState {
  return {
    ...stored,
    planTier: effectivePlanTier(stored.detectedTier, stored.overrideTier),
    planTierSource: planTierSource(stored.overrideTier),
  };
}

export function planStateResponse(state: PlanState): Record<string, unknown> {
  return {
    planTier: state.planTier,
    planTierSource: state.planTierSource,
    detectedPlanTier: state.detectedTier,
    planTierOverride: state.overrideTier,
    planTierCheckedAt: state.checkedAt,
    planTierError: state.error,
  };
}

export function isPlanTier(value: unknown): value is PlanTier {
  return validTier(value);
}

async function readStoredPlanState(db: D1Database): Promise<StoredPlanState> {
  const row = await db.prepare(`SELECT value FROM settings WHERE key=?1 LIMIT 1`).bind(PLAN_TIER_SETTING_KEY).first<{ value: string }>();
  return parseStoredPlanState(row?.value);
}

async function writePlanState(db: D1Database, state: StoredPlanState, updatedAt: number): Promise<void> {
  await db.prepare(
    `INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  ).bind(PLAN_TIER_SETTING_KEY, JSON.stringify(state), updatedAt).run();
}

function parseStoredPlanState(value: string | undefined): StoredPlanState {
  if (!value) return { ...DEFAULT_PLAN_STATE };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const detectedTier = validTier(parsed.detectedTier) ? parsed.detectedTier : "unknown";
    const overrideTier = parsed.overrideTier === null || parsed.overrideTier === undefined
      ? null
      : validTier(parsed.overrideTier) ? parsed.overrideTier : null;
    const checkedAt = typeof parsed.checkedAt === "number" && Number.isFinite(parsed.checkedAt) ? parsed.checkedAt : null;
    const error = typeof parsed.error === "string" && parsed.error ? parsed.error : null;
    return { detectedTier, overrideTier, checkedAt, error };
  } catch {
    return { ...DEFAULT_PLAN_STATE };
  }
}

function validTier(value: unknown): value is PlanTier {
  return value === "free" || value === "paid" || value === "enterprise" || value === "unknown";
}
