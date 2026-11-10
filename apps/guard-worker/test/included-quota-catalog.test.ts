import { METRIC_CATALOG, METRIC_DEFINITIONS, PRODUCT_LIMIT_METRICS, PRODUCT_METRIC_CONTRACTS } from "@standardagents/brolly-core";
import { describe, expect, it } from "vitest";
import {
  INCLUDED_QUOTA_CATALOG_VERSION,
  BILLED_VIA,
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

  it("derives one account-independent Product Limits schema from the canonical contract", () => {
    const ids = PRODUCT_LIMIT_METRICS.map(metric => metric.id);
    const presented = new Set(ids);
    expect(presented.size).toBe(ids.length);
    expect(WORKERS_PAID_INCLUDED.every(item => presented.has(item.metricId))).toBe(true);
    expect(Object.entries(BILLED_VIA).every(([source, mapping]) =>
      PRODUCT_METRIC_CONTRACTS.some(metric => metric.id === source && metric.role === "supporting")
      && presented.has(mapping.metricId),
    )).toBe(true);
    expect(ids.every(id => !id.includes("estimated_cost") && !id.includes("billed_cost"))).toBe(true);
    expect(PRODUCT_METRIC_CONTRACTS.filter(metric => metric.productLimit).map(metric => metric.id)).toEqual(ids);
    expect(PRODUCT_METRIC_CONTRACTS.filter(metric => metric.role === "supporting").every(metric => !metric.productLimit)).toBe(true);
    const families = METRIC_CATALOG.filter(product => product.family !== "unknown").map(product => product.family);
    expect(new Set(PRODUCT_LIMIT_METRICS.map(metric => metric.family))).toEqual(new Set(families));
    expect(METRIC_CATALOG.filter(product => product.family !== "unknown").every(product =>
      product.metrics.every(metric => PRODUCT_METRIC_CONTRACTS.some(contract => contract.id === `${product.family}:${metric}`)),
    )).toBe(true);
  });

  it("presents the four Cloudflare Container billing-usage meters", () => {
    expect(PRODUCT_LIMIT_METRICS.filter(metric => metric.family === "containers")).toEqual([
      { id: "containers:vcpu_seconds", family: "containers", label: "CPU time", unit: "vCPU-s", role: "billable", billingKind: "independent" },
      { id: "containers:memory_gb_seconds", family: "containers", label: "Allocated memory", unit: "GiB-s", role: "billable", billingKind: "independent" },
      { id: "containers:disk_gb_seconds", family: "containers", label: "Allocated disk", unit: "GB-s", role: "billable", billingKind: "independent" },
      { id: "containers:egress_bytes", family: "containers", label: "Egress", unit: "bytes", role: "billable", billingKind: "conditional", condition: "Charges depend on region and included egress." },
    ]);
  });

  it("uses billed Durable Objects units and omits raw WebSocket messages", () => {
    const allotments = new Map(WORKERS_PAID_INCLUDED.map(item => [item.metricId, item.includedPerCycle]));
    expect(allotments.get("durable_objects:rows_read")).toBe(25_000_000_000);
    expect(allotments.get("durable_objects:rows_written")).toBe(50_000_000);
    expect(allotments.get("durable_objects:sql_storage_bytes")).toBe(5_000_000_000);
    expect(allotments.get("durable_objects:kv_read_units")).toBe(1_000_000);
    expect(allotments.get("durable_objects:kv_write_units")).toBe(1_000_000);
    expect(allotments.get("durable_objects:kv_delete_requests")).toBe(1_000_000);
    expect(allotments.get("durable_objects:kv_storage_bytes")).toBe(1_000_000_000);
    expect(allotments.has("durable_objects:incoming_websocket_messages")).toBe(false);
    expect(PRODUCT_LIMIT_METRICS.some(metric => metric.id === "durable_objects:incoming_websocket_messages")).toBe(false);
  });

  it("preserves shared, conditional, quota-only, and announced billing semantics", () => {
    const byId = new Map(PRODUCT_METRIC_CONTRACTS.map(metric => [metric.id, metric]));
    expect(byId.get("pages:requests")).toMatchObject({ billingKind: "shared", sharedBillingMetricId: "workers:requests" });
    expect(byId.get("ai_gateway:logpush_requests")).toMatchObject({ billingKind: "conditional" });
    expect(byId.get("hyperdrive:database_queries")).toMatchObject({ billingKind: "quota_only" });
    expect(byId.get("analytics_engine:data_points_written")).toMatchObject({ billingKind: "announced" });
    expect(byId.get("ai_gateway:cost_usd")).toMatchObject({ productLimit: false, billingKind: "provider" });
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
