import { describe, expect, it } from "vitest";
import {
  PRODUCT_USAGE_DEFINITIONS,
  accountZoneProductDatasetVariables,
  buildAccountZoneProductDatasetQuery,
  buildProductDatasetQuery,
  normalizeProductDataset,
  productUsageDefinition,
} from "../src/product-usage.js";

describe("product usage registry", () => {
  it("covers every non-specialized product family with unique collectors and datasets", () => {
    expect(PRODUCT_USAGE_DEFINITIONS.map(item => item.family)).toEqual([
      "workers_ai", "queues", "d1", "r2", "kv", "pages", "images", "stream",
      "vectorize", "hyperdrive", "ai_gateway", "containers", "browser_rendering",
      "workflows", "worker_builds", "analytics_engine", "log_explorer", "zones", "email",
    ]);
    expect(new Set(PRODUCT_USAGE_DEFINITIONS.map(item => item.collector)).size).toBe(PRODUCT_USAGE_DEFINITIONS.length);
    const datasets = PRODUCT_USAGE_DEFINITIONS.flatMap(item => item.datasets.map(source => source.dataset));
    expect(new Set(datasets).size).toBe(datasets.length);
  });

  it("builds date-bounded account and zone queries", () => {
    const d1 = productUsageDefinition("graphql:d1")!;
    expect(buildProductDatasetQuery(d1, d1.datasets[0]!)).toContain("date_geq: $start, date_leq: $end");
    const zones = productUsageDefinition("graphql:zones")!;
    const query = buildProductDatasetQuery(zones, zones.datasets[0]!);
    expect(query).toContain("zones(filter: { zoneTag_in: $zones })");
    expect(query).toContain("zoneTag");
    const nested = buildAccountZoneProductDatasetQuery(zones, zones.datasets[0]!);
    expect(nested).toContain("accounts(filter: { accountTag: $account })");
    expect(nested).toContain("zones(filter: { zoneTag_in: $zones })");
    expect(accountZoneProductDatasetVariables(
      zones.datasets[0]!, "account-1", Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 2), ["zone-1", "zone-2"],
    )).toMatchObject({ account: "account-1", zones: ["zone-1", "zone-2"] });
  });

  it("normalizes action metrics and maximum storage per resource", () => {
    const kv = productUsageDefinition("graphql:kv")!;
    const operations = normalizeProductDataset(kv, kv.datasets[0]!, [{
      kvOperationsAdaptiveGroups: [
        { dimensions: { namespaceId: "namespace-1", actionType: "read" }, sum: { requests: 12 } },
        { dimensions: { namespaceId: "namespace-1", actionType: "write" }, sum: { requests: 3 } },
      ],
    }], "account-1", 0, 86_400_000);
    expect(operations.map(item => [item.metric, item.value])).toEqual([["reads", 12], ["writes", 3]]);

    const storage = normalizeProductDataset(kv, kv.datasets[1]!, [{
      kvStorageAdaptiveGroups: [
        { dimensions: { namespaceId: "namespace-1" }, max: { byteCount: 100 } },
        { dimensions: { namespaceId: "namespace-1" }, max: { byteCount: 250 } },
      ],
    }], "account-1", 0, 86_400_000);
    expect(storage).toMatchObject([{ metric: "storage_bytes", value: 250, asset: { id: "namespace-1", scope: "namespace" } }]);
  });

  it("keeps the same resource's daily buckets separate across a range", () => {
    const d1 = productUsageDefinition("graphql:d1")!;
    const samples = normalizeProductDataset(d1, d1.datasets[0]!, [{
      d1AnalyticsAdaptiveGroups: [
        { dimensions: { date: "2026-08-15", databaseId: "database-1" }, sum: { rowsRead: 10, rowsWritten: 1 } },
        { dimensions: { date: "2026-08-16", databaseId: "database-1" }, sum: { rowsRead: 20, rowsWritten: 2 } },
      ],
    }], "account-1", Date.UTC(2026, 7, 15), Date.UTC(2026, 7, 17));

    expect(samples.filter(sample => sample.metric === "rows_read").map(sample => [sample.start, sample.value])).toEqual([
      [Date.UTC(2026, 7, 15), 10],
      [Date.UTC(2026, 7, 16), 20],
    ]);
  });

  it("converts container allocation units while retaining its application parent", () => {
    const containers = productUsageDefinition("graphql:containers")!;
    const samples = normalizeProductDataset(containers, containers.datasets[0]!, [{
      containersUsageAdaptiveGroups: [{
        dimensions: { instanceId: "instance-1", applicationId: "application-1" },
        sum: { cpuTimeSec: 2, allocatedMemory: 3_000_000_000, allocatedDisk: 4_000_000_000, txBytes: 5 },
      }],
    }], "account-1", 0, 86_400_000);
    expect(Object.fromEntries(samples.map(item => [item.metric, item.value]))).toEqual({
      vcpu_seconds: 2_000,
      memory_gb_seconds: 3,
      disk_gb_seconds: 4,
      egress_bytes: 5,
    });
    expect(samples[0]?.asset).toMatchObject({ id: "instance-1", parentId: "application-1", scope: "resource" });
  });
});
