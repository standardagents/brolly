import { describe, expect, it } from "vitest";
import { billingCatalogMetric } from "../src/billing-ledger.js";

describe("billing metric reconciliation", () => {
  it("maps known catalog meters and preserves unknown lines for dynamic catchalls", () => {
    expect(billingCatalogMetric("d1", "rows_read")).toBe("rows_read");
    expect(billingCatalogMetric("durable_objects", "durable_object_requests")).toBe("requests");
    expect(billingCatalogMetric("future_cloudflare_product", "new_meter")).toBeNull();
    expect(billingCatalogMetric("d1", "future_new_meter")).toBeNull();
  });
});
