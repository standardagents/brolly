import { describe, expect, it } from "vitest";
import {
  PRODUCT_USAGE_DEFINITIONS,
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
