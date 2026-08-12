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

export type NotificationKind = "discord" | "slack" | "twilio";
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
