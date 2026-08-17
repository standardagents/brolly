export type Severity = "info" | "warning" | "critical" | "emergency";
export type IncidentStatus = "open" | "acknowledged";
export type AssetTier = "control_plane" | "critical" | "standard" | "disposable" | "unclassified";

export interface SpendLimits { warning: number; critical: number; emergency: number }
export interface Threshold {
  metric: string; windowMs: number; warning?: number; critical?: number; emergency?: number;
  minimumBaselineSamples?: number; anomalyMultiplier?: number;
}
export interface Policy {
  version: string;
  mode: "observe" | "approval" | "automatic";
  accountDailySpend: SpendLimits;
  familyDailySpend: Record<string, SpendLimits>;
  assetDailySpend: Record<string, SpendLimits>;
  thresholds: Threshold[];
}

export interface OnboardingData {
  accountId: string;
  complete: boolean;
  policy: Policy;
  families: Array<{ family: string; label: string; metrics: string[]; protection: "active" | "coverage_gap" }>;
  scopedAssets: Array<{ key: string; family: "workers" | "durable_objects"; id: string; name: string; scope: "resource" | "namespace"; protection: "active" | "coverage_gap"; tags: Record<string, string> }>;
}

export interface SuggestedBudget {
  observedUsd: number;
  limits: SpendLimits;
  source: "analytics" | "billing";
  partial: boolean;
}

export interface OnboardingBudgetEstimates {
  generatedAt: number;
  windowStartAt: number;
  windowEndAt: number;
  cached: boolean;
  apiCalls: number;
  headroom: { warning: number; critical: number; emergency: number };
  account: SuggestedBudget | null;
  families: Record<string, SuggestedBudget>;
  assets: Record<string, SuggestedBudget>;
  unchangedFamilies: string[];
  access: Record<"workers" | "durable_objects" | "billing", {
    state: "connected" | "limited" | "blocked" | "not_configured" | "unknown";
    detail: string;
  }>;
}

export interface InitialIngestionJob {
  id: string;
  status: string;
  startedAt: number;
  updatedAt: number;
}

export interface InitialIngestionCollector {
  collector: string;
  label: string;
  total: number;
  complete: number;
  failed: number;
  oldestCompleteAt: string | number | null;
}

export interface InitialIngestionResponse {
  job: InitialIngestionJob | null;
  collectors: InitialIngestionCollector[];
}

export interface BillingAccessStatus {
  configured: boolean;
  source: "worker_secret" | "encrypted_database" | "none";
  updatedAt: number | null;
}

export interface Incident {
  id: string; key: string; status: IncidentStatus; severity: Severity; family: string; familyLabel: string;
  assetId: string; assetName: string | null; parentId: string | null; scope: string; tier: AssetTier;
  tags: Record<string, string>; metric: string; metricLabel: string; unit: string; windowMs: number | null;
  observed: number; threshold: number | null; expected: number | null; reason: string; proposedAction: string;
  firstSeen: number; lastSeen: number; occurrences: number; cloudflareUrl: string;
  action: null | { id: string; state: string; kind: string };
}

export interface CoverageItem {
  family: string; metric: string; scope: string; state: "healthy" | "delayed" | "unavailable" | "permission_denied";
  detail: string | null; checkedAt: number;
}

export interface SpendCategory { family: string; label: string; estimatedUsd: number; updatedAt: number; coverage: string }
export interface SpendPoint { at: number; totalUsd: number; categories: Record<string, number> }

export interface ControlActionRow {
  id: string; incidentId: string; family: string; assetId: string; kind: string; state: string;
  reason: string; error: string | null; createdAt: number; updatedAt: number;
}

export interface DashboardData {
  generatedAt: number;
  account: { id: string; timezone: string };
  policy: { mode: Policy["mode"]; version: string; accountDailySpend: SpendLimits; familyDailySpend: Record<string, SpendLimits>; assetDailySpend: Record<string, SpendLimits> };
  summary: {
    openIncidents: number; acknowledgedIncidents: number; emergencyIncidents: number; criticalIncidents: number;
    coverageGaps: number; assets: number; lastCheckAt: number | null;
  };
  spend: {
    label: string; estimatedTotalUsd: number; categories: SpendCategory[]; history: SpendPoint[];
    updatedAt: number | null; authoritative: boolean; stale: boolean; note: string;
  };
  incidents: Incident[];
  coverage: { gaps: CoverageItem[]; all: CoverageItem[] };
  assets: {
    families: Array<{ family: string; label: string; assets: number; lastSeen: number; cloudflareUrl: string; expectedMetrics: number; healthyMetrics: number; gaps: number }>;
    tiers: Record<string, number>;
  };
  actions: ControlActionRow[];
}

export interface Asset {
  accountId: string; family: string; id: string; parentId: string | null; name: string | null; scope: string;
  tier: AssetTier; tags: Record<string, string>; discoveredAt: number; seenAt: number; incidentCount: number; lastSignalAt: number | null;
}

export type ConfigurationStatus = "configured" | "partial" | "not_configured" | "error";
export interface ConfigurationCheck {
  state: "pass" | "fail" | "unknown" | "error";
  label: string;
  detail: string;
}
export interface ConfigurationWorker {
  id: string; name: string; tier: AssetTier; tags: Record<string, string>; seenAt: number;
  declaredInstalled: boolean; namespaceCount: number; checkedAt: number | null;
  deploymentId: string | null; versionId: string | null; status: ConfigurationStatus;
  checks: {
    inventory: ConfigurationCheck; declared: ConfigurationCheck; apiAccess: ConfigurationCheck;
    fuseSecret: ConfigurationCheck; runtimeBundle: ConfigurationCheck; activeDeployment: ConfigurationCheck;
  };
}
export interface ConfigurationNamespace {
  id: string; name: string; tier: AssetTier; tags: Record<string, string>; seenAt: number;
  className: string | null; storage: string | null; ownerWorker: string | null;
  declaredOwner: string | null; discoveredOwner: string | null; status: ConfigurationStatus;
  checks: { inventory: ConfigurationCheck; owner: ConfigurationCheck; constructor: ConfigurationCheck; worker: ConfigurationCheck };
}
export interface ConfigurationData {
  generatedAt: number;
  connected: boolean;
  summary: {
    workers: number; configuredWorkers: number; namespaces: number; configuredNamespaces: number;
    partial: number; needsAttention: number; lastVerifiedAt: number | null;
  };
  workers: ConfigurationWorker[];
  namespaces: ConfigurationNamespace[];
}

export type NotificationKind = "discord" | "slack" | "webhook" | "resend" | "postmark" | "twilio";
export interface NotificationTarget {
  id: string;
  kind: NotificationKind;
  enabled: boolean;
  minimumSeverity: Severity;
  createdAt: number;
  updatedAt: number;
  lastDeliveryAt: number | null;
  lastDeliveryOk: boolean | null;
  lastDeliveryError: string | null;
}

export interface ReleaseStatus {
  currentRelease: string;
  latestRelease: string | null;
  displayVersion: string | null;
  publishedAt: string | null;
  notesUrl: string | null;
  available: boolean;
  checkedAt: number | null;
  stale: boolean;
  checking: boolean;
  repository: string | null;
  updateUrl: string | null;
  error?: string;
}

export type DataQuality = "complete" | "partial" | "sampled" | "stale" | "missing";

export interface LedgerResource {
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
  coverageStatus: DataQuality;
  controlCapability: "none" | "runtime_fuse" | "queue_pause";
  runtimeFuseStatus: "unknown" | "missing" | "declared" | "verified" | "unhealthy";
  autoQuarantinePolicy: "inherit" | "allow" | "deny";
  tier: AssetTier;
  excluded: boolean;
  metadata: Record<string, unknown>;
  childCount: number;
  usageUpdatedAt: number | null;
  oldestDay: string | null;
  openAlerts: number;
}

export interface LedgerMetricDefinition {
  id: string;
  productFamily: string;
  metricKey: string;
  displayName: string;
  unit: string;
  aggregationKind: "sum" | "maximum" | "latest";
  billingMapping: string | null;
  collectorKey: string;
  finestScope: string;
  active: boolean;
}

export interface UsagePoint {
  localDay: string;
  periodStartAt?: number;
  periodEndAt?: number;
  metrics: Record<string, number>;
  estimatedCostUsd: number | null;
  authoritativeCostUsd: number | null;
  quality: DataQuality;
  sampling: Record<string, unknown>;
  sealed: boolean;
  revision: number;
  revisedAt: number;
}

export interface UsageResponse {
  resource: LedgerResource;
  metricDefinitions: LedgerMetricDefinition[];
  metricId: string | null;
  period: "day";
  points: UsagePoint[];
  oldestRetainedAt: string | null;
  freshnessAt: number | null;
}

export interface AlertLineView {
  id: string;
  alertRuleId: string;
  label: string;
  color: string;
  priority: number;
  thresholdValue: number;
  action: "notify" | "quarantine" | null;
  repeatIntervalMs: number | null;
  enabled: boolean;
}

export interface AlertRuleView {
  id: string;
  accountId: string;
  targetResourceId: string | null;
  targetDisplayName: string | null;
  targetResourceType: string | null;
  targetSelector: Record<string, string> | null;
  metricDefinitionId: string;
  measurement: "usage" | "estimated_cost" | "billed_cost";
  period: "day" | "billing_cycle";
  notificationTargetIds: string[];
  autoQuarantine: boolean;
  autoQuarantineContributors: boolean;
  confirmationWindowMs: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lines: AlertLineView[];
}

export interface AlertInstanceView {
  id: string;
  alertRuleId: string;
  alertLineId: string;
  targetResourceId: string;
  periodStartAt: number;
  periodEndAt: number;
  observedValue: number;
  thresholdValue: number;
  evidence: Record<string, unknown>;
  dataQuality: DataQuality;
  status: "open" | "silenced" | "expired" | "resolved";
  firstBreachedAt: number;
  lastBreachedAt: number;
  nextNotificationAt: number | null;
  notificationCount: number;
  silencedAt: number | null;
  silencedBy: string | null;
  linkedActionId: string | null;
  historical: number;
  metricDefinitionId: string;
  label: string;
  color: string;
  priority: number;
  displayName: string;
  productFamily: string;
  cloudflareId: string;
}

export interface CollectorCapabilityView {
  accountId: string;
  collectorKey: string;
  dataset: string;
  available: boolean;
  retentionDays: number | null;
  samplingBehavior: string | null;
  finestScope: string;
  lastVerifiedAt: number;
  errorCode: string | null;
  humanExplanation: string;
  state: string;
  watermarkAt: number | null;
}

export interface CollectorStateView {
  accountId: string;
  collectorKey: string;
  partitionKey: string;
  cursor: Record<string, unknown> | null;
  highWatermarkAt: number | null;
  retryCount: number;
  nextEligibleAt: number;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastError: string | null;
  status: string;
}

export interface MonitoringDailyView {
  accountId: string;
  localDay: string;
  graphqlQueries: number;
  graphqlQueryBudget: number;
  restRequests: number;
  restRequestBudget: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  workerRequests: number;
  workerCpuMs: number;
  estimatedCostUsd: number;
  storageBytes: number | null;
  storageCapacityBytes: number | null;
  deferredCollectors: string[];
  oldestResourceDay: string | null;
  updatedAt: number;
}

export interface MonitorRunView {
  id: string;
  kind: string;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  graphqlQueries: number;
  restRequests: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  rowsReturned: number;
  samplesNormalized: number;
  coverageStatus: string;
  status: string;
  errors: string[];
  deferredCollectors: string[];
}

export interface LedgerRunLimitsView {
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

export interface RetentionView {
  generatedAt: number;
  oldestResourceDay: string | null;
  oldestAggregateDay: string | null;
  dailyRows: number;
  projectedBytes: number;
  capacityBytes: number;
  pressure: number | null;
  backfillPending: number;
  targetRetentionDays: number;
}

export interface BackfillJobView {
  id: string;
  requestedStartAt: number;
  requestedEndAt: number;
  status: string;
  pausedReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BackfillSliceView {
  id: string;
  backfillJobId: string;
  collectorKey: string;
  startsAt: number;
  endsAt: number;
  status: string;
  retryCount: number;
  coverageStatus: DataQuality;
  error: string | null;
  updatedAt: number;
}
