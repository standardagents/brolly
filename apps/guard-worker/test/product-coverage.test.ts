import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRODUCT_USAGE_DEFINITIONS } from "../src/product-usage.js";

interface DatasetSnapshot {
  root: "account" | "zone";
  dataset: string;
  coverage: "adapter" | "specialized" | "unclassified";
  billable: boolean;
}

interface CoverageSnapshot {
  schemaVersion: number;
  datasets: DatasetSnapshot[];
}

const IGNORABLE_DATASETS: Record<string, string> = {
  firewallEventsAdaptiveGroups: "Security event telemetry does not represent a billable product meter.",
  httpRequests1mGroups: "Fine-grained HTTP telemetry is a general analytics dataset, not a product meter.",
  httpRequests1dGroups: "Fine-grained HTTP telemetry is a general analytics dataset, not a product meter.",
};

// Workers and Durable Objects use specialized collectors in cloudflare.ts.
const SPECIALIZED_DATASET_ADAPTERS = new Set([
  "workersInvocationsAdaptive",
  "durableObjectsInvocationsAdaptiveGroups",
  "durableObjectsPeriodicGroups",
  "durableObjectsSqlStorageGroups",
  "durableObjectsStorageGroups",
]);

function key(root: "account" | "zone", dataset: string): string {
  return `${root}:${dataset}`;
}

function snapshot(): CoverageSnapshot {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/cloudflare-datasets.json");
  return JSON.parse(readFileSync(path, "utf8")) as CoverageSnapshot;
}

describe("Cloudflare product coverage contract", () => {
  it("keeps every billable introspected dataset attached to an adapter", () => {
    const artifact = snapshot();
    expect(artifact.schemaVersion).toBe(1);
    const adapters = new Set(PRODUCT_USAGE_DEFINITIONS.flatMap(item => item.datasets.map(source => key(source.root ?? "account", source.dataset))));
    const uncovered = artifact.datasets
      .filter(item => item.billable)
      .filter(item => !adapters.has(key(item.root, item.dataset)) && !SPECIALIZED_DATASET_ADAPTERS.has(item.dataset))
      .filter(item => !(item.dataset in IGNORABLE_DATASETS));
    expect(uncovered, uncovered.map(item => `${item.root}:${item.dataset}`).join(", ")).toEqual([]);
  });

  it("keeps every registered GraphQL adapter in the authenticated schema snapshot", () => {
    const artifact = snapshot();
    const snapshotKeys = new Set(artifact.datasets.map(item => key(item.root, item.dataset)));
    const missing = PRODUCT_USAGE_DEFINITIONS.flatMap(item => item.datasets)
      .map(source => key(source.root ?? "account", source.dataset))
      .filter(dataset => !snapshotKeys.has(dataset));
    expect(missing).toEqual([]);
  });

  it("documents every ignored dataset with a reason", () => {
    const artifact = snapshot();
    for (const item of artifact.datasets.filter(item => item.dataset in IGNORABLE_DATASETS)) {
      expect(IGNORABLE_DATASETS[item.dataset]).toMatch(/\S/);
    }
  });
});
