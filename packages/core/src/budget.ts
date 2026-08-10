import type { BoundedRunContext, RunLimits, RunUsage } from "./types.js";

export class MonitoringBudgetExceededError extends Error {
  readonly kind: keyof RunLimits;

  constructor(kind: keyof RunLimits, message: string) {
    super(message);
    this.name = "MonitoringBudgetExceededError";
    this.kind = kind;
  }
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  apiCalls: 150,
  databaseRows: 25_000,
  samples: 20_000,
  wallMs: 45_000,
};

export class RunBudget implements BoundedRunContext {
  readonly signal: AbortSignal;
  readonly usage: RunUsage = { apiCalls: 0, databaseRows: 0, samples: 0, wallMs: 0 };
  private readonly startedAt = Date.now();
  private readonly controller = new AbortController();

  constructor(readonly limits: RunLimits = DEFAULT_RUN_LIMITS) {
    this.signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(limits.wallMs)]);
  }

  charge(kind: "apiCalls" | "databaseRows" | "samples", amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) throw new TypeError(`Invalid ${kind} charge`);
    this.checkpoint();
    this.usage[kind] += amount;
    if (this.usage[kind] > this.limits[kind]) this.trip(kind);
  }

  remaining(kind: keyof RunLimits): number {
    if (kind === "wallMs") return Math.max(0, this.limits.wallMs - (Date.now() - this.startedAt));
    return Math.max(0, this.limits[kind] - this.usage[kind]);
  }

  checkpoint(): void {
    this.usage.wallMs = Date.now() - this.startedAt;
    if (this.usage.wallMs > this.limits.wallMs) this.trip("wallMs");
    if (this.signal.aborted) throw new MonitoringBudgetExceededError("wallMs", "Monitoring run aborted");
  }

  private trip(kind: keyof RunLimits): never {
    this.controller.abort(`${kind} budget exceeded`);
    throw new MonitoringBudgetExceededError(
      kind,
      `Monitoring ${kind} budget exceeded (${this.usage[kind]}/${this.limits[kind]})`,
    );
  }
}
