export interface LedgerRunLimits {
  graphqlQueries: number;
  restRequests: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  pagesPerDataset: number;
  resourcesPerTransaction: number;
  retries: number;
  backfillSlices: number;
  wallMs: number;
}

export type LedgerBudgetKind = keyof LedgerRunLimits;

export const DEFAULT_LEDGER_RUN_LIMITS: LedgerRunLimits = {
  graphqlQueries: 300,
  restRequests: 50,
  d1RowsRead: 100_000,
  d1RowsWritten: 50_000,
  pagesPerDataset: 30,
  resourcesPerTransaction: 500,
  retries: 3,
  backfillSlices: 4,
  wallMs: 45_000,
};

export const MAX_LEDGER_RUN_LIMITS: LedgerRunLimits = {
  graphqlQueries: 500,
  restRequests: 100,
  d1RowsRead: 250_000,
  d1RowsWritten: 100_000,
  pagesPerDataset: 50,
  resourcesPerTransaction: 1_000,
  retries: 5,
  backfillSlices: 12,
  wallMs: 55_000,
};

/**
 * Per-request budget for the one-shot onboarding import.  The import has a
 * smaller Cloudflare request allowance than the recurring monitor so a fresh
 * install cannot crowd out normal monitoring work.
 */
export const INITIAL_INGESTION_LIMITS: LedgerRunLimits = {
  ...MAX_LEDGER_RUN_LIMITS,
  graphqlQueries: 40,
  restRequests: 5,
  wallMs: 25_000,
};

export class LedgerBudgetExceededError extends Error {
  constructor(readonly kind: LedgerBudgetKind, readonly used: number, readonly limit: number) {
    super(`Ledger ${kind} budget exceeded (${used}/${limit})`);
    this.name = "LedgerBudgetExceededError";
  }
}

export class LedgerRunBudget {
  readonly usage: LedgerRunLimits = {
    graphqlQueries: 0, restRequests: 0, d1RowsRead: 0, d1RowsWritten: 0, pagesPerDataset: 0,
    resourcesPerTransaction: 0, retries: 0, backfillSlices: 0, wallMs: 0,
  };
  readonly limits: LedgerRunLimits;
  readonly signal: AbortSignal;
  private readonly startedAt = Date.now();
  private readonly controller = new AbortController();

  constructor(requested: Partial<LedgerRunLimits> = {}) {
    this.limits = boundedLimits(requested);
    this.signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.limits.wallMs)]);
  }

  charge(kind: Exclude<LedgerBudgetKind, "wallMs">, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) throw new TypeError(`Invalid ${kind} charge`);
    this.checkpoint();
    this.usage[kind] += amount;
    if (this.usage[kind] > this.limits[kind]) this.trip(kind);
  }

  observePeak(kind: "resourcesPerTransaction", amount: number): void {
    if (!Number.isFinite(amount) || amount < 0) throw new TypeError(`Invalid ${kind} observation`);
    this.checkpoint();
    this.usage[kind] = Math.max(this.usage[kind], amount);
    if (this.usage[kind] > this.limits[kind]) this.trip(kind);
  }

  remaining(kind: LedgerBudgetKind): number {
    if (kind === "wallMs") return Math.max(0, this.limits.wallMs - (Date.now() - this.startedAt));
    return Math.max(0, this.limits[kind] - this.usage[kind]);
  }

  checkpoint(): void {
    this.usage.wallMs = Date.now() - this.startedAt;
    if (this.usage.wallMs > this.limits.wallMs || this.signal.aborted) this.trip("wallMs");
  }

  private trip(kind: LedgerBudgetKind): never {
    this.controller.abort(`${kind} budget exceeded`);
    throw new LedgerBudgetExceededError(kind, this.usage[kind], this.limits[kind]);
  }
}

function boundedLimits(requested: Partial<LedgerRunLimits>): LedgerRunLimits {
  return Object.fromEntries(Object.entries(DEFAULT_LEDGER_RUN_LIMITS).map(([key, fallback]) => {
    const kind = key as LedgerBudgetKind;
    const value = requested[kind] ?? fallback;
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`Invalid ${kind} limit`);
    return [kind, Math.min(value, MAX_LEDGER_RUN_LIMITS[kind])];
  })) as unknown as LedgerRunLimits;
}
