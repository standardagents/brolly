import { describe, expect, it } from "vitest";
import { billingCatalogMetric, billingCycleEnd } from "../src/billing-ledger.js";

describe("billing metric reconciliation", () => {
  it("maps known catalog meters and preserves unknown lines for dynamic catchalls", () => {
    expect(billingCatalogMetric("d1", "rows_read")).toBe("rows_read");
    expect(billingCatalogMetric("durable_objects", "durable_object_requests")).toBe("requests");
    expect(billingCatalogMetric("future_cloudflare_product", "new_meter")).toBeNull();
    expect(billingCatalogMetric("d1", "future_new_meter")).toBeNull();
    expect(billingCatalogMetric("workers", "cached_requests_breakdown")).toBeNull();
    expect(billingCatalogMetric("hyperdrive", "database_queries")).toBeNull();
    expect(billingCatalogMetric("pages", "requests")).toBeNull();
  });

  it("derives a missing billing-cycle end from the account anchor day", () => {
    expect(billingCycleEnd(Date.UTC(2026, 5, 9))).toBe(Date.UTC(2026, 6, 9));
    expect(billingCycleEnd(Date.UTC(2026, 0, 31))).toBe(Date.UTC(2026, 1, 28));
    expect(billingCycleEnd(Date.UTC(2026, 5, 9), "2026-07-12T00:00:00Z")).toBe(Date.UTC(2026, 6, 12));
  });
});
