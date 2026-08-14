import { describe, expect, it } from "vitest";
import {
  LedgerBudgetExceededError,
  LedgerRunBudget,
  capacityDecision,
  exactAutomaticActionEligible,
  localDayBounds,
  resourceHashBucket,
  resourceHashSegment,
  selectAggregateContributor,
  type AutomaticActionEvidence,
  type ContributorEvidence,
} from "../src/index.js";

describe("ledger periods and sharding", () => {
  it("closes local days across daylight-saving transitions", () => {
    const spring = localDayBounds("2026-03-08", "America/New_York");
    const fall = localDayBounds("2026-11-01", "America/New_York");
    expect(spring.end - spring.start).toBe(23 * 60 * 60_000);
    expect(fall.end - fall.start).toBe(25 * 60 * 60_000);
  });

  it("assigns stable 8-bit resource buckets", () => {
    const ids = Array.from({ length: 20_000 }, (_, index) => `object-${index}`);
    const buckets = new Set(ids.map(resourceHashBucket));
    expect(buckets.size).toBe(256);
    expect(resourceHashBucket(ids[10]!)).toBe(resourceHashBucket(ids[10]!));
  });

  it("partitions oversized buckets into stable secondary segments", () => {
    const ids = Array.from({ length: 2_000 }, (_, index) => `bucket-member-${index}`);
    const segments = new Set(ids.map(id => resourceHashSegment(id)));
    expect(segments.size).toBe(16);
    expect(resourceHashSegment(ids[20]!)).toBe(resourceHashSegment(ids[20]!));
    expect(() => resourceHashSegment("resource", 17)).toThrow(TypeError);
  });
});

describe("automatic action evidence", () => {
  const evidence: AutomaticActionEvidence = {
    resource: {
      controlCapability: "runtime_fuse", runtimeFuseStatus: "verified", excluded: false,
      autoQuarantinePolicy: "allow", tier: "standard",
    },
    quality: "complete", sampleInterval: 1, measurement: "usage", fresh: true,
    ruleOptIn: true, parentDenied: false, alreadyQuarantined: false, confirmationSatisfied: true,
  };

  it("requires complete, fresh, explicitly opted-in evidence", () => {
    expect(exactAutomaticActionEligible(evidence)).toBe(true);
    for (const quality of ["sampled", "partial", "stale", "missing"] as const) {
      expect(exactAutomaticActionEligible({ ...evidence, quality })).toBe(false);
    }
    expect(exactAutomaticActionEligible({ ...evidence, measurement: "estimated_cost" })).toBe(false);
    expect(exactAutomaticActionEligible({ ...evidence, sampleInterval: null })).toBe(false);
    expect(exactAutomaticActionEligible({ ...evidence, parentDenied: true })).toBe(false);
    expect(exactAutomaticActionEligible({ ...evidence, ruleOptIn: false })).toBe(false);
  });

  it("selects aggregate contributors deterministically with meaningful evidence", () => {
    const candidate = (resourceId: string, value: number, overrides: Partial<ContributorEvidence> = {}): ContributorEvidence => ({
      resourceId, latestIntervalValue: value, periodValue: value * 2, aggregateExcess: 100,
      rollingBaseline: 10, crossedOwnEmergency: false, eligible: true, ...overrides,
    });
    expect(selectAggregateContributor([candidate("b", 60), candidate("a", 60)])?.resourceId).toBe("a");
    expect(selectAggregateContributor([candidate("a", 49), candidate("b", 51)])?.resourceId).toBe("b");
    expect(selectAggregateContributor([candidate("a", 60, { rollingBaseline: 20 })])).toBeNull();
  });
});

describe("ledger run budget", () => {
  it("caps configurable limits at the product hard maximum", () => {
    const budget = new LedgerRunBudget({ graphqlQueries: 50_000 });
    expect(budget.limits.graphqlQueries).toBe(500);
    budget.charge("graphqlQueries", 500);
    expect(() => budget.charge("graphqlQueries")).toThrow(LedgerBudgetExceededError);
  });

  it("tracks the largest resource transaction against its configured ceiling", () => {
    const budget = new LedgerRunBudget({ resourcesPerTransaction: 50 });
    budget.observePeak("resourcesPerTransaction", 25);
    budget.observePeak("resourcesPerTransaction", 40);
    expect(budget.usage.resourcesPerTransaction).toBe(40);
    expect(() => budget.observePeak("resourcesPerTransaction", 51)).toThrow(LedgerBudgetExceededError);
  });
});

describe("D1 capacity policy", () => {
  it("warns, pauses backfill, and prunes only at the configured thresholds", () => {
    expect(capacityDecision(699, 1000)).toMatchObject({ warn: false, pauseBackfill: false, pruneIndividualHistory: false });
    expect(capacityDecision(700, 1000)).toMatchObject({ warn: true, pauseBackfill: false, pruneIndividualHistory: false });
    expect(capacityDecision(800, 1000)).toMatchObject({ warn: true, pauseBackfill: true, pruneIndividualHistory: false });
    expect(capacityDecision(900, 1000)).toMatchObject({ warn: true, pauseBackfill: true, pruneIndividualHistory: true, targetBytes: 800 });
  });
});
