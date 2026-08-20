import { METRIC_DEFINITIONS } from "@standardagents/brolly-core";
import { describe, expect, it } from "vitest";
import {
  INCLUDED_QUOTA_CATALOG_VERSION,
  WORKERS_PAID_INCLUDED,
  classifyPlanTier,
  includedAllotmentsForTier,
  isKnownMetricId,
} from "../src/included-quota.js";

describe("included quota catalog", () => {
  it("uses metric ids from the core metric definition source", () => {
    const known = new Set(METRIC_DEFINITIONS.map(definition => definition.id));
    expect(WORKERS_PAID_INCLUDED.every(item => known.has(item.metricId))).toBe(true);
    expect(WORKERS_PAID_INCLUDED.every(item => isKnownMetricId(item.metricId))).toBe(true);
  });

  it("keeps catalog quantities finite and positive", () => {
    expect(WORKERS_PAID_INCLUDED.length).toBeGreaterThan(0);
    expect(WORKERS_PAID_INCLUDED.every(item => Number.isFinite(item.includedPerCycle) && item.includedPerCycle > 0 && item.unit.length > 0)).toBe(true);
    expect(INCLUDED_QUOTA_CATALOG_VERSION).toMatch(/^\d{4}-\d{2}$/);
  });

  it("classifies account subscription fixtures by active exact plan ids", () => {
    expect(classifyPlanTier({ success: true, result: [{ state: "Paid", rate_plan: { id: "enterprise" } }] })).toBe("enterprise");
    expect(classifyPlanTier({ success: true, result: [{ state: "Paid", rate_plan: { id: "workers_paid" } }] })).toBe("paid");
    expect(classifyPlanTier({ success: true, result: [] })).toBe("free");
    expect(classifyPlanTier({ success: false, errors: [{ message: "forbidden" }] })).toBe("unknown");
  });

  it("does not treat contract-marked add-ons as Enterprise", () => {
    expect(classifyPlanTier({ success: true, result: [{ state: "Paid", rate_plan: { id: "teams_free", is_contract: true } }] })).toBe("free");
  });

  it("ignores zone-scoped rate plans when classifying the account tier", () => {
    expect(classifyPlanTier({ success: true, result: [{ state: "Paid", rate_plan: { id: "enterprise", scope: "zone" } }] })).toBe("free");
    expect(classifyPlanTier({ success: true, result: [{ state: "Paid", rate_plan: { id: "workers_paid", scope: "zone" } }] })).toBe("free");
    expect(classifyPlanTier({ success: true, result: [{ state: "Paid", rate_plan: { id: "workers-paid", scope: "account" } }] })).toBe("free");
    expect(classifyPlanTier({ success: true, result: [{ state: "Paid", scope: "zone", rate_plan: { id: "enterprise" } }] })).toBe("free");
    expect(classifyPlanTier({ success: true, result: [{ state: "Paid", rate_plan: { id: "enterprise", scope: "account" } }] })).toBe("enterprise");
  });

  it("uses the paid baseline for unknown and Enterprise while free has no allotments", () => {
    expect(includedAllotmentsForTier("paid")).toHaveLength(WORKERS_PAID_INCLUDED.length);
    expect(includedAllotmentsForTier("unknown")).toHaveLength(WORKERS_PAID_INCLUDED.length);
    expect(includedAllotmentsForTier("enterprise")).toHaveLength(WORKERS_PAID_INCLUDED.length);
    expect(includedAllotmentsForTier("free")).toEqual([]);
  });
});
