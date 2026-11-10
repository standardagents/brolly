import { productMetricContract } from "@standardagents/brolly-core";
import { describe, expect, it } from "vitest";
import {
  PRODUCT_USAGE_DEFINITIONS,
  accountZoneProductDatasetVariables,
  buildAccountZoneProductDatasetQuery,
  buildProductDatasetQuery,
  normalizeProductDataset,
  projectProductDataset,
  productUsageDefinition,
} from "../src/product-usage.js";

describe("product usage registry", () => {
  it("covers every non-specialized product family with unique collectors and datasets", () => {
    expect(PRODUCT_USAGE_DEFINITIONS.map(item => item.family)).toEqual([
      "workers_ai", "queues", "d1", "r2", "kv", "pages", "images", "stream",
      "vectorize", "hyperdrive", "ai_gateway", "containers", "browser_rendering",
      "workflows", "worker_builds", "analytics_engine", "log_explorer", "email",
    ]);
    expect(new Set(PRODUCT_USAGE_DEFINITIONS.map(item => item.collector)).size).toBe(PRODUCT_USAGE_DEFINITIONS.length);
    const datasets = PRODUCT_USAGE_DEFINITIONS.flatMap(item => item.datasets.map(source => source.dataset));
    expect(new Set(datasets).size).toBe(datasets.length);
    expect(productUsageDefinition("graphql:zones")).toBeUndefined();
    expect(PRODUCT_USAGE_DEFINITIONS.every(product =>
      product.datasets.every(source => source.metrics.every(metric =>
        productMetricContract(`${product.family}:${metric.metric}`)?.historySource !== "none"))
      && product.billingOnlyMetrics.every(metric =>
        productMetricContract(`${product.family}:${metric}`)?.historySource === "billing"),
    )).toBe(true);
  });

  it("builds date-bounded account and zone queries", () => {
    const d1 = productUsageDefinition("graphql:d1")!;
    expect(buildProductDatasetQuery(d1, d1.datasets[0]!)).toContain("date_geq: $start, date_leq: $end");
    const email = productUsageDefinition("graphql:email")!;
    const query = buildProductDatasetQuery(email, email.datasets[0]!);
    expect(query).toContain("zones(filter: { zoneTag_in: $zones })");
    expect(query).toContain("zoneTag");
    const nested = buildAccountZoneProductDatasetQuery(email, email.datasets[0]!);
    expect(nested).toContain("accounts(filter: { accountTag: $account })");
    expect(nested).toContain("zones(filter: { zoneTag_in: $zones })");
    expect(accountZoneProductDatasetVariables(
      email.datasets[0]!, "account-1", Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 2), ["zone-1", "zone-2"],
    )).toMatchObject({ account: "account-1", zones: ["zone-1", "zone-2"] });
  });

  it("builds dimension-free aggregate activity probes", () => {
    const vectorize = productUsageDefinition("graphql:vectorize")!;
    const query = buildProductDatasetQuery(vectorize, vectorize.datasets[0]!, 1, true);

    expect(query).toContain("vectorizeV2QueriesAdaptiveGroups(limit: 1,");
    expect(query).toContain("sum { queriedVectorDimensions }");
    expect(query).not.toContain("dimensions {");
    expect(query).not.toContain("indexName");
  });

  it("retains the action discriminator required by operation probes", () => {
    const r2 = productUsageDefinition("graphql:r2")!;
    const query = buildProductDatasetQuery(r2, r2.datasets[0]!, 1, true);

    expect(query).toContain("dimensions { actionType }");
    expect(query).not.toContain("bucketName");
    expect(query).not.toContain("dimensions { date");
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

  it("projects the live schema and never turns an absent aggregate field into zero", () => {
    const d1 = productUsageDefinition("graphql:d1")!;
    const source = projectProductDataset(d1.datasets[0]!, ["dimensions_date", "dimensions_databaseId", "sum_rowsRead"]);
    expect(source.metrics.map(metric => metric.metric)).toEqual(["rows_read"]);
    expect(buildProductDatasetQuery(d1, source)).toContain("sum { rowsRead }");
    expect(buildProductDatasetQuery(d1, source)).not.toContain("rowsWritten");

    const samples = normalizeProductDataset(d1, d1.datasets[0]!, [{
      d1AnalyticsAdaptiveGroups: [{ dimensions: { date: "2026-08-15", databaseId: "database-1" }, sum: { rowsRead: 10 } }],
    }], "account-1", Date.UTC(2026, 7, 15), Date.UTC(2026, 7, 16));
    expect(samples.map(sample => [sample.metric, sample.value])).toEqual([["rows_read", 10]]);
  });

  it("keeps an enabled dataset queryable when settings fields use an unknown shape", () => {
    const d1 = productUsageDefinition("graphql:d1")!;
    const source = projectProductDataset(d1.datasets[0]!, ["fields.rowsRead", "fields.rowsWritten"]);

    expect(source.metrics.map(metric => metric.metric)).toEqual(["rows_read", "rows_written"]);
    expect(buildProductDatasetQuery(d1, source)).toContain("sum { rowsRead rowsWritten }");
  });

  it("does not normalize null or invalid aggregate values as zero", () => {
    const d1 = productUsageDefinition("graphql:d1")!;
    const samples = normalizeProductDataset(d1, d1.datasets[0]!, [{
      d1AnalyticsAdaptiveGroups: [{
        dimensions: { date: "2026-08-15", databaseId: "database-1" },
        sum: { rowsRead: null, rowsWritten: "invalid" },
      }],
    }], "account-1", Date.UTC(2026, 7, 15), Date.UTC(2026, 7, 16));

    expect(samples).toEqual([]);
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
      vcpu_seconds: 2,
      memory_gb_seconds: 3,
      disk_gb_seconds: 4,
      egress_bytes: 5,
    });
    expect(samples[0]?.asset).toMatchObject({ id: "instance-1", parentId: "application-1", scope: "resource" });
  });
});
