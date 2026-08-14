import type { ContributorEvidence, DataQualityState, Resource, UsageMeasurement } from "./ledger-types.js";

const QUALITY_RANK: Record<DataQualityState, number> = {
  complete: 0,
  sampled: 1,
  partial: 2,
  stale: 3,
  missing: 4,
};

export function resourceId(accountId: string, productFamily: string, resourceType: string, cloudflareId: string): string {
  return `${encodeURIComponent(accountId)}:${encodeURIComponent(productFamily)}:${encodeURIComponent(resourceType)}:${encodeURIComponent(cloudflareId)}`;
}

export function resourceHashBucket(id: string): number {
  return resourceHash(id) >>> 24;
}

export function resourceHashSegment(id: string, bits = 4): number {
  if (!Number.isInteger(bits) || bits < 1 || bits > 16) throw new TypeError("Shard segment bits must be between 1 and 16");
  return resourceHash(id) & ((1 << bits) - 1);
}

function resourceHash(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function worstQuality(values: DataQualityState[]): DataQualityState {
  return values.reduce<DataQualityState>((worst, value) => QUALITY_RANK[value] > QUALITY_RANK[worst] ? value : worst, "complete");
}

export function localDayAt(timestamp: number, timeZone: string): string {
  const parts = dateParts(timestamp, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function localDayBounds(localDay: string, timeZone: string): { start: number; end: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDay);
  if (!match) throw new Error(`Invalid local day: ${localDay}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    start: zonedDateTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone),
    end: zonedDateTimeToUtc({
      year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0, second: 0,
    }, timeZone),
  };
}

export interface AutomaticActionEvidence {
  resource: Pick<Resource, "controlCapability" | "runtimeFuseStatus" | "excluded" | "autoQuarantinePolicy" | "tier">;
  quality: DataQualityState;
  sampleInterval: number | null;
  measurement: UsageMeasurement;
  fresh: boolean;
  ruleOptIn: boolean;
  parentDenied: boolean;
  alreadyQuarantined: boolean;
  confirmationSatisfied: boolean;
}

export function exactAutomaticActionEligible(evidence: AutomaticActionEvidence): boolean {
  return evidence.ruleOptIn
    && evidence.quality === "complete"
    && evidence.sampleInterval === 1
    && evidence.measurement === "usage"
    && evidence.fresh
    && !evidence.resource.excluded
    && evidence.resource.tier !== "control_plane"
    && evidence.resource.tier !== "critical"
    && evidence.resource.tier !== "unclassified"
    && evidence.resource.autoQuarantinePolicy !== "deny"
    && !evidence.parentDenied
    && !evidence.alreadyQuarantined
    && evidence.resource.controlCapability !== "none"
    && evidence.resource.runtimeFuseStatus === "verified"
    && evidence.confirmationSatisfied;
}

export function selectAggregateContributor(candidates: ContributorEvidence[]): ContributorEvidence | null {
  const eligible = candidates.filter(candidate => candidate.eligible
    && candidate.latestIntervalValue >= 0
    && candidate.periodValue >= 0
    && candidate.rollingBaseline > 0
    && (candidate.latestIntervalValue >= candidate.aggregateExcess * 0.5
      || candidate.latestIntervalValue >= sumLatest(candidates) * 0.5)
    && candidate.latestIntervalValue >= candidate.rollingBaseline * 4);
  eligible.sort((left, right) => {
    if (left.crossedOwnEmergency !== right.crossedOwnEmergency) return left.crossedOwnEmergency ? -1 : 1;
    if (left.latestIntervalValue !== right.latestIntervalValue) return right.latestIntervalValue - left.latestIntervalValue;
    if (left.periodValue !== right.periodValue) return right.periodValue - left.periodValue;
    return left.resourceId.localeCompare(right.resourceId);
  });
  return eligible[0] ?? null;
}

export interface CapacityDecision {
  pressure: number;
  warn: boolean;
  pauseBackfill: boolean;
  pruneIndividualHistory: boolean;
  targetBytes: number;
}

export function capacityDecision(usedBytes: number, capacityBytes: number): CapacityDecision {
  if (!Number.isFinite(usedBytes) || usedBytes < 0 || !Number.isFinite(capacityBytes) || capacityBytes <= 0) {
    throw new TypeError("Capacity inputs must be finite and nonnegative");
  }
  const pressure = usedBytes / capacityBytes;
  return {
    pressure,
    warn: pressure >= 0.7,
    pauseBackfill: pressure >= 0.8,
    pruneIndividualHistory: pressure >= 0.9,
    targetBytes: Math.floor(capacityBytes * 0.8),
  };
}

function sumLatest(candidates: ContributorEvidence[]): number {
  return candidates.reduce((total, candidate) => total + Math.max(0, candidate.latestIntervalValue), 0);
}

function dateParts(timestamp: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(formatted.find(part => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") };
}

function zonedDateTimeToUtc(parts: { year: number; month: number; day: number; hour: number; minute: number; second: number }, timeZone: string): number {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let candidate = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = dateParts(candidate, timeZone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const correction = desired - represented;
    candidate += correction;
    if (correction === 0) break;
  }
  return candidate;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
