import type { AssetTier, ControlAction, CoverageState, MetricSample } from "./types.js";

export type ResourceScope = "account" | "product" | "zone" | "namespace" | "resource" | "object";
export type AutoQuarantinePolicy = "inherit" | "allow" | "deny";
export type ControlCapability = "none" | "runtime_fuse" | "queue_pause";
export type RuntimeFuseStatus = "unknown" | "missing" | "declared" | "verified" | "unhealthy";
export type DataQualityState = "complete" | "partial" | "sampled" | "stale" | "missing";
export type UsagePeriod = "day" | "billing_cycle";
export type UsageMeasurement = "usage" | "estimated_cost" | "billed_cost";
export type AggregationKind = "sum" | "maximum" | "latest";

export interface MetricDefinition {
  id: string;
  productFamily: string;
  metricKey: string;
  displayName: string;
  unit: MetricSample["unit"];
  aggregationKind: AggregationKind;
  billingMapping: string | null;
  collectorKey: string;
  finestScope: ResourceScope;
  pricingVersionId?: string;
  active: boolean;
}

export interface Resource {
  id: string;
  accountId: string;
  parentResourceId: string | null;
  productFamily: string;
  resourceType: string;
  cloudflareId: string;
  displayName: string;
  firstSeenAt: number;
  lastSeenAt: number;
  lastActiveAt: number | null;
  coverageStatus: DataQualityState;
  controlCapability: ControlCapability;
  runtimeFuseStatus: RuntimeFuseStatus;
  autoQuarantinePolicy: AutoQuarantinePolicy;
  tier: AssetTier;
  excluded: boolean;
  metadata: Record<string, string>;
}

export interface UsagePoint {
  periodStart: number;
  periodEnd: number;
  value: number;
  estimatedCostUsd: number | null;
  authoritativeCostUsd: number | null;
  quality: DataQualityState;
  sampleInterval: number | null;
  revisedAt: number;
}

export interface UsageSeries {
  resource: Resource;
  metric: MetricDefinition;
  period: UsagePeriod;
  points: UsagePoint[];
  oldestRetainedAt: number | null;
  freshnessAt: number | null;
  coverage: CollectorCoverage | null;
}

export interface AlertRule {
  id: string;
  accountId: string;
  targetResourceId: string | null;
  targetSelector: Record<string, string> | null;
  metricDefinitionId: string;
  measurement: UsageMeasurement;
  period: UsagePeriod;
  notificationTargetIds: string[];
  autoQuarantine: boolean;
  autoQuarantineContributors: boolean;
  confirmationWindowMs: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AlertLine {
  id: string;
  alertRuleId: string;
  levelId: string;
  label: string;
  color: string;
  priority: number;
  thresholdValue: number;
  action: "notify" | "quarantine" | null;
  repeatIntervalMs: number | null;
  enabled: boolean;
}

export interface AlertInstance {
  id: string;
  alertRuleId: string;
  alertLineId: string;
  targetResourceId: string;
  periodStart: number;
  periodEnd: number;
  observedValue: number;
  thresholdValue: number;
  quality: DataQualityState;
  status: "open" | "acknowledged" | "expired" | "resolved";
  firstBreachedAt: number;
  lastBreachedAt: number;
  nextNotificationAt: number | null;
  notificationCount: number;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
  linkedAction: ControlAction | null;
}

export interface CollectorCoverage {
  accountId: string;
  collectorKey: string;
  dataset: string;
  available: boolean;
  retentionDays: number | null;
  samplingBehavior: string | null;
  finestScope: ResourceScope;
  lastVerifiedAt: number;
  errorCode: string | null;
  humanExplanation: string;
  state: CoverageState;
  watermarkAt: number | null;
}

export interface MonitoringCost {
  day: string;
  graphqlQueries: number;
  graphqlQueryBudget: number;
  restRequests: number;
  restRequestBudget: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  workerRequests: number;
  workerCpuMs: number;
  estimatedCostUsd: number;
  deferredCollectors: string[];
  storageBytes: number | null;
  storageCapacityBytes: number | null;
  oldestResourceDay: string | null;
}

export interface UsageObservation {
  collectorKey: string;
  dataset: string;
  sample: MetricSample;
  quality: DataQualityState;
  sampleInterval: number | null;
  watermarkAt: number | null;
  historical: boolean;
}

export interface ContributorEvidence {
  resourceId: string;
  latestIntervalValue: number;
  periodValue: number;
  aggregateExcess: number;
  rollingBaseline: number;
  crossedOwnEmergency: boolean;
  eligible: boolean;
}
