export interface SqlUsage { rowsRead: number; rowsWritten: number }
export interface SqlLimits { rowsRead: number; rowsWritten: number }

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
