import { afterEach, describe, expect, it } from "vitest";
import {
  bisectInitialIngestionRange,
  initialIngestionProgress,
  initialIngestionSlicePlan,
  type InitialIngestionSlicePlan,
} from "../src/initial-ingestion.js";
import {
  HISTORICAL_DATASETS,
  type HistoricalDatasetCapability,
  type HistoricalDatasetSpec,
} from "../src/historical-analytics.js";
import { createTestD1, type TestD1 } from "./d1.js";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 7, 17, 12);

describe("initial ingestion slice plan", () => {
  it("covers each account dataset with a small number of newest-first bounded ranges", () => {
    const slices = initialIngestionSlicePlan(NOW, false, accountCapabilities());
    const workers = datasetSlices(slices, "workersInvocationsAdaptive");

    expect(workers).toHaveLength(3);
    expect(workers[0]?.endsAt).toBe(NOW);
    expect(workers.every(slice => slice.endsAt - slice.startsAt <= 32 * DAY_MS)).toBe(true);
    expect(workers.every((slice, index) => index === 0 || slice.endsAt === workers[index - 1]!.startsAt)).toBe(true);
    expect(workers.reduce((sum, slice) => sum + metadata(slice).units, 0)).toBe(90);
    expect(slices.length).toBeLessThan(100);
  });

  it("batches zone work at Cloudflare's ten-zone limit without losing zone-days", () => {
    const zoneIds = Array.from({ length: 12 }, (_, index) => `zone-${index + 1}`);
    const zoneCapabilities = HISTORICAL_DATASETS
      .filter(spec => spec.root === "zone")
      .flatMap(spec => zoneIds.map(zoneId => enabledCapability(spec, { zoneId, retentionDays: 30, maxDays: 30 })));
    const slices = initialIngestionSlicePlan(NOW, false, [...accountCapabilities(), ...zoneCapabilities]);
    const zones = datasetSlices(slices, "httpRequestsAdaptiveGroups");

    expect(zones).toHaveLength(2);
    expect(zones.every(slice => metadata(slice).zoneIds.length <= 10)).toBe(true);
    expect(new Set(zones.flatMap(slice => metadata(slice).zoneIds))).toEqual(new Set(zoneIds));
    expect(zones.reduce((sum, slice) => sum + metadata(slice).units, 0)).toBe(30 * zoneIds.length);
  });

  it("makes inaccessible retention a terminal, accurately weighted coverage gap", () => {
    const spec = HISTORICAL_DATASETS.find(item => item.dataset === "httpRequestsAdaptiveGroups")!;
    const unavailable = ["zone-1", "zone-2"].map(zoneId => ({
      ...enabledCapability(spec, { zoneId, retentionDays: 30, maxDays: 30 }),
      enabled: false,
      state: "permission_denied" as const,
      detail: "Cloudflare denied Analytics access to this zone.",
    }));
    const gaps = datasetSlices(initialIngestionSlicePlan(NOW, false, [...accountCapabilities(), ...unavailable]), spec.dataset);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ status: "failed", coverageStatus: "missing" });
    expect(metadata(gaps[0]!).units).toBe(60);
    expect(gaps[0]?.error).toContain("denied Analytics access");
  });

  it("adds three non-overlapping billing ranges inside the 31-day API limit", () => {
    const withoutBilling = initialIngestionSlicePlan(NOW, false, accountCapabilities());
    expect(withoutBilling.some(slice => slice.collector === "billing")).toBe(false);

    const billing = initialIngestionSlicePlan(NOW, true, accountCapabilities())
      .filter(slice => slice.collector === "billing");
    expect(billing).toHaveLength(3);
    expect(billing[0]?.endsAt).toBe(NOW);
    expect(billing.every(slice => slice.endsAt - slice.startsAt <= 31 * DAY_MS)).toBe(true);
    expect(billing.every((slice, index) => index === 0 || slice.endsAt === billing[index - 1]!.startsAt)).toBe(true);
    expect(billing.reduce((sum, slice) => sum + metadata(slice).units, 0)).toBe(90);
  });

  it("preserves source-day progress when a dense range is split", () => {
    const startsAt = Date.UTC(2026, 6, 16);
    const children = bisectInitialIngestionRange(startsAt, NOW, 10);

    expect(children).toHaveLength(2);
    expect(children[0]?.startsAt).toBe(startsAt);
    expect(children[0]?.endsAt).toBe(children[1]?.startsAt);
    expect(children[1]?.endsAt).toBe(NOW);
    expect(children.reduce((sum, child) => sum + child.units, 0)).toBe(33 * 10);
  });
});

describe("initial ingestion progress", () => {
  let testD1: TestD1 | undefined;
  afterEach(() => testD1?.close());

  it("reports persisted dataset-days as imported, unavailable, and remaining", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('job','account-1','initial_v2',?1,?2,'running',?2,?2)`,
    ).bind(now - 90 * DAY_MS, now).run();
    await testD1.db.batch([
      progressSlice(testD1.db, "complete", 32, null, now),
      progressSlice(testD1.db, "failed", 28, "permission denied", now - 1),
      progressSlice(testD1.db, "pending", 30, null, now - 2),
    ]);

    const progress = await initialIngestionProgress(testD1.db, "account-1");

    expect(progress.job).toMatchObject({ id: "job", status: "running" });
    expect(progress.collectors).toMatchObject([{
      collector: "graphql:workers",
      total: 3,
      complete: 1,
      failed: 1,
      pending: 1,
      totalUnits: 90,
      completeUnits: 32,
      failedUnits: 28,
      errors: ["permission denied"],
    }]);
  });
});

function accountCapabilities(): HistoricalDatasetCapability[] {
  return HISTORICAL_DATASETS
    .filter(spec => spec.root === "account")
    .map(spec => enabledCapability(spec, { retentionDays: 90, maxDays: 32 }));
}

function enabledCapability(
  spec: HistoricalDatasetSpec,
  options: { zoneId?: string; retentionDays: number; maxDays: number },
): HistoricalDatasetCapability {
  return {
    collector: spec.collector,
    label: spec.label,
    dataset: spec.dataset,
    family: spec.family,
    root: spec.root,
    zoneId: options.zoneId ?? null,
    applicable: true,
    enabled: true,
    maxDurationSeconds: options.maxDays * 86_400,
    notOlderThanSeconds: options.retentionDays * 86_400,
    maxPageSize: 10_000,
    state: "healthy",
    detail: "Available",
  };
}

function datasetSlices(slices: InitialIngestionSlicePlan[], dataset: string): InitialIngestionSlicePlan[] {
  return slices.filter(slice => metadata(slice).dataset === dataset);
}

function metadata(slice: InitialIngestionSlicePlan): { dataset: string; zoneIds: string[]; units: number } {
  return JSON.parse(slice.scopeKey) as { dataset: string; zoneIds: string[]; units: number };
}

function progressSlice(db: D1Database, status: string, units: number, error: string | null, endsAt: number): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO backfill_slices(
       id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,error,updated_at
     ) VALUES(?1,'job','graphql:workers',?2,?3,?4,?5,'missing',?6,?4)`,
  ).bind(
    `${status}-${units}`,
    JSON.stringify({ version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units }),
    endsAt - units * DAY_MS,
    endsAt,
    status,
    error,
  );
}
