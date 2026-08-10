export interface SqlUsage { rowsRead: number; rowsWritten: number }
export interface SqlLimits { rowsRead: number; rowsWritten: number }

export const BROLLY_FUSE_BINDING = "BROLLY_FUSE";
export const BROLLY_FUSE_VERSION = 1;

export interface BrollyQuarantine {
  actionId: string;
  incidentId?: string;
  reason: string;
  appliedAt: number;
  expiresAt?: number;
}

export interface BrollyFuseManifest {
  version: 1;
  generation: number;
  worker?: BrollyQuarantine;
  objects?: Record<string, BrollyQuarantine>;
}

export interface BrollyRuntimeEnv {
  BROLLY_FUSE?: string;
}

export interface DurableObjectContextLike {
  readonly id: { toString(): string };
}

export interface BrollyWorkerTarget {
  durableObjectId?: string;
}

export class BrollyQuarantinedError extends Error {
  readonly code = "BROLLY_QUARANTINED";
  readonly retryable = false;

  constructor(
    readonly target: "worker" | "durable_object",
    readonly quarantine: BrollyQuarantine,
  ) {
    super(quarantine.reason || `${target === "worker" ? "Worker" : "Durable Object"} quarantined by Brolly`);
    this.name = "BrollyQuarantinedError";
  }
}

/**
 * Synchronous, zero-I/O Worker ingress fuse. Call this before routing, storage,
 * or a Durable Object stub invocation. It throws only for an explicit,
 * unexpired quarantine in a valid BROLLY_FUSE manifest.
 */
export function brollyWorker(
  env: BrollyRuntimeEnv,
  target: BrollyWorkerTarget = {},
  now = Date.now(),
): void {
  const manifest = readBrollyFuse(env);
  if (!manifest) return;
  if (active(manifest.worker, now)) throw new BrollyQuarantinedError("worker", manifest.worker);
  if (!target.durableObjectId) return;
  const object = manifest.objects?.[target.durableObjectId];
  if (active(object, now)) throw new BrollyQuarantinedError("durable_object", object);
}

/**
 * Final exact-object backstop. Put this immediately after super(ctx, env) in a
 * Durable Object constructor. It performs no fetch, binding call, or storage
 * operation and throws before any application handler runs when quarantined.
 */
export function brollyDurableObject(
  ctx: DurableObjectContextLike,
  env: BrollyRuntimeEnv,
  now = Date.now(),
): void {
  brollyWorker(env, { durableObjectId: ctx.id.toString() }, now);
}

/** Parse a fuse defensively. Invalid or absent configuration is not an explicit shutdown. */
export function readBrollyFuse(env: BrollyRuntimeEnv): BrollyFuseManifest | null {
  if (typeof env.BROLLY_FUSE !== "string" || env.BROLLY_FUSE.length === 0) return null;
  try {
    const value = JSON.parse(env.BROLLY_FUSE) as Partial<BrollyFuseManifest>;
    if (value.version !== BROLLY_FUSE_VERSION || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0) return null;
    if (value.worker !== undefined && !validQuarantine(value.worker)) return null;
    if (value.objects !== undefined) {
      if (!value.objects || typeof value.objects !== "object" || Array.isArray(value.objects)) return null;
      for (const [id, quarantine] of Object.entries(value.objects)) {
        if (!/^[a-f0-9]{64}$/i.test(id) || !validQuarantine(quarantine)) return null;
      }
    }
    return value as BrollyFuseManifest;
  } catch {
    return null;
  }
}

function validQuarantine(value: unknown): value is BrollyQuarantine {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<BrollyQuarantine>;
  return typeof item.actionId === "string" && item.actionId.length > 0
    && typeof item.reason === "string"
    && Number.isFinite(item.appliedAt)
    && (item.expiresAt === undefined || Number.isFinite(item.expiresAt));
}

function active(value: BrollyQuarantine | undefined, now: number): value is BrollyQuarantine {
  return value !== undefined && (value.expiresAt === undefined || value.expiresAt > now);
}

export class DurableObjectBudgetExceededError extends Error {
  constructor(readonly usage: SqlUsage, readonly limits: SqlLimits) {
    super(`Durable Object SQL budget exceeded: ${usage.rowsRead}/${limits.rowsRead} rows read, ${usage.rowsWritten}/${limits.rowsWritten} rows written`);
    this.name = "DurableObjectBudgetExceededError";
  }
}

export class SqlBudget {
  readonly usage: SqlUsage = { rowsRead: 0, rowsWritten: 0 };
  constructor(readonly limits: SqlLimits = { rowsRead: 1_000_000, rowsWritten: 10_000 }) {}

  record(cursor: { rowsRead?: number; rowsWritten?: number }): void {
    this.usage.rowsRead += cursor.rowsRead ?? 0;
    this.usage.rowsWritten += cursor.rowsWritten ?? 0;
    if (this.usage.rowsRead > this.limits.rowsRead || this.usage.rowsWritten > this.limits.rowsWritten) {
      throw new DurableObjectBudgetExceededError({ ...this.usage }, this.limits);
    }
  }
}

export interface RuntimeControlPayload {
  version: 1;
  accountId: string;
  projectId: string;
  objectId: string;
  actionId: string;
  action: "quarantine" | "resume" | "status";
  reason: string;
  forensicHold?: boolean;
  releaseForensicHold?: boolean;
  observed?: Record<string, number>;
  issuedAt: number;
  expiresAt: number;
}

export interface RuntimeSafetyStatus {
  state: "active" | "quarantined";
  reason: string | null;
  source: string | null;
  trippedAt: number | null;
  resumedAt: number | null;
  forensicHold: boolean;
  lastActionId: string | null;
  observed: Record<string, number>;
}
