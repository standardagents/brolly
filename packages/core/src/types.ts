export type Severity = "info" | "warning" | "critical" | "emergency";
export type CoverageState = "healthy" | "delayed" | "unavailable" | "permission_denied";
export type AssetTier = "control_plane" | "critical" | "standard" | "disposable" | "unclassified";

export interface AssetRef {
  accountId: string;
  family: string;
  id: string;
  parentId?: string;
  name?: string;
  scope: "account" | "zone" | "resource" | "namespace" | "object";
  tier: AssetTier;
  tags?: Record<string, string>;
}

export interface MetricSample {
  asset: AssetRef;
  metric: string;
  unit: "count" | "bytes" | "milliseconds" | "gb_seconds" | "usd" | "requests" | "rows";
  value: number;
  start: number;
  end: number;
  source: "graphql" | "rest" | "billing" | "runtime";
  sampled?: boolean;
  estimatedCostUsd?: number;
}

export interface CoverageResult {
  family: string;
  metric: string;
  finestScope: AssetRef["scope"];
  state: CoverageState;
  checkedAt: number;
  detail?: string;
}

export interface Threshold {
  metric: string;
  windowMs: number;
  warning?: number;
  critical?: number;
  emergency?: number;
  minimumBaselineSamples?: number;
  anomalyMultiplier?: number;
}

export type SpendLimits = Record<string, number>;

export type RiskTolerancePreset = "conservative" | "balanced" | "growth" | "custom";

export interface RiskTolerance {
  preset: RiskTolerancePreset;
  /** Alert-level ID to percent of typical usage. A value of 150 means 1.5x. */
  percentOfTypical: Record<string, number>;
  /** Historical baseline window captured when the tolerance was configured. */
  baseline: { computedAt: number; windowDays: number };
}

export interface ScopeLimits {
  cost: SpendLimits;
  usage: Record<string, SpendLimits>;
  /** Whole scope monitored. Missing means enabled. */
  enabled?: boolean;
  costEnabled?: boolean;
  usageEnabled?: Record<string, boolean>;
  costLevelEnabled?: Record<string, boolean>;
  usageLevelEnabled?: Record<string, Record<string, boolean>>;
}

export interface PolicyLimits {
  day: Record<string, ScopeLimits>;
  cycle: Record<string, ScopeLimits>;
}

export interface Policy {
  version: string;
  accountDailySpend: SpendLimits;
  familyDailySpend?: Record<string, SpendLimits>;
  assetDailySpend?: Record<string, SpendLimits>;
  /** Missing on older installations, where the balanced preset applies. */
  riskTolerance?: RiskTolerance;
  /** Per-scope cost and billable-usage limits for daily and billing-cycle windows. */
  limits?: PolicyLimits;
  thresholds: Threshold[];
}

export interface Evaluation {
  key: string;
  asset: AssetRef;
  metric: string;
  severity: Severity;
  observed: number;
  threshold?: number;
  expected?: number;
  reason: string;
  action: "notify" | "prepare_stop" | "stop";
}

export interface Incident extends Evaluation {
  id: string;
  firstSeen: number;
  lastSeen: number;
  occurrences: number;
  status: "open" | "acknowledged" | "resolved";
}

export interface ControlAction {
  id: string;
  incidentId: string;
  asset: AssetRef;
  kind: "runtime_quarantine" | "disable_trigger" | "pause_consumer" | "disable_worker";
  state: "prepared" | "approved" | "running" | "succeeded" | "failed" | "rolled_back";
  reason: string;
  observed: Record<string, number>;
  rollback: Record<string, unknown>;
  actor: string;
  createdAt: number;
}

export interface RunLimits {
  apiCalls: number;
  databaseRows: number;
  samples: number;
  wallMs: number;
}

export interface RunUsage extends RunLimits {}

export interface MetricAdapter {
  readonly family: string;
  collect(context: BoundedRunContext, since: number, until: number): Promise<{
    samples: MetricSample[];
    coverage: CoverageResult[];
  }>;
}

export interface BoundedRunContext {
  readonly signal: AbortSignal;
  charge(kind: keyof Omit<RunLimits, "wallMs">, amount?: number): void;
  remaining(kind: keyof RunLimits): number;
  checkpoint(): void;
}
