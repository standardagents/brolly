import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerRunBudget } from "@standardagents/brolly-core";
import {
  activityProbeInitialIngestionSlices,
  bisectInitialIngestionRange,
  ensureInitialIngestionJob,
  initialIngestionProgress,
  initialIngestionSchedulingState,
  initialIngestionSlicePlan,
  prioritizeInitialIngestionSlices,
  resourceAwarePageSize,
  runInitialIngestion,
  terminateInitialDatasetSlices,
  type InitialIngestionSlicePlan,
} from "../src/initial-ingestion.js";
import {
  HISTORICAL_DATASETS,
  type HistoricalDatasetCapability,
  type HistoricalDatasetSpec,
} from "../src/historical-analytics.js";
import { createTestD1, type TestD1 } from "./d1.js";
import type { Env } from "../src/env.js";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 7, 17, 12);

describe("initial ingestion slice plan", () => {
  it("bounds date-based resource pages with headroom and a truncation sentinel", () => {
    expect(resourceAwarePageSize(10_000, 30, 28)).toBe(1_009);
    expect(resourceAwarePageSize(10_000, 30, 2_000)).toBe(10_000);
  });

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

  it("reserves fresh GraphQL windows for scan-heavy daily aggregates", () => {
    const slices = initialIngestionSlicePlan(NOW, false, accountCapabilities());
    const transformations = datasetSlices(slices, "imagesTransformationsAdaptiveGroups");
    const requests = datasetSlices(slices, "imagesRequestsAdaptiveGroups");

    expect(transformations.length).toBeGreaterThan(0);
    expect(transformations.every(slice => metadata(slice).freshGraphqlBudgetRequired === true)).toBe(true);
    expect(requests).toEqual([]);
  });

  it("batches up to ten zones per request", () => {
    const zoneIds = Array.from({ length: 12 }, (_, index) => `zone-${index + 1}`);
    const zoneCapabilities = HISTORICAL_DATASETS
      .filter(spec => spec.root === "zone")
      .flatMap(spec => zoneIds.map(zoneId => enabledCapability(spec, { zoneId, retentionDays: 30, maxDays: 30 })));
    const slices = initialIngestionSlicePlan(NOW, false, [...accountCapabilities(), ...zoneCapabilities]);
    const zones = datasetSlices(slices, "emailSendingAdaptiveGroups");

    expect(zones).toHaveLength(4);
    expect(zones.every(slice => metadata(slice).zoneIds.length <= 10)).toBe(true);
    expect(new Set(zones.flatMap(slice => metadata(slice).zoneIds))).toEqual(new Set(zoneIds));
    expect(zones.filter(slice => slice.status === "pending")).toHaveLength(2);
    expect(zones.filter(slice => slice.status === "complete")).toHaveLength(2);
    expect(zones.reduce((sum, slice) => sum + metadata(slice).units, 0)).toBe(90 * zoneIds.length);
  });

  it("makes inaccessible retention a terminal, accurately weighted coverage gap", () => {
    const spec = HISTORICAL_DATASETS.find(item => item.dataset === "emailSendingAdaptiveGroups")!;
    const unavailable = ["zone-1", "zone-2"].map(zoneId => ({
      ...enabledCapability(spec, { zoneId, retentionDays: 30, maxDays: 30 }),
      enabled: false,
      state: "permission_denied" as const,
      detail: "Cloudflare denied Analytics access to this zone.",
    }));
    const gaps = datasetSlices(initialIngestionSlicePlan(NOW, false, [...accountCapabilities(), ...unavailable]), spec.dataset);

    expect(gaps).toHaveLength(1);
    expect(gaps.every(gap => gap.status === "failed" && gap.coverageStatus === "missing")).toBe(true);
    expect(gaps.reduce((sum, gap) => sum + metadata(gap).units, 0)).toBe(180);
    expect(metadata(gaps[0]!).zoneIds).toEqual(["zone-1", "zone-2"]);
    expect(gaps[0]?.error).toContain("denied Analytics access");
  });

  it("adds three non-overlapping billing ranges inside the 31-day API limit", () => {
    const withoutBilling = initialIngestionSlicePlan(NOW, false, accountCapabilities());
    expect(withoutBilling.filter(slice => slice.collector === "billing")).toMatchObject([{
      status: "complete",
      coverageStatus: "missing",
    }]);

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

  it("prioritizes Durable Objects, Workers, then remaining families by billed cost", () => {
    const prioritized = prioritizeInitialIngestionSlices(
      initialIngestionSlicePlan(NOW, false, accountCapabilities()),
      { kv: 9_000, r2: 4_000, d1: 2_000 },
    );
    const priority = (collector: string) => metadata(prioritized.find(slice => slice.collector === collector)!).priority;

    expect(priority("graphql:durable-objects")).toBeLessThan(priority("graphql:workers")!);
    expect(priority("graphql:workers")).toBeLessThan(priority("graphql:kv")!);
    expect(priority("graphql:kv")).toBeLessThan(priority("graphql:r2")!);
    expect(priority("graphql:r2")).toBeLessThan(priority("graphql:d1")!);
  });

  it("uses daily bounded probes for scan-heavy datasets", () => {
    const slices = activityProbeInitialIngestionSlices(
      initialIngestionSlicePlan(NOW, true, accountCapabilities()),
    );
    const images = datasetSlices(slices, "imagesTransformationsAdaptiveGroups")
      .filter(slice => slice.status === "pending");
    const workers = datasetSlices(slices, "workersInvocationsAdaptive")
      .filter(slice => slice.status === "pending");
    const durable = datasetSlices(slices, "durableObjectsPeriodicGroups")
      .filter(slice => slice.status === "pending");

    expect(images).toHaveLength(90);
    expect(images.every(slice => metadata(slice).activityProbe === true
      && metadata(slice).pageSizeHint === 2
      && slice.endsAt - slice.startsAt <= DAY_MS
      && metadata(slice).freshGraphqlBudgetRequired === false)).toBe(true);
    expect(workers.every(slice => metadata(slice).activityProbe !== true)).toBe(true);
    expect(durable.every(slice => metadata(slice).activityProbe !== true)).toBe(true);
  });

});

describe("initial ingestion progress", () => {
  let testD1: TestD1 | undefined;

  it("promotes every sibling after one positive activity probe and protects the first detail calibration", async () => {
    vi.useFakeTimers();
    testD1 = createTestD1();
    const now = Date.UTC(2026, 7, 30, 18);
    vi.setSystemTime(now);
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('probe-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 3 * DAY_MS, now),
      ...Array.from({ length: 3 }, (_, index) => testD1!.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES(?1,'probe-job','graphql:worker_builds',?2,?3,?4,'pending','missing',?4)`,
      ).bind(`probe-slice-${index}`, JSON.stringify({
        version: 2,
        dataset: "workersBuildsBuildMinutesAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        pageSizeHint: 1,
        units: 1,
        priority: 10,
        activityProbe: true,
      }), now - (index + 1) * DAY_MS, now - index * DAY_MS)),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "probe-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 33_000,
          reportedAt: now,
          reportedForRequestAt: now,
          observedCapacity: 33_000,
          lastObservedRemaining: 33_000,
          lastObservedAt: now,
          lastObservedRequestAt: now - 1,
          admissions: [],
        }), now),
    ]);
    const queries: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      queries.push(body.query);
      const detailed = body.query.includes("dimensions {");
      return Response.json({ data: {
        cost: 111,
        viewer: {
          budget: detailed ? 33_000 - Math.max(0, queries.length - 2) * 111 : 1_000,
          accounts: [{ workersBuildsBuildMinutesAdaptiveGroups: detailed
            ? [{ dimensions: { date: new Date(now - DAY_MS).toISOString().slice(0, 10) }, sum: { buildMinutes: 9 } }]
            : [{ sum: { buildMinutes: 9 } }],
          }],
        },
      } });
    }));

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "probe-job",
    );

    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("dimensions {");
    const promoted = await testD1.db.prepare(
      `SELECT status,scope_key FROM backfill_slices WHERE backfill_job_id='probe-job' ORDER BY starts_at`,
    ).all<{ status: string; scope_key: string }>();
    expect(promoted.results).toHaveLength(3);
    expect(promoted.results.every(row => {
      const parsed = JSON.parse(row.scope_key) as {
        activityProbe?: boolean;
        freshGraphqlBudgetRequired?: boolean;
        detailCalibrationRequired?: boolean;
      };
      return row.status === "pending"
        && parsed.activityProbe === undefined
        && parsed.freshGraphqlBudgetRequired === false
        && parsed.detailCalibrationRequired === true;
    })).toBe(true);
    const isolatedQuota = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    expect(JSON.parse(isolatedQuota!.value)).toMatchObject({
      observedMaxDebit: 0,
      observedDebits: { "workersBuildsBuildMinutesAdaptiveGroups:activity_probe:1": 32_000 },
    });
    expect(JSON.parse(isolatedQuota!.value).observedDebits)
      .not.toHaveProperty("workersBuildsBuildMinutesAdaptiveGroups");
    expect(JSON.parse(isolatedQuota!.value).protectedHeadDebit).toBe(32_990);

    await vi.advanceTimersByTimeAsync(300_001);
    const resumed = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "probe-job",
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await resumed;

    expect(queries).toHaveLength(4);
    expect(queries.slice(1).every(query => query.includes("dimensions {"))).toBe(true);
    const complete = await testD1.db.prepare(
      `SELECT status,scope_key FROM backfill_slices WHERE backfill_job_id='probe-job' ORDER BY starts_at`,
    ).all<{ status: string; scope_key: string }>();
    expect(complete.results.every(row => row.status === "complete")).toBe(true);
    expect(complete.results.every(row => JSON.parse(row.scope_key).detailCalibrationRequired === undefined)).toBe(true);
  });

  it("calibrates a protected KV detail from its own probe instead of an unrelated dataset", async () => {
    vi.useFakeTimers();
    testD1 = createTestD1();
    const now = Date.UTC(2026, 7, 30, 19);
    vi.setSystemTime(now);
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('kv-calibration-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 8 * DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('kv-calibration-detail','kv-calibration-job','graphql:kv',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "kvOperationsAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        units: 8,
        priority: 10,
        freshGraphqlBudgetRequired: false,
        detailCalibrationRequired: true,
      }), now - 8 * DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('kv-calibration-residual','kv-calibration-job','graphql:worker_builds',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "workersBuildsBuildMinutesAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        pageSizeHint: 1,
        units: 1,
        priority: 11,
        activityProbe: true,
      }), now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "kv-calibration-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 11_953,
          reportedAt: now,
          reportedForRequestAt: now,
          observedCapacity: 33_189,
          observedMaxCost: 842,
          observedMaxDebit: 9_435,
          observedCostMultiplier: 111,
          observedCosts: { "1": 111 },
          observedDebits: {
            durableObjectsSqlStorageGroups: 9_435,
            "kvOperationsAdaptiveGroups:activity_probe:8": 1_428,
            "kvOperationsAdaptiveGroups:activity_probe:32": 20_000,
          },
          admissions: [{
            admittedAt: now,
            logicalQueries: 1,
            physicalRequests: 1,
            budgetDebit: 1_428,
            budgetKey: "kvOperationsAdaptiveGroups:activity_probe:8",
          }],
        }), now),
    ]);
    const requests: Array<{ at: number; query: string }> = [];
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      requests.push({ at: Date.now(), query });
      const kv = query.includes("kvOperationsAdaptiveGroups");
      return Response.json({ data: {
        cost: 111,
        viewer: {
          budget: kv ? 10_000 : 9_889,
          accounts: [{
            ...(kv
              ? { kvOperationsAdaptiveGroups: [] }
              : { workersBuildsBuildMinutesAdaptiveGroups: [] }),
          }],
        },
      } });
    }));

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "kv-calibration-job",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await run;
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]?.query).toContain("kvOperationsAdaptiveGroups");
    expect(requests[0]?.query).toContain("dimensions {");
    expect(requests[0]!.at - now).toBeLessThan(30_000);
    const reservation = info.mock.calls.find(call => call[0] === "brolly.initial_graphql_priority_reserved");
    expect(JSON.parse(String(reservation?.[1]))).toMatchObject({
      debit: 1_785,
      estimateSource: "dataset_probe",
      sourceBudgetKey: "kvOperationsAdaptiveGroups:activity_probe:8",
      sourceDebit: 1_428,
      sourceRangeDays: 8,
      scaledSourceDebit: 1_428,
      targetRangeDays: 8,
    });
    const reserved = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    const quota = JSON.parse(reserved!.value) as {
      observedDebits: Record<string, number>;
      observedMaxDebit: number;
    };
    expect(quota.observedDebits.kvOperationsAdaptiveGroups).toBe(111);
    expect(quota.observedMaxDebit).toBe(9_435);
    const detail = await testD1.db.prepare(
      `SELECT status,scope_key FROM backfill_slices WHERE id='kv-calibration-detail'`,
    ).first<{ status: string; scope_key: string }>();
    expect(detail?.status).toBe("complete");
    expect(JSON.parse(detail!.scope_key).detailCalibrationRequired).toBeUndefined();
    info.mockRestore();
  });

  it("keeps same-dataset probe evidence above a small daily result-page estimate", async () => {
    vi.useFakeTimers();
    testD1 = createTestD1();
    const now = Date.UTC(2026, 7, 30, 20);
    vi.setSystemTime(now);
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('daily-calibration-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 8 * DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('daily-calibration-detail','daily-calibration-job','graphql:worker_builds',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "workersBuildsBuildMinutesAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        units: 8,
        priority: 10,
        freshGraphqlBudgetRequired: false,
        detailCalibrationRequired: true,
      }), now - 8 * DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "daily-calibration-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 11_953,
          reportedAt: now,
          reportedForRequestAt: now,
          observedCapacity: 33_189,
          observedMaxCost: 842,
          observedMaxDebit: 9_435,
          observedCostMultiplier: 111,
          observedCosts: { "1": 111 },
          observedDebits: {
            durableObjectsSqlStorageGroups: 9_435,
            "workersBuildsBuildMinutesAdaptiveGroups:activity_probe:8": 1_428,
          },
          admissions: [{
            admittedAt: now,
            logicalQueries: 1,
            physicalRequests: 1,
            budgetDebit: 1_428,
            budgetKey: "workersBuildsBuildMinutesAdaptiveGroups:activity_probe:8",
          }],
        }), now),
    ]);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: {
      cost: 111,
      viewer: {
        budget: 10_000,
        accounts: [{ workersBuildsBuildMinutesAdaptiveGroups: [] }],
      },
    } })));

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "daily-calibration-job",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await run;

    const reservation = info.mock.calls.find(call => call[0] === "brolly.initial_graphql_priority_reserved");
    expect(JSON.parse(String(reservation?.[1]))).toMatchObject({
      debit: 1_785,
      estimateSource: "dataset_probe",
      sourceBudgetKey: "workersBuildsBuildMinutesAdaptiveGroups:activity_probe:8",
      targetRangeDays: 8,
    });
    expect(await testD1.db.prepare(
      `SELECT status FROM backfill_slices WHERE id='daily-calibration-detail'`,
    ).first<{ status: string }>()).toMatchObject({ status: "complete" });
    info.mockRestore();
  });

  it("splits an unaffordable full-range probe before fetching and preserves exhaustive coverage", async () => {
    vi.useFakeTimers();
    testD1 = createTestD1();
    const now = Date.UTC(2026, 7, 30);
    const startsAt = now - 32 * DAY_MS;
    vi.setSystemTime(now);
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('probe-split-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(startsAt, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('probe-split-parent','probe-split-job','graphql:worker_builds',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "workersBuildsBuildMinutesAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        pageSizeHint: 1,
        units: 32,
        priority: 10,
        activityProbe: true,
      }), startsAt, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "probe-split-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 9_000,
          reportedAt: now,
          reportedForRequestAt: now,
          observedCapacity: 33_000,
          observedMaxCost: 111,
          observedCostMultiplier: 111,
          observedCosts: { "1": 111 },
          admissions: [],
        }), now),
    ]);
    const ranges: Array<{ start: number; end: number; requestedAt: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: { start: string; end: string } };
      ranges.push({
        start: Date.parse(body.variables.start),
        end: Date.parse(body.variables.end) + DAY_MS,
        requestedAt: Date.now(),
      });
      return Response.json({ data: {
        cost: 111,
        viewer: { budget: 9_000, accounts: [{ workersBuildsBuildMinutesAdaptiveGroups: [] }] },
      } });
    }));

    for (let invocation = 0; invocation < 3; invocation += 1) {
      const run = runInitialIngestion(
        { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
        "probe-split-job",
      );
      for (let index = 0; index < 8; index += 1) await vi.advanceTimersByTimeAsync(5_000);
      await run;
    }

    const ordered = ranges.sort((left, right) => left.start - right.start);
    expect(ordered).toHaveLength(4);
    expect(ordered[0]?.start).toBe(startsAt);
    expect(ordered.at(-1)?.end).toBe(now);
    expect(ordered.every((range, index) => (
      range.end - range.start <= 8 * DAY_MS
      && (index === 0 || ordered[index - 1]!.end === range.start)
    ))).toBe(true);
    const requestTimes = ranges.map(range => range.requestedAt).sort((left, right) => left - right);
    expect(requestTimes.slice(1).every((requestedAt, index) => (
      requestedAt - requestTimes[index]! >= 1_200
      && requestedAt - requestTimes[index]! < 2_000
    ))).toBe(true);
    const leaves = await testD1.db.prepare(
      `SELECT starts_at,ends_at,status FROM backfill_slices
       WHERE backfill_job_id='probe-split-job' AND status!='superseded' ORDER BY starts_at`,
    ).all<{ starts_at: number; ends_at: number; status: string }>();
    expect(leaves.results).toHaveLength(4);
    expect(leaves.results.every(row => row.status === "complete")).toBe(true);
    const quota = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    expect(JSON.parse(quota!.value).pausedUntil).toBeNull();
  });

  it("reports actual probe pacing instead of the larger admission reservation", async () => {
    vi.useFakeTimers();
    testD1 = createTestD1();
    const now = Date.UTC(2026, 7, 30);
    vi.setSystemTime(now);
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('probe-pacing-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 8 * DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('probe-pacing-slice','probe-pacing-job','graphql:worker_builds',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "workersBuildsBuildMinutesAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        pageSizeHint: 1,
        units: 8,
        priority: 10,
        activityProbe: true,
      }), now - 8 * DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "probe-pacing-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 33_000,
          reportedAt: now,
          reportedForRequestAt: now,
          observedCapacity: 33_000,
          admissions: [],
        }), now),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network unavailable");
    }));

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "probe-pacing-job",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await run;

    const progress = await initialIngestionProgress(testD1.db, "account-1");
    expect(progress.job?.queryIntervalMs).toBe(1_200);
    expect(progress.job?.waitReason).not.toBe("pacing");
  });

  it("splits a full-range probe when only recovered capacity is known", async () => {
    testD1 = createTestD1();
    const now = Date.UTC(2026, 7, 30);
    const startsAt = now - 32 * DAY_MS;
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('unknown-probe-budget-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(startsAt, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('unknown-probe-budget-slice','unknown-probe-budget-job','graphql:worker_builds',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "workersBuildsBuildMinutesAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        pageSizeHint: 1,
        units: 32,
        priority: 10,
        activityProbe: true,
      }), startsAt, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "unknown-probe-budget-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: null,
          observedCapacity: 33_000,
          admissions: [],
        }), now),
    ]);
    const durations: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: { start: string; end: string } };
      durations.push(Date.parse(body.variables.end) + DAY_MS - Date.parse(body.variables.start));
      return Response.json({ data: {
        cost: 111,
        viewer: {
          budget: 33_000,
          accounts: [{ workersBuildsBuildMinutesAdaptiveGroups: [{ sum: { buildMinutes: 1 } }] }],
        },
      } });
    }));

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "unknown-probe-budget-job",
    );

    expect(durations.length).toBeGreaterThan(0);
    expect(Math.max(...durations)).toBeLessThanOrEqual(16 * DAY_MS);
    expect(await testD1.db.prepare(
      `SELECT status FROM backfill_slices WHERE id='unknown-probe-budget-slice'`,
    ).first()).toMatchObject({ status: "superseded" });
  });

  it("limits unknown-capacity probe splitting to eight-day leaves", async () => {
    vi.useFakeTimers();
    testD1 = createTestD1();
    const now = Date.UTC(2026, 7, 30);
    const startsAt = now - 32 * DAY_MS;
    vi.setSystemTime(now);
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('cold-probe-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(startsAt, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('cold-probe-slice','cold-probe-job','graphql:worker_builds',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "workersBuildsBuildMinutesAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        pageSizeHint: 1,
        units: 32,
        priority: 10,
        activityProbe: true,
      }), startsAt, now),
    ]);
    const ranges: Array<{ start: number; end: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: { start: string; end: string } };
      ranges.push({
        start: Date.parse(body.variables.start),
        end: Date.parse(body.variables.end) + DAY_MS,
      });
      return Response.json({ data: {
        viewer: { accounts: [{ workersBuildsBuildMinutesAdaptiveGroups: [] }] },
      } });
    }));

    for (let invocation = 0; invocation < 3; invocation += 1) {
      const run = runInitialIngestion(
        { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
        "cold-probe-job",
      );
      for (let index = 0; index < 8; index += 1) await vi.advanceTimersByTimeAsync(5_000);
      await run;
    }

    const ordered = ranges.sort((left, right) => left.start - right.start);
    expect(ordered).toHaveLength(4);
    expect(ordered[0]?.start).toBe(startsAt);
    expect(ordered.at(-1)?.end).toBe(now);
    expect(ordered.every((range, index) => (
      range.end - range.start === 8 * DAY_MS
      && (index === 0 || ordered[index - 1]!.end === range.start)
    ))).toBe(true);
  });

  it("detects historical-only activity and imports every remaining range", async () => {
    vi.useFakeTimers();
    testD1 = createTestD1();
    const now = Date.UTC(2026, 7, 30);
    vi.setSystemTime(now);
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('historical-probe-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 3 * DAY_MS, now),
      ...Array.from({ length: 3 }, (_, index) => testD1!.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES(?1,'historical-probe-job','graphql:worker_builds',?2,?3,?4,'pending','missing',?4)`,
      ).bind(`historical-probe-${index}`, JSON.stringify({
        version: 2,
        dataset: "workersBuildsBuildMinutesAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        pageSizeHint: 1,
        units: 1,
        priority: 10,
        activityProbe: true,
      }), now - (index + 1) * DAY_MS, now - index * DAY_MS)),
    ]);
    const requests: Array<{ detailed: boolean; start: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { start: string };
      };
      const detailed = body.query.includes("dimensions {");
      requests.push({ detailed, start: body.variables.start });
      const recentProbe = !detailed && Date.parse(body.variables.start) === now - DAY_MS;
      return Response.json({ data: {
        cost: 111,
        viewer: {
          budget: 33_000 - Math.max(0, requests.length - 1) * 111,
          accounts: [{ workersBuildsBuildMinutesAdaptiveGroups: recentProbe
            ? []
            : detailed
              ? [{ dimensions: { date: body.variables.start.slice(0, 10) }, sum: { buildMinutes: 7 } }]
              : [{ sum: { buildMinutes: 7 } }],
          }],
        },
      } });
    }));

    const first = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "historical-probe-job",
    );
    for (let index = 0; index < 4; index += 1) await vi.advanceTimersByTimeAsync(5_000);
    await first;
    expect(requests.filter(request => !request.detailed)).toHaveLength(2);
    const complete = await testD1.db.prepare(
      `SELECT status,scope_key FROM backfill_slices WHERE backfill_job_id='historical-probe-job' ORDER BY starts_at`,
    ).all<{ status: string; scope_key: string }>();
    expect(requests.filter(request => !request.detailed)).toHaveLength(2);
    expect(requests.filter(request => request.detailed)).toHaveLength(2);
    expect(complete.results.every(row => row.status === "complete")).toBe(true);
    expect(complete.results.every(row => JSON.parse(row.scope_key).detailCalibrationRequired === undefined)).toBe(true);
  });

  it("persists a one-day Images aggregate without a second query", async () => {
    testD1 = createTestD1();
    const endsAt = Date.UTC(2026, 7, 17);
    const startsAt = endsAt - DAY_MS;
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('images-probe-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(startsAt, endsAt),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('images-probe-slice','images-probe-job','graphql:images',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "imagesTransformationsAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        pageSizeHint: 2,
        units: 1,
        priority: 10,
        activityProbe: true,
      }), startsAt, endsAt),
    ]);
    const fetch = vi.fn(async () => Response.json({ data: {
      cost: 111,
      viewer: {
        budget: 33_000,
        accounts: [{ imagesTransformationsAdaptiveGroups: [{ sum: { billableEventCount: 4 } }] }],
      },
    } }));
    vi.stubGlobal("fetch", fetch);

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "images-probe-job",
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await testD1.db.prepare(`SELECT status FROM backfill_slices WHERE id='images-probe-slice'`).first())
      .toMatchObject({ status: "complete" });
    const usage = await testD1.db.prepare(`SELECT payload_json FROM usage_accumulator_shards LIMIT 1`)
      .first<{ payload_json: string }>();
    expect(usage?.payload_json).toContain('"images:transformations":{"day":4,"cycle":4');
  });

  it("keeps the monitor gated until onboarding finishes and prioritizes an active first import", async () => {
    testD1 = createTestD1();
    expect(await initialIngestionSchedulingState(testD1.db, "account-1")).toEqual({
      importActive: false,
      onboardingComplete: false,
    });

    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('scheduler-job','account-1','initial_v2',?1,?2,'running',?2,?2)`,
    ).bind(NOW - DAY_MS, NOW).run();
    expect(await initialIngestionSchedulingState(testD1.db, "account-1")).toEqual({
      importActive: true,
      onboardingComplete: false,
    });

    await testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('onboarding_complete','true',?1)`).bind(NOW).run();
    expect(await initialIngestionSchedulingState(testD1.db, "account-1")).toEqual({
      importActive: true,
      onboardingComplete: true,
    });
  });

  it("resets shared fallback mode when progress belongs to a new import job", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('new-job','account-1','initial_v2',?1,?2,'running',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`).bind(
        "initial_ingestion_quota:account-1",
        JSON.stringify({
          jobId: "old-job",
          limiterMode: "shared-fallback",
          windowStartedAt: now,
          physicalUsed: 20,
          sharedUsed: 20,
          accountUsed: 20,
          zoneUsed: {},
        }),
        now,
      ),
    ]);

    expect((await initialIngestionProgress(testD1.db, "account-1")).job).toMatchObject({
      id: "new-job",
      limiterMode: "shared-paced",
    });
  });

  afterEach(() => {
    testD1?.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retires legacy generic Zone traffic slices without another Cloudflare request", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('retired-zones-job','account-1','initial_v2',?1,?2,'running',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('retired-zones-slice','retired-zones-job','graphql:zones',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2, dataset: "httpRequests1dGroups", zoneIds: ["a".repeat(32)], maxPageSize: 10_000, units: 1,
      }), now - DAY_MS, now),
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "retired-zones-job",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await testD1.db.prepare(`SELECT status FROM backfill_slices WHERE id='retired-zones-slice'`).first()).toMatchObject({ status: "superseded" });
    expect(await testD1.db.prepare(`SELECT status FROM backfill_jobs WHERE id='retired-zones-job'`).first()).toMatchObject({ status: "complete" });
  });

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

    expect(progress.job).toMatchObject({
      id: "job",
      status: "running",
      sharedQueryLimit: 270,
      queryIntervalMs: 1_200,
    });
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

  it("treats unavailable partitions as gaps while available pending work blocks the day", async () => {
    testD1 = createTestD1();
    const start = Date.UTC(2026, 7, 1);
    const end = start + 3 * DAY_MS;
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('days-job','account-1','initial_v2',?1,?2,'running',?2,?2)`,
    ).bind(start, end).run();
    const slice = (id: string, from: number, to: number, status: string, availability: string, terminalGap: boolean, error: string | null) => testD1!.db.prepare(
      `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,error,updated_at)
       VALUES(?1,'days-job','graphql:workers',?2,?3,?4,?5,'missing',?6,?4)`,
    ).bind(id, JSON.stringify({ version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1, availability, terminalGap }), from, to, status, error);
    await testD1.db.batch([
      slice("complete", start, end, "complete", "available", false, null),
      slice("unavailable", start, end, "failed", "unavailable", true, "permission denied"),
      slice("failed", start + DAY_MS, start + 2 * DAY_MS, "failed", "available", true, "request timed out"),
      slice("pending", start + 2 * DAY_MS, end, "pending", "available", false, null),
    ]);

    const progress = await initialIngestionProgress(testD1.db, "account-1");

    expect(progress.days).toEqual({
      total: 3, complete: 1, pending: 1, gaps: 3, failedWindows: 2,
      errors: ["permission denied", "request timed out"],
      issues: [{
        dataset: "workersInvocationsAdaptive",
        label: "Workers",
        fromDay: "2026-08-01",
        toDay: "2026-08-03",
        affectedDays: 3,
        affectedScopes: null,
        scope: "account",
        reason: "permission denied",
      }],
    });
  });

  it("keeps days without any planned slice incomplete and marks them as gaps", async () => {
    testD1 = createTestD1();
    const start = Date.UTC(2026, 7, 1);
    const end = start + 3 * DAY_MS;
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('missing-day-job','account-1','initial_v2',?1,?2,'complete',?2,?2)`,
    ).bind(start, end).run();
    await testD1.db.prepare(
      `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
       VALUES('middle-day','missing-day-job','graphql:workers',?1,?2,?3,'complete','complete',?3)`,
    ).bind(
      JSON.stringify({ version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1 }),
      start + DAY_MS,
      start + 2 * DAY_MS,
    ).run();

    const progress = await initialIngestionProgress(testD1.db, "account-1");

    expect(progress.days).toMatchObject({ total: 3, complete: 1, pending: 0, gaps: 2 });
  });

  it("reports Billing, account, and product readiness from terminal slice evidence", async () => {
    testD1 = createTestD1();
    const start = NOW - DAY_MS;
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('readiness-job','account-1','initial_v2',?1,?2,'running',?2,?2)`,
    ).bind(start, NOW).run();
    const slice = (id: string, collector: string, dataset: string, status: string, extra: Record<string, unknown> = {}) => testD1!.db.prepare(
      `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,error,updated_at)
       VALUES(?1,'readiness-job',?2,?3,?4,?5,?6,'missing',?7,?5)`,
    ).bind(id, collector, JSON.stringify({
      version: 2, dataset, zoneIds: [], maxPageSize: 10_000, units: 1, availability: "available", ...extra,
    }), start, NOW, status, status === "failed" ? "coverage gap" : null);
    await testD1.db.batch([
      slice("billing", "billing", "billable-usage", "complete"),
      slice("workers", "graphql:workers", "workersInvocationsAdaptive", "complete"),
      slice("d1-complete", "graphql:d1", "d1AnalyticsAdaptiveGroups", "complete"),
      slice("d1-gap", "graphql:d1", "d1AnalyticsAdaptiveGroups", "failed", { terminalGap: true }),
      slice("email-pending", "graphql:email", "emailSendingAdaptiveGroups", "pending"),
    ]);

    const progress = await initialIngestionProgress(testD1.db, "account-1");

    expect(progress.readiness).toMatchObject({
      billing: "ready",
      account: "limited",
      products: {
        workers: { state: "ready", percent: 100, errors: 0 },
        d1: { state: "ready", percent: 100, errors: 1 },
        email: { state: "ready", percent: 0, errors: 0 },
        pages: { state: "importing", percent: 0, errors: 0 },
      },
    });
    expect(Object.keys(progress.readiness.products)).toHaveLength(20);
    expect(progress.readiness.products.ai_gateway).toEqual({ state: "ready", percent: 100, errors: 0 });
  });

  it("keeps account readiness pending while account history continues", async () => {
    testD1 = createTestD1();
    const start = NOW - DAY_MS;
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('billing-ready-job','account-1','initial_v2',?1,?2,'running',?2,?2)`,
      ).bind(start, NOW),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,error,updated_at)
         VALUES('billing-ready','billing-ready-job','billing',?1,?2,?3,'complete','complete',NULL,?3)`,
      ).bind(JSON.stringify({
        version: 2, dataset: "billable-usage", zoneIds: [], maxPageSize: 10_000, units: 1,
        availability: "available",
      }), start, NOW),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,error,updated_at)
         VALUES('workers-pending','billing-ready-job','graphql:workers',?1,?2,?3,'pending','missing',NULL,?3)`,
      ).bind(JSON.stringify({
        version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 90,
        availability: "available",
      }), start, NOW),
    ]);

    const readiness = (await initialIngestionProgress(testD1.db, "account-1")).readiness;
    expect(readiness.account).toBe("pending");
    expect(readiness.products.workers).toMatchObject({ state: "ready", percent: 0 });
    expect(readiness.products.images).toMatchObject({ state: "ready", percent: 100 });
    expect(readiness.products.r2).toMatchObject({ state: "ready", percent: 100 });
    expect(readiness.products.pages).toMatchObject({ state: "importing", percent: 0 });
  });

  it("keeps account history ready when Billing is terminally unavailable", async () => {
    testD1 = createTestD1();
    const start = NOW - DAY_MS;
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('billing-gap-job','account-1','initial_v2',?1,?2,'complete_with_gaps',?2,?2)`,
      ).bind(start, NOW),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,error,updated_at)
         VALUES('billing-gap','billing-gap-job','billing',?1,?2,?3,'complete','missing',NULL,?3)`,
      ).bind(JSON.stringify({
        version: 2, dataset: "billable-usage", zoneIds: [], maxPageSize: 10_000, units: 1,
        availability: "unavailable", expectedGap: true,
      }), start, NOW),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,error,updated_at)
         VALUES('account-history','billing-gap-job','graphql:workers',?1,?2,?3,'complete','complete',NULL,?3)`,
      ).bind(JSON.stringify({
        version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1,
        availability: "available",
      }), start, NOW),
    ]);

    const progress = await initialIngestionProgress(testD1.db, "account-1");
    expect(progress.readiness).toMatchObject({
      billing: "unavailable",
      account: "ready",
    });
    expect(progress.days).toMatchObject({ gaps: 0, failedWindows: 0, errors: [] });
  });

  it("reports the earliest candidate deadline across pacing and capacity waits", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 12);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('earliest-wait-job','account-1','initial_v2',?1,?2,'running',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('earliest-wait-slice','earliest-wait-job','graphql:workers',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1,
      }), now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "earliest-wait-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          capacityWaitUntil: now + 160_000,
          sharedNextAdmissionAt: now + 47_000,
          admissions: [],
        }), now),
    ]);

    expect((await initialIngestionProgress(testD1.db, "account-1")).job).toMatchObject({
      resumeAt: now + 47_000,
      waitReason: "pacing",
    });
  });

  it("paces physical Analytics requests through one shared account lane", async () => {
    vi.useFakeTimers();
    testD1 = createTestD1();
    const now = Date.UTC(2026, 7, 27, 12);
    vi.setSystemTime(now);
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('parallel-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
    ).bind(now - 7 * DAY_MS, now).run();
    await testD1.db.batch(Array.from({ length: 7 }, (_, index) => testD1!.db.prepare(
      `INSERT INTO backfill_slices(
         id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,next_eligible_at,coverage_status,error,updated_at
       ) VALUES(?1,'parallel-job','graphql:workers',?2,?3,?4,'pending',0,?5,'missing',NULL,?5)`,
    ).bind(`slice-${index}`, JSON.stringify({
      version: 2,
      dataset: "emailSendingAdaptiveGroups",
      zoneIds: [(index + 1).toString(16).padStart(32, "0")],
      maxPageSize: 10_000,
      units: 1,
    }), now - (index + 1) * DAY_MS, now - index * DAY_MS, now)));

    const requestTimes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestTimes.push(Date.now());
      const zones = (JSON.parse(String(init?.body)) as { variables: { zones: string[] } }).variables.zones;
      return Response.json({ data: { viewer: { accounts: [{ zones: zones.map(zoneTag => ({ zoneTag, emailSendingAdaptiveGroups: [] })) }] } } });
    }));

    const run = runInitialIngestion({ DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env, "parallel-job");
    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    expect(requestTimes).toHaveLength(7);
    expect(requestTimes.slice(1).every((time, index) => time - requestTimes[index]! >= 1_200)).toBe(true);
    const completed = await testD1.db.prepare(
      `SELECT COUNT(*) AS count FROM backfill_slices WHERE backfill_job_id='parallel-job' AND status='complete'`,
    ).first<{ count: number }>();
    expect(completed?.count).toBe(7);
  });

  it("shrinks later date-resource pages after the first slice discovers cardinality", async () => {
    vi.useFakeTimers();
    testD1 = createTestD1();
    const now = Date.UTC(2026, 7, 27, 13);
    vi.setSystemTime(now);
    const metadata = JSON.stringify({
      version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1,
    });
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('page-hint-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 2 * DAY_MS, now),
      ...[0, 1].map(index => testD1!.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES(?1,'page-hint-job','graphql:workers',?2,?3,?4,'pending','missing',?4)`,
      ).bind(`page-hint-${index}`, metadata, now - (index + 1) * DAY_MS, now - index * DAY_MS)),
    ]);
    const queries: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: { since: string } };
      queries.push(body.query);
      return Response.json({ data: {
        cost: 111,
        viewer: {
          budget: queries.length === 1 ? 33_000 : 32_800,
          accounts: [{ workersInvocationsAdaptive: [{
            dimensions: { date: body.variables.since.slice(0, 10), scriptName: "worker-a" },
            sum: { requests: 1, cpuTimeUs: 1 },
          }] }],
        },
      } });
    }));

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "page-hint-job",
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await run;

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("workersInvocationsAdaptive(limit: 10000,");
    expect(queries[1]).toContain("workersInvocationsAdaptive(limit: 11,");
  });

  it("paces repeated zone requests through the shared lane", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    const zoneId = "a".repeat(32);
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('zone-pace-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
    ).bind(now - 2 * DAY_MS, now).run();
    await testD1.db.batch(Array.from({ length: 2 }, (_, index) => testD1!.db.prepare(
      `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
       VALUES(?1,'zone-pace-job','graphql:email',?2,?3,?4,'pending','missing',?4)`,
    ).bind(`zone-pace-${index}`, JSON.stringify({
      version: 2, dataset: "emailSendingAdaptiveGroups", zoneIds: [zoneId], maxPageSize: 10_000, units: 1,
    }), now - (index + 1) * DAY_MS, now - index * DAY_MS)));
    const requestTimes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      requestTimes.push(Date.now());
      return Response.json({ data: { viewer: { accounts: [{ zones: [{ zoneTag: zoneId, emailSendingAdaptiveGroups: [] }] }] } } });
    }));

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "zone-pace-job",
    );

    expect(requestTimes).toHaveLength(2);
    expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(1_200);
  });

  it("persists account pacing across resumed importer instances", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    const metadata = JSON.stringify({
      version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1,
    });
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('persisted-pace-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 2 * DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('persisted-pace-1','persisted-pace-job','graphql:workers',?1,?2,?3,'pending','missing',?3)`,
      ).bind(metadata, now - DAY_MS, now),
    ]);
    const requestTimes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      requestTimes.push(Date.now());
      return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } });
    }));
    const env = { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env;

    await runInitialIngestion(env, "persisted-pace-job");
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('persisted-pace-2','persisted-pace-job','graphql:workers',?1,?2,?3,'pending','missing',?3)`,
      ).bind(metadata, now - 2 * DAY_MS, now - DAY_MS),
      testD1.db.prepare(`UPDATE backfill_jobs SET status='pending',updated_at=?2 WHERE id=?1`)
        .bind("persisted-pace-job", Date.now()),
    ]);
    await runInitialIngestion(env, "persisted-pace-job");

    expect(requestTimes).toHaveLength(2);
    expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(1_200);
  });

  it("requeues a persistence overflow before splitting it on a fresh-budget attempt", async () => {
    testD1 = createTestD1();
    const startsAt = Date.UTC(2026, 7, 1);
    const endsAt = startsAt + 2 * DAY_MS;
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('persistence-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(startsAt, endsAt),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,coverage_status,updated_at)
         VALUES('persistence-slice','persistence-job','graphql:workers',?1,?2,?3,'pending',0,'missing',?3)`,
      ).bind(JSON.stringify({
        version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 2,
      }), startsAt, endsAt),
    ]);
    const baseDb = testD1.db;
    const constrainedDb = {
      prepare: baseDb.prepare.bind(baseDb),
      async batch(statements: D1PreparedStatement[]) {
        const results = await baseDb.batch(statements);
        return results.map(result => ({
          ...result,
          meta: { ...result.meta, rows_read: 300_000 },
        }));
      },
    } as unknown as D1Database;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{
        dimensions: { date: "2026-08-01", scriptName: "worker" },
        sum: { requests: 1, cpuTimeUs: 1 },
      }] }] } },
    })));
    const env = { DB: constrainedDb, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env;

    await runInitialIngestion(env, "persistence-job");

    const deferred = await baseDb.prepare(
      `SELECT scope_key,status,retry_count FROM backfill_slices WHERE id='persistence-slice'`,
    ).first<{ scope_key: string; status: string; retry_count: number }>();
    expect(deferred?.status).toBe("pending");
    expect(deferred?.retry_count).toBe(0);
    expect((JSON.parse(deferred!.scope_key) as { persistenceRetry?: boolean }).persistenceRetry).toBe(true);

    await baseDb.prepare(
      `UPDATE backfill_slices SET next_eligible_at=?2 WHERE id=?1`,
    ).bind("persistence-slice", Date.now() - 1).run();
    await runInitialIngestion(env, "persistence-job");

    const slices = await baseDb.prepare(
      `SELECT status,starts_at,ends_at FROM backfill_slices WHERE backfill_job_id='persistence-job' ORDER BY starts_at`,
    ).all<{ status: string; starts_at: number; ends_at: number }>();
    expect(slices.results.filter(slice => slice.status === "pending")).toHaveLength(2);
    expect(slices.results.find(slice => slice.status === "superseded")).toMatchObject({ starts_at: startsAt, ends_at: endsAt });
  });

  it("does not start remote work inside the invocation wall-time reserve", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 18);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('wall-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 2 * DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('wall-slice','wall-job','graphql:workers',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 2,
      }), now - 2 * DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`).bind(
        "initial_ingestion_quota:account-1",
        JSON.stringify({
          jobId: "wall-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 33_000,
          reportedAt: now,
          reportedForRequestAt: now,
          observedCapacity: 33_144,
          sharedNextAdmissionAt: now + 44_000,
          admissions: [],
        }),
        now,
      ),
    ]);
    const fetchMock = vi.fn(async () => Response.json({ data: { viewer: { accounts: [{
      workersInvocationsAdaptive: [{
        dimensions: { date: "2026-08-26", scriptName: "worker" }, sum: { requests: 1, cpuTimeUs: 1 },
      }],
    }] } } }));
    vi.stubGlobal("fetch", fetchMock);

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "wall-job",
    );

    const slices = await testD1.db.prepare(
      `SELECT status,scope_key,next_eligible_at FROM backfill_slices WHERE backfill_job_id='wall-job'`,
    ).all<{ status: string; scope_key: string; next_eligible_at: number | null }>();
    expect(slices.results).toHaveLength(1);
    expect(slices.results[0]?.status).toBe("pending");
    expect(slices.results[0]?.next_eligible_at).toBeNull();
    expect(JSON.parse(slices.results[0]!.scope_key)).not.toHaveProperty("persistenceRetry");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("holds one D1 lease across overlapping import invocations", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('lease-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
    ).bind(now - DAY_MS, now).run();
    await testD1.db.prepare(
      `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
       VALUES('lease-slice','lease-job','graphql:workers',?1,?2,?3,'pending','missing',?3)`,
    ).bind(JSON.stringify({ version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1 }), now - DAY_MS, now).run();
    let releaseFetch!: () => void;
    const fetchStarted = new Promise<void>(resolve => {
      vi.stubGlobal("fetch", vi.fn(async () => {
        resolve();
        await new Promise<void>(done => { releaseFetch = done; });
        return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } });
      }));
    });

    const first = runInitialIngestion({ DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env, "lease-job");
    await fetchStarted;
    const second = runInitialIngestion({ DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env, "lease-job");
    releaseFetch();
    await Promise.all([first, second]);

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("recovers stale running slices after taking over the import lease", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('recovery-job','account-1','initial_v2',?1,?2,'running',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('stale-running','recovery-job','graphql:workers',?1,?2,?3,'running','missing',?3)`,
      ).bind(JSON.stringify({ version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1 }), now - DAY_MS, now),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } })));

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "recovery-job",
    );

    const slice = await testD1.db.prepare(`SELECT status FROM backfill_slices WHERE id='stale-running'`)
      .first<{ status: string }>();
    expect(slice?.status).toBe("complete");
  });

  it("releases claimed slices when a producer fails", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('producer-error-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
    ).bind(now - 2 * DAY_MS, now).run();
    const metadata = JSON.stringify({ version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1 });
    await testD1.db.batch(Array.from({ length: 2 }, (_, index) => testD1!.db.prepare(
      `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
       VALUES(?1,'producer-error-job','graphql:workers',?2,?3,?4,'pending','missing',?4)`,
    ).bind(`producer-error-${index}`, metadata, now - (index + 1) * DAY_MS, now - index * DAY_MS)));
    const baseDb = testD1.db;
    let claimReads = 0;
    const flakyDb = {
      prepare(sql: string) {
        if (sql.includes("FROM backfill_slices AS candidate") && ++claimReads === 2) throw new Error("claim failed");
        return baseDb.prepare(sql);
      },
      batch: baseDb.batch.bind(baseDb),
    } as unknown as D1Database;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } })));

    await expect(runInitialIngestion(
      { DB: flakyDb, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "producer-error-job",
    )).rejects.toThrow("claim failed");

    const running = await baseDb.prepare(
      `SELECT COUNT(*) AS count FROM backfill_slices WHERE backfill_job_id='producer-error-job' AND status='running'`,
    ).first<{ count: number }>();
    expect(running?.count).toBe(0);
  });

  it("stops an Analytics wave when remaining quota cannot admit its pending slice", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('admission-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('admission-slice','admission-job','graphql:email',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "emailSendingAdaptiveGroups",
        zoneIds: ["1".repeat(32), "2".repeat(32)],
        maxPageSize: 10_000,
        units: 2,
      }), now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          windowStartedAt: now, physicalUsed: 700, accountUsed: 0, zoneUsed: {},
        }), now),
    ]);
    const baseDb = testD1.db;
    let claimReads = 0;
    const countedDb = {
      prepare(sql: string) {
        if (sql.includes("SELECT * FROM backfill_slices")) claimReads += 1;
        return baseDb.prepare(sql);
      },
      batch: baseDb.batch.bind(baseDb),
    } as unknown as D1Database;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runInitialIngestion(
      { DB: countedDb, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "admission-job",
    );

    expect(claimReads).toBeLessThanOrEqual(7);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP 429", () => Response.json({ errors: [{ message: "too many requests" }] }, { status: 429 }), 0],
    ["GraphQL budget error", () => Response.json({ errors: [{ message: "query budget exceeded", extensions: { code: "budget" } }] }), 1],
  ])("defers a one-day %s with bounded retry accounting", async (_name, response, expectedRetries) => {
    testD1 = createTestD1();
    const now = Date.now();
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('rate-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,coverage_status,updated_at)
         VALUES('rate-slice','rate-job','graphql:workers',?1,?2,?3,'pending',0,'missing',?3)`,
      ).bind(JSON.stringify({
        version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1,
      }), now - DAY_MS, now),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => response()));

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "rate-job",
    );

    const slice = await testD1.db.prepare(
      `SELECT status,retry_count,next_eligible_at FROM backfill_slices WHERE id='rate-slice'`,
    ).first<{ status: string; retry_count: number; next_eligible_at: number | null }>();
    expect(slice?.status).toBe("pending");
    expect(slice?.retry_count).toBe(expectedRetries);
    expect(slice?.next_eligible_at).toBeGreaterThan(now);
  });

  it("moves an underestimated promoted detail to a fresh-window retry", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    const metadata = JSON.stringify({
      version: 2,
      dataset: "kvOperationsAdaptiveGroups",
      zoneIds: [],
      maxPageSize: 10_000,
      units: 1,
      priority: 2,
      detailCalibrationRequired: true,
    });
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('fresh-retry-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 24 * DAY_MS, now),
      ...Array.from({ length: 3 }, (_, index) => testD1!.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,coverage_status,updated_at)
         VALUES(?1,'fresh-retry-job','graphql:kv',?2,?3,?4,'pending',0,'missing',?4)`,
      ).bind(
        `fresh-retry-slice-${index}`,
        metadata,
        now - (index + 1) * DAY_MS,
        now - index * DAY_MS,
      )),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,coverage_status,updated_at)
         VALUES('fresh-retry-ordinary','fresh-retry-job','graphql:worker_builds',?1,?2,?3,'pending',0,'missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "workersBuildsBuildMinutesAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        units: 1,
        priority: 10,
      }), now - DAY_MS, now),
    ]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        errors: [{ message: "Rate limiter budget depleted. Please try again after 5 minutes.", extensions: { code: "budget" } }],
      }))
      .mockResolvedValue(Response.json({
        data: { cost: 111, viewer: { budget: 20_000, accounts: [{ workersBuildsBuildMinutesAdaptiveGroups: [] }] } },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "fresh-retry-job",
    );

    const rows = await testD1.db.prepare(
      `SELECT status,retry_count,scope_key,next_eligible_at FROM backfill_slices WHERE backfill_job_id='fresh-retry-job'`,
    ).all<{ status: string; retry_count: number; scope_key: string; next_eligible_at: number | null }>();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(rows.results).toHaveLength(4);
    const kvRows = rows.results.filter(row => JSON.parse(row.scope_key).dataset === "kvOperationsAdaptiveGroups");
    expect(kvRows.every(row => row.status === "pending")).toBe(true);
    expect(kvRows.map(row => row.retry_count).sort()).toEqual([0, 0, 1]);
    expect(kvRows.filter(row => row.next_eligible_at !== null)).toHaveLength(1);
    expect(kvRows.find(row => row.next_eligible_at !== null)?.next_eligible_at).toBeGreaterThan(now);
    expect(kvRows.every(row => {
      const parsed = JSON.parse(row.scope_key);
      return parsed.freshGraphqlBudgetRequired === true
        && parsed.detailCalibrationRequired === undefined
        && parsed.graphqlBudgetFailures === undefined;
    })).toBe(true);
    expect(rows.results.find(row => JSON.parse(row.scope_key).dataset === "workersBuildsBuildMinutesAdaptiveGroups")?.status)
      .toBe("complete");
    const quota = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    expect(JSON.parse(quota!.value).pausedUntil).toBeNull();
  });

  it("returns fresh-window siblings to measured pacing after one bounded success", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 18, 35);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    const metadata = JSON.stringify({
      version: 2,
      dataset: "imagesTransformationsAdaptiveGroups",
      zoneIds: [],
      maxPageSize: 10_000,
      units: 1,
      freshGraphqlBudgetRequired: true,
    });
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('measured-siblings-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 2 * DAY_MS, now),
      ...[0, 1].map(index => testD1!.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES(?1,'measured-siblings-job','graphql:images',?2,?3,?4,'pending','missing',?4)`,
      ).bind(`measured-sibling-${index}`, metadata, now - (index + 1) * DAY_MS, now - index * DAY_MS)),
    ]);
    const requestTimes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      requestTimes.push(Date.now());
      return Response.json({
        data: {
          cost: 111,
          viewer: {
            budget: requestTimes.length === 1 ? 33_000 : 32_889,
            accounts: [{ imagesTransformationsAdaptiveGroups: [] }],
          },
        },
      });
    }));

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "measured-siblings-job",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    expect(requestTimes).toHaveLength(2);
    expect(requestTimes[1]! - requestTimes[0]!).toBeLessThan(5_000);
    const slices = await testD1.db.prepare(
      `SELECT status,scope_key FROM backfill_slices WHERE backfill_job_id='measured-siblings-job'`,
    ).all<{ status: string; scope_key: string }>();
    expect(slices.results.every(slice => slice.status === "complete")).toBe(true);
  });

  it("does not let a fresh dataset reserve capacity while ordinary work remains", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 18, 40);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('fresh-wait-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      ...Array.from({ length: 101 }, (_, index) => testD1!.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES(?1,'fresh-wait-job','graphql:images',?2,?3,?4,'pending','missing',?4)`,
      ).bind(
        `fresh-wait-large-${index}`,
        JSON.stringify({
          version: 2,
          dataset: "imagesTransformationsAdaptiveGroups",
          zoneIds: [],
          maxPageSize: 10_000,
          units: 1,
          priority: 10,
          freshGraphqlBudgetRequired: true,
        }),
        now - (index + 1) * DAY_MS,
        now - index * DAY_MS,
      )),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('fresh-wait-small','fresh-wait-job','graphql:worker_builds',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "workersBuildsBuildMinutesAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        units: 1,
        priority: 11,
      }), now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "fresh-wait-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 1_000,
          reportedAt: now - 1_000,
          reportedForRequestAt: now - 1_000,
          observedCapacity: 33_000,
          observedMaxDebit: 9_500,
          observedCostMultiplier: 111,
          observedCosts: { "1": 111 },
          observedDebits: {
            imagesTransformationsAdaptiveGroups: 32_000,
            workersBuildsBuildMinutesAdaptiveGroups: 111,
          },
          admissions: [{
            admittedAt: now - 1_000,
            logicalQueries: 1,
            physicalRequests: 1,
            budgetDebit: 9_500,
            budgetKey: "previousDataset",
          }],
        }), now),
    ]);
    const fetchMock = vi.fn(async () => Response.json({
      data: { cost: 111, viewer: { budget: 800, accounts: [{ workersBuildsBuildMinutesAdaptiveGroups: [] }] } },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "fresh-wait-job",
    );
    await vi.advanceTimersByTimeAsync(55_000);
    await run;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = await testD1.db.prepare(
      `SELECT status,COUNT(*) AS count FROM backfill_slices
       WHERE backfill_job_id='fresh-wait-job' GROUP BY status ORDER BY status`,
    ).all<{ status: string; count: number }>();
    expect(rows.results).toEqual([
      { status: "complete", count: 1 },
      { status: "pending", count: 101 },
    ]);
    const small = await testD1.db.prepare(
      `SELECT status FROM backfill_slices WHERE id='fresh-wait-small'`,
    ).first<{ status: string }>();
    expect(small?.status).toBe("complete");
    const quota = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    const parsedQuota = JSON.parse(quota!.value);
    expect(parsedQuota.protectedHeadKey).toMatch(/^fresh-wait-large-/);
    expect(parsedQuota.protectedHeadAdmitAt).toBeGreaterThan(now + 4 * 60_000);
  });

  it("preserves the Workers budget reserve when a low-cost probe would consume it", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 18, 42);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('priority-wait-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('priority-workers','priority-wait-job','graphql:workers',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "workersInvocationsAdaptive",
        zoneIds: [],
        maxPageSize: 10_000,
        units: 1,
        priority: 1,
      }), now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('priority-images','priority-wait-job','graphql:worker_builds',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "workersBuildsBuildMinutesAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        units: 1,
        priority: 10,
      }), now - DAY_MS, now),
      ...Array.from({ length: 20 }, (_, index) => testD1!.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES(?1,'priority-wait-job','graphql:worker_builds',?2,?3,?4,'pending','missing',?4)`,
      ).bind(
        `priority-probe-${index}`,
        JSON.stringify({
          version: 2,
          dataset: "workersBuildsBuildMinutesAdaptiveGroups",
          zoneIds: [],
          maxPageSize: 10_000,
          pageSizeHint: 2,
          activityProbe: true,
          units: 1,
          priority: 10 + index,
        }),
        now - DAY_MS,
        now,
      )),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "priority-wait-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 2_000,
          reportedAt: now - 1_000,
          reportedForRequestAt: now - 1_000,
          observedCapacity: 33_000,
          observedMaxDebit: 9_500,
          observedCostMultiplier: 111,
          observedCosts: { "1": 111 },
          observedDebits: {
            workersInvocationsAdaptive: 9_500,
            workersBuildsBuildMinutesAdaptiveGroups: 111,
          },
          admissions: [{
            admittedAt: now - 50_000,
            logicalQueries: 1,
            physicalRequests: 1,
            budgetDebit: 9_500,
            budgetKey: "previousDataset",
          }],
        }), now),
    ]);
    const fetchMock = vi.fn(async () => Response.json({
      data: { cost: 111, viewer: { budget: 1_000, accounts: [{ workersBuildsBuildMinutesAdaptiveGroups: [] }] } },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "priority-wait-job",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await run;

    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await testD1.db.prepare(
      `SELECT status,COUNT(*) AS count FROM backfill_slices
       WHERE backfill_job_id='priority-wait-job' GROUP BY status`,
    ).all<{ status: string; count: number }>();
    expect(rows.results).toEqual([{ status: "pending", count: 22 }]);
    const quota = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    expect(JSON.parse(quota!.value)).toMatchObject({
      protectedHeadKey: "priority-workers",
      protectedHeadDebit: 10_450,
      protectedHeadLogicalQueries: 1,
    });

    await vi.advanceTimersByTimeAsync(300_001);
    const resumed = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "priority-wait-job",
    );
    await vi.advanceTimersByTimeAsync(55_001);
    await resumed;

    expect(fetchMock).toHaveBeenCalled();
    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { query?: string };
    expect(firstRequest.query).toContain("workersInvocationsAdaptive");
  });

  it("uses residual capacity inside a frozen priority gap without moving its deadline", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 18, 43);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    const protectedAt = now + 120_000;
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('priority-gap-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('priority-gap-workers','priority-gap-job','graphql:workers',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "workersInvocationsAdaptive",
        zoneIds: [],
        maxPageSize: 10_000,
        units: 1,
        priority: 1,
      }), now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('priority-gap-probe','priority-gap-job','graphql:worker_builds',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "workersBuildsBuildMinutesAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        pageSizeHint: 2,
        activityProbe: true,
        units: 1,
        priority: 10,
      }), now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "priority-gap-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 20_000,
          reportedAt: now - 1_000,
          reportedForRequestAt: now - 1_000,
          observedCapacity: 33_000,
          observedMaxDebit: 9_500,
          observedCostMultiplier: 111,
          observedCosts: { "1": 111 },
          observedDebits: {
            workersInvocationsAdaptive: 9_500,
            workersBuildsBuildMinutesAdaptiveGroups: 111,
          },
          admissions: [{
            admittedAt: now - 50_000,
            logicalQueries: 1,
            physicalRequests: 1,
            budgetDebit: 9_500,
            budgetKey: "previousDataset",
          }],
          protectedHeadKey: "priority-gap-workers",
          protectedHeadAdmitAt: protectedAt,
          protectedHeadDebit: 9_500,
          protectedHeadLogicalQueries: 1,
        }), now),
    ]);
    const fetchMock = vi.fn(async () => Response.json({
      data: { cost: 111, viewer: { budget: 19_889, accounts: [{ workersBuildsBuildMinutesAdaptiveGroups: [] }] } },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "priority-gap-job",
    );
    await vi.advanceTimersByTimeAsync(55_001);
    await run;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await testD1.db.prepare(
      `SELECT status FROM backfill_slices WHERE id='priority-gap-probe'`,
    ).first()).toMatchObject({ status: "complete" });
    const quota = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    expect(JSON.parse(quota!.value)).toMatchObject({
      protectedHeadKey: "priority-gap-workers",
      protectedHeadAdmitAt: protectedAt,
    });
  });

  it("keeps a protected reservation while its slice is retry-deferred", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 18, 44);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    const deferredUntil = now + 120_000;
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('deferred-head-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,next_eligible_at,coverage_status,updated_at)
         VALUES('deferred-workers','deferred-head-job','graphql:workers',?1,?2,?3,'pending',?4,'missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "workersInvocationsAdaptive",
        zoneIds: [],
        maxPageSize: 10_000,
        units: 1,
        priority: 1,
      }), now - DAY_MS, now, deferredUntil),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('deferred-probe','deferred-head-job','graphql:worker_builds',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "workersBuildsBuildMinutesAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        pageSizeHint: 2,
        activityProbe: true,
        units: 1,
        priority: 10,
      }), now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "deferred-head-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 2_000,
          reportedAt: now,
          reportedForRequestAt: now,
          observedCapacity: 33_000,
          observedMaxDebit: 9_500,
          observedCostMultiplier: 111,
          observedCosts: { "1": 111 },
          observedDebits: {
            workersInvocationsAdaptive: 9_500,
            workersBuildsBuildMinutesAdaptiveGroups: 111,
          },
          admissions: [],
        }), now),
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "deferred-head-job",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    const quota = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    expect(JSON.parse(quota!.value)).toMatchObject({
      protectedHeadKey: "deferred-workers",
      protectedHeadAdmitAt: deferredUntil,
      protectedHeadDebit: 10_450,
    });
  });

  it("splits a query that exhausts a fresh GraphQL budget", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    const metadata = JSON.stringify({
      version: 2, dataset: "imagesTransformationsAdaptiveGroups", zoneIds: [], maxPageSize: 10_000, units: 31,
      freshGraphqlBudgetRequired: true,
    });
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('oversized-query-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 31 * DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,coverage_status,updated_at)
         VALUES('oversized-query-slice','oversized-query-job','graphql:images',?1,?2,?3,'pending',0,'missing',?3)`,
      ).bind(metadata, now - 31 * DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,next_eligible_at,coverage_status,updated_at)
         VALUES('oversized-query-peer','oversized-query-job','graphql:images-peer',?1,?2,?3,'pending',0,?4,'missing',?3)`,
      ).bind(metadata, now - 31 * DAY_MS, now, now + 60_000),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      errors: [{ message: "Rate limiter budget depleted. Please try again after 5 minutes.", extensions: { code: "budget" } }],
    })));

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "oversized-query-job",
    );

    const rows = await testD1.db.prepare(
      `SELECT status,retry_count,starts_at,ends_at,scope_key FROM backfill_slices
       WHERE backfill_job_id='oversized-query-job' ORDER BY starts_at`,
    ).all<{ status: string; retry_count: number; starts_at: number; ends_at: number; scope_key: string }>();
    expect(rows.results).toHaveLength(10);
    expect(rows.results.filter(row => row.status === "superseded")).toHaveLength(2);
    expect(rows.results.filter(row => row.status === "pending").map(row => row.retry_count)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(rows.results.filter(row => row.status === "pending").map(row => JSON.parse(row.scope_key).graphqlBudgetFailures))
      .toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(rows.results.filter(row => row.status === "pending").every(row => JSON.parse(row.scope_key).freshGraphqlBudgetRequired === true))
      .toBe(true);
    expect(rows.results.filter(row => row.status === "pending").reduce(
      (days, row) => days + Math.ceil((row.ends_at - row.starts_at) / DAY_MS),
      0,
    )).toBe(62);
  });

  it("splits the current range without terminalizing its same-dataset sibling", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    const failedMetadata = JSON.stringify({
      version: 2,
      dataset: "imagesTransformationsAdaptiveGroups",
      zoneIds: [],
      maxPageSize: 10_000,
      units: 4,
      graphqlBudgetFailures: 3,
      freshGraphqlBudgetRequired: true,
    });
    const siblingMetadata = JSON.stringify({
      version: 2,
      dataset: "imagesTransformationsAdaptiveGroups",
      zoneIds: [],
      maxPageSize: 10_000,
      units: 2,
      graphqlBudgetFailures: 3,
      freshGraphqlBudgetRequired: true,
    });
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('budget-circuit-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 6 * DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,coverage_status,updated_at)
         VALUES('budget-circuit-current','budget-circuit-job','graphql:images',?1,?2,?3,'pending',0,'missing',?3)`,
      ).bind(failedMetadata, now - 4 * DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,next_eligible_at,coverage_status,updated_at)
         VALUES('budget-circuit-sibling','budget-circuit-job','graphql:images',?1,?2,?3,'pending',0,?4,'missing',?3)`,
      ).bind(siblingMetadata, now - 6 * DAY_MS, now - 4 * DAY_MS, now + 60_000),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,next_eligible_at,coverage_status,updated_at)
         VALUES('budget-circuit-other','budget-circuit-job','graphql:workers',?1,?2,?3,'pending',0,?4,'missing',?3)`,
      ).bind(JSON.stringify({
        version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1,
      }), now - DAY_MS, now, now + 60_000),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      errors: [{ message: "Rate limiter budget depleted. Please try again after 5 minutes.", extensions: { code: "budget" } }],
    })));

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "budget-circuit-job",
    );

    const rows = await testD1.db.prepare(
      `SELECT id,status,scope_key FROM backfill_slices WHERE backfill_job_id='budget-circuit-job' ORDER BY id`,
    ).all<{ id: string; status: string; scope_key: string }>();
    expect(rows.results.find(row => row.id === "budget-circuit-current")?.status).toBe("superseded");
    expect(rows.results.find(row => row.id === "budget-circuit-sibling")?.status).toBe("pending");
    expect(rows.results.find(row => row.id === "budget-circuit-other")?.status).toBe("pending");
    const children = rows.results.filter(row => !row.id.startsWith("budget-circuit-"));
    expect(children).toHaveLength(2);
    expect(children.every(row => row.status === "pending")).toBe(true);
    expect(children.every(row => JSON.parse(row.scope_key).graphqlBudgetFailures === undefined)).toBe(true);
    expect(children.every(row => JSON.parse(row.scope_key).freshGraphqlBudgetRequired === true)).toBe(true);
  });

  it("splits legacy grouped zones before reducing their date range", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    const zoneIds = ["1".repeat(32), "2".repeat(32), "3".repeat(32), "4".repeat(32)];
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('zone-shape-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 4 * DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,coverage_status,updated_at)
         VALUES('zone-shape-current','zone-shape-job','graphql:email',?1,?2,?3,'pending',0,'missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "emailSendingAdaptiveGroups",
        zoneIds,
        maxPageSize: 10_000,
        units: 16,
        freshGraphqlBudgetRequired: true,
      }), now - 4 * DAY_MS, now),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      errors: [{ message: "Rate limiter budget depleted. Please try again after 5 minutes.", extensions: { code: "budget" } }],
    })));

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "zone-shape-job",
    );

    const rows = await testD1.db.prepare(
      `SELECT status,starts_at,ends_at,scope_key FROM backfill_slices
       WHERE backfill_job_id='zone-shape-job' ORDER BY status`,
    ).all<{ status: string; starts_at: number; ends_at: number; scope_key: string }>();
    const children = rows.results.filter(row => row.status === "pending");
    expect(children).toHaveLength(2);
    expect(children.map(row => JSON.parse(row.scope_key).zoneIds.length)).toEqual([2, 2]);
    expect(children.reduce((sum, row) => sum + JSON.parse(row.scope_key).units, 0)).toBe(16);
    expect(children.every(row => row.starts_at === now - 4 * DAY_MS && row.ends_at === now)).toBe(true);
    expect(children.every(row => JSON.parse(row.scope_key).graphqlBudgetFailures === undefined)).toBe(true);
  });

  it("terminalizes every remaining slice when one day exceeds a fresh budget", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    const metadata = JSON.stringify({
      version: 2,
      dataset: "imagesTransformationsAdaptiveGroups",
      zoneIds: [],
      maxPageSize: 2,
      units: 1,
      freshGraphqlBudgetRequired: true,
    });
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('smallest-shape-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 2 * DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,coverage_status,updated_at)
         VALUES('smallest-current','smallest-shape-job','graphql:images',?1,?2,?3,'pending',1,'missing',?3)`,
      ).bind(metadata, now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,next_eligible_at,coverage_status,updated_at)
         VALUES('smallest-sibling','smallest-shape-job','graphql:images',?1,?2,?3,'pending',0,?4,'missing',?3)`,
      ).bind(metadata, now - 2 * DAY_MS, now - DAY_MS, now + 60_000),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      errors: [{ message: "Rate limiter budget depleted. Please try again after 5 minutes.", extensions: { code: "budget" } }],
    })));

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "smallest-shape-job",
    );

    const rows = await testD1.db.prepare(
      `SELECT id,status,scope_key FROM backfill_slices WHERE backfill_job_id='smallest-shape-job' ORDER BY id`,
    ).all<{ id: string; status: string; scope_key: string }>();
    expect(rows.results).toEqual([
      { id: "smallest-current", status: "failed", scope_key: expect.any(String) },
      { id: "smallest-sibling", status: "failed", scope_key: expect.any(String) },
    ]);
    expect(JSON.parse(rows.results[1]!.scope_key)).toMatchObject({ availability: "unavailable", terminalGap: true });
    const coverage = await testD1.db.prepare(
      `SELECT starts_at,ends_at,state FROM coverage_intervals WHERE dataset='imagesTransformationsAdaptiveGroups'`,
    ).all<{ starts_at: number; ends_at: number; state: string }>();
    expect(coverage.results).toHaveLength(2);
    expect(coverage.results.every(row => row.state === "unavailable")).toBe(true);
    expect(Math.min(...coverage.results.map(row => row.starts_at))).toBe(now - 2 * DAY_MS);
    expect(Math.max(...coverage.results.map(row => row.ends_at))).toBe(now);
    expect(await testD1.db.prepare(`SELECT status FROM backfill_jobs WHERE id='smallest-shape-job'`).first())
      .toMatchObject({ status: "complete_with_gaps" });
    expect(await initialIngestionSchedulingState(testD1.db, "account-1")).toEqual({
      importActive: false,
      onboardingComplete: false,
    });
  });

  it("terminalizes the job before optional coverage writes exhaust their budget", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('terminal-budget-job','account-1','initial_v2',?1,?2,'running',?2,?2)`,
    ).bind(now - 30 * DAY_MS, now).run();
    const metadata = JSON.stringify({
      version: 2,
      dataset: "imagesTransformationsAdaptiveGroups",
      zoneIds: [],
      maxPageSize: 2,
      units: 1,
    });
    await testD1.db.batch(Array.from({ length: 30 }, (_, index) => testD1!.db.prepare(
      `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
       VALUES(?1,'terminal-budget-job','graphql:images',?2,?3,?4,'pending','missing',?4)`,
    ).bind(`terminal-budget-${index}`, metadata, now - (index + 1) * DAY_MS, now - index * DAY_MS)));
    const exhausted = new LedgerRunBudget({
      graphqlQueries: 1,
      restRequests: 1,
      d1RowsRead: 1,
      d1RowsWritten: 1,
      pagesPerDataset: 1,
      resourcesPerTransaction: 1,
      retries: 1,
      backfillSlices: 1,
      wallMs: 1_000,
    });

    await terminateInitialDatasetSlices(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1" } as Env,
      "terminal-budget-job",
      "imagesTransformationsAdaptiveGroups",
      "single-day query exceeded Cloudflare's budget",
      exhausted,
    );

    expect(await testD1.db.prepare(`SELECT status FROM backfill_jobs WHERE id='terminal-budget-job'`).first())
      .toMatchObject({ status: "complete_with_gaps" });
    expect(await initialIngestionSchedulingState(testD1.db, "account-1")).toMatchObject({ importActive: false });
    expect(await testD1.db.prepare(
      `SELECT COUNT(*) AS count FROM backfill_slices WHERE backfill_job_id='terminal-budget-job' AND status='failed'`,
    ).first()).toMatchObject({ count: 30 });
  });

  it("persists a Retry-After pause longer than the normal five-minute window", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('long-pause-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,coverage_status,updated_at)
         VALUES('long-pause-slice','long-pause-job','graphql:workers',?1,?2,?3,'pending',0,'missing',?3)`,
      ).bind(JSON.stringify({
        version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1,
      }), now - DAY_MS, now),
    ]);
    const fetchMock = vi.fn(async () => Response.json(
      { errors: [{ message: "too many requests" }] },
      { status: 429, headers: { "retry-after": "600" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const env = { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env;

    await runInitialIngestion(env, "long-pause-job");
    await runInitialIngestion(env, "long-pause-job");
    const stored = await testD1.db.prepare(`SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`)
      .first<{ value: string }>();
    const state = JSON.parse(stored!.value) as { jobId?: string; limiterMode?: string; pausedUntil?: number; sharedUsed?: number };

    expect(state.pausedUntil).toBeGreaterThan(now + 9 * 60_000);
    expect(state).toMatchObject({ jobId: "long-pause-job", limiterMode: "shared-fallback", sharedUsed: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("restores the normal paced lane after generic budget recovery", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 16);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('fallback-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
    ).bind(now - 3 * DAY_MS, now).run();
    await testD1.db.batch([0, 1, 2].map(index => testD1!.db.prepare(
      `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
       VALUES(?1,'fallback-job','graphql:workers',?2,?3,?4,'pending','missing',?4)`,
    ).bind(
      `fallback-${index}`,
      JSON.stringify({ version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1 }),
      now - (index + 1) * DAY_MS,
      now - index * DAY_MS,
    )));
    const limitedFetch = vi.fn(async () => Response.json({
      errors: [{ message: "Rate limiter budget depleted. Please try again after 5 minutes.", extensions: { code: "budget" } }],
    }, { status: 429 }));
    vi.stubGlobal("fetch", limitedFetch);
    const env = { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env;

    await runInitialIngestion(env, "fallback-job");
    await runInitialIngestion(env, "fallback-job");
    expect(limitedFetch).toHaveBeenCalledTimes(1);
    expect((await initialIngestionProgress(testD1.db, "account-1")).job).toMatchObject({
      limiterMode: "shared-fallback",
      resumeAt: now + 5 * 60_000,
      sharedQueryLimit: 60,
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    const admissions: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      admissions.push(Date.now());
      return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } });
    }));
    const resumed = runInitialIngestion(env, "fallback-job");
    await vi.advanceTimersByTimeAsync(10_000);
    await resumed;

    expect(admissions).toHaveLength(3);
    expect(admissions[1]! - admissions[0]!).toBeGreaterThanOrEqual(1_200);
    expect(admissions[2]! - admissions[1]!).toBeGreaterThanOrEqual(1_200);
    const stored = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    expect(JSON.parse(stored!.value)).toMatchObject({
      jobId: "fallback-job",
      limiterMode: "shared-paced",
      sharedUsed: 3,
    });
  });

  it("continues other zones after a named zone limiter pauses one scope", async () => {
    vi.useFakeTimers();
    testD1 = createTestD1();
    const now = Date.UTC(2026, 7, 27, 16);
    vi.setSystemTime(now);
    const limitedZone = "a".repeat(32);
    const healthyZone = "b".repeat(32);
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('named-limit-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
    ).bind(now - DAY_MS, now).run();
    await testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`).bind(
      "initial_ingestion_quota:account-1",
      JSON.stringify({
        jobId: "named-limit-job",
        limiterMode: "shared-paced",
        windowStartedAt: now - 299_000,
        physicalUsed: 0,
        sharedUsed: 0,
        accountUsed: 0,
        zoneUsed: {},
      }),
      now,
    ).run();
    await testD1.db.batch([limitedZone, healthyZone].map(zoneId => testD1!.db.prepare(
      `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
       VALUES(?1,'named-limit-job','graphql:email',?2,?3,?4,'pending','missing',?4)`,
    ).bind(`slice-${zoneId}`, JSON.stringify({
      version: 2, dataset: "emailSendingAdaptiveGroups", zoneIds: [zoneId], maxPageSize: 10_000, units: 1,
    }), now - DAY_MS, now)));
    let limitedCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { zones?: string[] } };
      const zoneId = body.variables?.zones?.[0];
      if (zoneId === limitedZone) {
        limitedCalls += 1;
        return Response.json({
          errors: [{ message: `Zone ${limitedZone} has exceeded its rate limit. Please try again after 5 minutes.`, extensions: { code: "budget" } }],
        }, { status: 429 });
      }
      return Response.json({ data: { viewer: { accounts: [{ zones: [{ zoneTag: healthyZone, emailSendingAdaptiveGroups: [] }] }] } } });
    }));

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "named-limit-job",
    );
    await vi.advanceTimersByTimeAsync(56_000);
    await run;

    const slices = await testD1.db.prepare(
      `SELECT id,status FROM backfill_slices WHERE backfill_job_id='named-limit-job' ORDER BY id`,
    ).all<{ id: string; status: string }>();
    expect(slices.results).toEqual([
      { id: `slice-${limitedZone}`, status: "pending" },
      { id: `slice-${healthyZone}`, status: "complete" },
    ]);
    expect(limitedCalls).toBe(1);
    const quota = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    expect(JSON.parse(quota!.value)).toMatchObject({
      jobId: "named-limit-job",
      limiterMode: "shared-paced",
      zonePausedUntil: { [limitedZone]: expect.any(Number) },
    });
    await testD1.db.prepare(
      `UPDATE backfill_slices SET next_eligible_at=?2 WHERE id=?1`,
    ).bind(`slice-${limitedZone}`, Date.now()).run();
    const pausedRun = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "named-limit-job",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await pausedRun;
    expect(limitedCalls).toBe(1);
  });

  it("holds account and zone work when the shared query budget is full", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    const zoneId = "a".repeat(32);
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('scoped-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('account-slice','scoped-job','graphql:workers',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({ version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1 }), now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('zone-slice','scoped-job','graphql:email',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({ version: 2, dataset: "emailSendingAdaptiveGroups", zoneIds: [zoneId], maxPageSize: 10_000, units: 1 }), now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "scoped-job", accounting: "logical_queries", limiterMode: "shared-paced", windowStartedAt: now,
          physicalUsed: 0, sharedUsed: 300, accountUsed: 0, zoneUsed: {},
        }), now),
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "scoped-job",
    );

    const rows = await testD1.db.prepare(
      `SELECT id,status FROM backfill_slices WHERE backfill_job_id='scoped-job' ORDER BY id`,
    ).all<{ id: string; status: string }>();
    expect(rows.results).toEqual([
      { id: "account-slice", status: "pending" },
      { id: "zone-slice", status: "pending" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts one query unit for each single-dataset request across resumed runs", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('quota-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('quota-slice','quota-job','graphql:workers',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({ version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1 }), now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`,
      ).bind("initial_ingestion_quota:account-1", JSON.stringify({
        jobId: "quota-job", limiterMode: "shared-paced", windowStartedAt: now,
        physicalUsed: 39, sharedUsed: 199, accountUsed: 199, zoneUsed: {},
      }), now),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } })));

    await runInitialIngestion({ DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env, "quota-job");

    const quota = await testD1.db.prepare("SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'").first<{ value: string }>();
    expect(JSON.parse(quota!.value)).toMatchObject({ windowStartedAt: now, physicalUsed: 40, sharedUsed: 40, accountUsed: 40 });
  });

  it("persists a metric-specific terminal gap when a successful response omits a requested field", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('field-gap-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('field-gap-slice','field-gap-job','graphql:d1',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "d1AnalyticsAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        availableFields: ["dimensions_date", "dimensions_databaseId", "sum_rowsRead", "sum_rowsWritten"],
        units: 1,
      }), now - DAY_MS, now),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { viewer: { accounts: [{
      d1AnalyticsAdaptiveGroups: [{
        dimensions: { date: new Date(now - DAY_MS).toISOString().slice(0, 10), databaseId: "database-1" },
        sum: { rowsRead: 10 },
      }],
    }] } } })));

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "field-gap-job",
    );

    const row = await testD1.db.prepare(
      `SELECT status,coverage_status,error,scope_key FROM backfill_slices WHERE id='field-gap-slice'`,
    ).first<{ status: string; coverage_status: string; error: string | null; scope_key: string }>();
    expect(row).toMatchObject({
      status: "complete",
      coverage_status: "partial",
      error: expect.stringContaining("rows_written"),
    });
    expect(JSON.parse(row!.scope_key)).toMatchObject({ terminalGap: true, unavailableMetrics: ["rows_written"] });
  });

  it("releases query usage as admissions leave the rolling five-minute window", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 18);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    const metadata = JSON.stringify({
      version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1,
    });
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('rollover-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 2 * DAY_MS, now),
      ...[0, 1].map(index => testD1!.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES(?1,'rollover-job','graphql:workers',?2,?3,?4,'pending','missing',?4)`,
      ).bind(`rollover-${index}`, metadata, now - (index + 1) * DAY_MS, now - index * DAY_MS)),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "rollover-job", accounting: "logical_queries", limiterMode: "shared-paced", windowStartedAt: now - 299_000,
          physicalUsed: 39, sharedUsed: 199, accountUsed: 199, zoneUsed: {},
        }), now),
    ]);
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (++calls === 1) vi.setSystemTime(now + 2_000);
      return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } });
    }));

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "rollover-job",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    const quota = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    expect(JSON.parse(quota!.value)).toMatchObject({
      windowStartedAt: now,
      physicalUsed: 2,
      sharedUsed: 2,
      accountUsed: 2,
    });
  });

  it("admits work as soon as the final reported-budget admission expires", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 18, 30);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    const metadata = JSON.stringify({
      version: 2, dataset: "workersBuildsBuildMinutesAdaptiveGroups", zoneIds: [], maxPageSize: 10_000, units: 1,
    });
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('expired-admission-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('expired-admission-slice','expired-admission-job','graphql:worker_builds',?1,?2,?3,'pending','missing',?3)`,
      ).bind(metadata, now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "expired-admission-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 1_000,
          reportedAt: now - 1_000,
          reportedForRequestAt: now - 1_000,
          observedCapacity: 33_000,
          observedMaxDebit: 9_500,
          observedCostMultiplier: 111,
          observedCosts: { "1": 111 },
          observedDebits: {},
          admissions: [{
            admittedAt: now - 300_001,
            logicalQueries: 1,
            physicalRequests: 1,
            budgetDebit: 1_000,
            budgetKey: "priorDataset",
          }],
        }), now),
    ]);
    const fetchMock = vi.fn(async () => Response.json({
      data: {
        cost: 111,
        viewer: { budget: 30_000, accounts: [{ workersBuildsBuildMinutesAdaptiveGroups: [] }] },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "expired-admission-job",
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const slice = await testD1.db.prepare(
      `SELECT status FROM backfill_slices WHERE id='expired-admission-slice'`,
    ).first<{ status: string }>();
    expect(slice?.status).toBe("complete");
  });

  it("uses a bounded page shape to admit a small unseen dataset", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 18, 45);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    const metadata = JSON.stringify({
      version: 2, dataset: "workersBuildsBuildMinutesAdaptiveGroups", zoneIds: [], maxPageSize: 10_000, units: 1,
    });
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('small-page-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('small-page-slice','small-page-job','graphql:worker_builds',?1,?2,?3,'pending','missing',?3)`,
      ).bind(metadata, now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "small-page-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 1_000,
          reportedAt: now - 1_000,
          reportedForRequestAt: now - 1_000,
          observedCapacity: 33_000,
          observedMaxDebit: 9_500,
          observedCostMultiplier: 111,
          observedCosts: { "1": 111 },
          observedDebits: {},
          admissions: [{
            admittedAt: now - 1_000,
            logicalQueries: 1,
            physicalRequests: 1,
            budgetDebit: 9_500,
            budgetKey: "largeDataset",
          }],
        }), now),
    ]);
    const fetchMock = vi.fn(async () => Response.json({
      data: {
        cost: 111,
        viewer: { budget: 800, accounts: [{ workersBuildsBuildMinutesAdaptiveGroups: [] }] },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "small-page-job",
    );
    await vi.advanceTimersByTimeAsync(55_000);
    await run;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const slice = await testD1.db.prepare(
      `SELECT status FROM backfill_slices WHERE id='small-page-slice'`,
    ).first<{ status: string }>();
    expect(slice?.status).toBe("complete");
  });

  it("reserves the observed maximum debit for an unseen full-page query", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 18, 46);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('unseen-full-page-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('unseen-full-page-slice','unseen-full-page-job','graphql:queues',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "queueMessageOperationsAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        pageSizeHint: 10_000,
        units: 1,
      }), now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "unseen-full-page-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 1_500,
          reportedAt: now,
          reportedForRequestAt: now,
          observedCapacity: 33_000,
          observedMaxCost: 830,
          observedMaxDebit: 2_265,
          observedCostMultiplier: 111,
          observedCosts: { "1": 111 },
          observedDebits: {},
          admissions: [],
        }), now),
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "unseen-full-page-job",
    );
    await vi.advanceTimersByTimeAsync(55_000);
    await run;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await testD1.db.prepare(`SELECT status FROM backfill_slices WHERE id='unseen-full-page-slice'`).first())
      .toMatchObject({ status: "pending" });
  });

  it("admits an unseen dataset after unrelated debits leave the window", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 18, 47);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    const observedDebits = Object.fromEntries([
      ["largest", 9_500],
      ["second", 5_000],
      ...Array.from({ length: 11 }, (_, index) => [`small-${index}`, 1_000] as const),
    ]);
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('p90-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('p90-slice','p90-job','graphql:queues',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "queueMessageOperationsAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        units: 1,
        priority: 10,
      }), now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "p90-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 7_000,
          reportedAt: now - 1_000,
          reportedForRequestAt: now - 1_000,
          observedCapacity: 33_000,
          observedMaxDebit: 9_500,
          observedCostMultiplier: 111,
          observedCosts: { "1": 111 },
          observedDebits,
          admissions: [{
            admittedAt: now - 1_000,
            logicalQueries: 1,
            physicalRequests: 1,
            budgetDebit: 9_500,
            budgetKey: "previousDataset",
          }],
        }), now),
    ]);
    const fetchMock = vi.fn(async () => Response.json({
      data: { cost: 111, viewer: { budget: 6_000, accounts: [{ queueMessageOperationsAdaptiveGroups: [] }] } },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "p90-job",
    );
    await vi.advanceTimersByTimeAsync(300_001);
    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "p90-job",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const slice = await testD1.db.prepare(`SELECT status FROM backfill_slices WHERE id='p90-slice'`)
      .first<{ status: string }>();
    expect(slice?.status).toBe("complete");
  });

  it("admits a zone batch with its exact logical query count", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 18, 48);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    const zoneIds = Array.from({ length: 10 }, (_, index) => (index + 1).toString(16).padStart(32, "0"));
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('zone-admission-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('zone-admission-slice','zone-admission-job','graphql:email',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "emailSendingAdaptiveGroups",
        zoneIds,
        maxPageSize: 10_000,
        units: 10,
        priority: 10,
      }), now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "zone-admission-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 500,
          reportedAt: now - 1_000,
          reportedForRequestAt: now - 1_000,
          observedCapacity: 33_000,
          observedMaxDebit: 9_500,
          observedCostMultiplier: 111,
          observedCosts: { "1": 111 },
          observedDebits: { emailSendingAdaptiveGroups: 500 },
          observedDebitRates: { emailSendingAdaptiveGroups: 0.05 },
          admissions: [{
            admittedAt: now - 1_000,
            logicalQueries: 1,
            physicalRequests: 1,
            budgetDebit: 9_500,
            budgetKey: "previousDataset",
          }],
        }), now),
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "zone-admission-job",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    const slice = await testD1.db.prepare(`SELECT status FROM backfill_slices WHERE id='zone-admission-slice'`)
      .first<{ status: string }>();
    expect(slice?.status).toBe("pending");
  });

  it("fills residual quota with a bounded query beyond the first twenty priorities", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 18, 50);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    const largeMetadata = JSON.stringify({
      version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1, priority: 10,
    });
    const smallMetadata = JSON.stringify({
      version: 2, dataset: "workersBuildsBuildMinutesAdaptiveGroups", zoneIds: [], maxPageSize: 10_000, units: 1, priority: 99,
    });
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('fit-scan-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      ...Array.from({ length: 25 }, (_, index) => testD1!.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES(?1,'fit-scan-job','graphql:workers',?2,?3,?4,'pending','missing',?4)`,
      ).bind(
        `fit-large-${index}`,
        JSON.stringify({ ...JSON.parse(largeMetadata), testIndex: index }),
        now - DAY_MS,
        now,
      )),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('fit-small','fit-scan-job','graphql:worker_builds',?1,?2,?3,'pending','missing',?3)`,
      ).bind(smallMetadata, now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "fit-scan-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 1_000,
          reportedAt: now - 1_000,
          reportedForRequestAt: now - 1_000,
          observedCapacity: 33_000,
          observedMaxDebit: 9_500,
          observedCostMultiplier: 111,
          observedCosts: { "1": 111 },
          observedDebits: {},
          admissions: [{
            admittedAt: now - 1_000,
            logicalQueries: 1,
            physicalRequests: 1,
            budgetDebit: 9_500,
            budgetKey: "largeDataset",
          }],
        }), now),
    ]);
    const fetchMock = vi.fn(async () => Response.json({
      data: { cost: 111, viewer: { budget: 800, accounts: [{ workersBuildsBuildMinutesAdaptiveGroups: [] }] } },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "fit-scan-job",
    );
    await vi.advanceTimersByTimeAsync(55_000);
    await run;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const small = await testD1.db.prepare(`SELECT status FROM backfill_slices WHERE id='fit-small'`)
      .first<{ status: string }>();
    expect(small?.status).toBe("complete");
  });

  it("paces pending work from Cloudflare's reported GraphQL budget debits", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 19);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    const metadata = JSON.stringify({
      version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1,
    });
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('reported-budget-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 3 * DAY_MS, now),
      ...[0, 1].map(index => testD1!.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES(?1,'reported-budget-job','graphql:workers',?2,?3,?4,'pending','missing',?4)`,
      ).bind(`reported-budget-${index}`, metadata, now - (index + 1) * DAY_MS, now - index * DAY_MS)),
    ]);
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: {
        cost: 111,
        viewer: {
          budget: ++calls === 1 ? 33_300 : 15_000,
          accounts: [{ workersInvocationsAdaptive: [] }],
        },
      },
    })));

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "reported-budget-job",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('reported-budget-2','reported-budget-job','graphql:workers',?1,?2,?3,'pending','missing',?3)`,
      ).bind(metadata, now - 3 * DAY_MS, now - 2 * DAY_MS),
      testD1.db.prepare(`UPDATE backfill_jobs SET status='running',updated_at=?2 WHERE id=?1`)
        .bind("reported-budget-job", Date.now()),
    ]);
    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "reported-budget-job",
    );

    const stored = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    const quota = JSON.parse(stored!.value) as {
      observedMaxDebit: number;
      observedDebits: Record<string, number>;
      capacityWaitUntil: number;
    };
    expect(calls).toBe(2);
    expect(quota.observedMaxDebit).toBeGreaterThan(18_000);
    expect(quota.observedDebits.workersInvocationsAdaptive).toBeGreaterThan(18_000);
    expect(quota.capacityWaitUntil).toBeGreaterThan(now + 60_000);
  });

  it("spaces query starts by their measured share of the rolling GraphQL budget", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 19, 30);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    const metadata = JSON.stringify({
      version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1,
    });
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('debit-paced-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 3 * DAY_MS, now),
      ...[0, 1, 2].map(index => testD1!.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES(?1,'debit-paced-job','graphql:workers',?2,?3,?4,'pending','missing',?4)`,
      ).bind(`debit-paced-${index}`, metadata, now - (index + 1) * DAY_MS, now - index * DAY_MS)),
    ]);
    const requestTimes: number[] = [];
    const budgets = [33_000, 30_000, 27_000];
    vi.stubGlobal("fetch", vi.fn(async () => {
      requestTimes.push(Date.now());
      return Response.json({
        data: {
          cost: 111,
          viewer: {
            budget: budgets[requestTimes.length - 1],
            accounts: [{ workersInvocationsAdaptive: [] }],
          },
        },
      });
    }));

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "debit-paced-job",
    );
    await vi.advanceTimersByTimeAsync(35_000);
    await run;

    expect(requestTimes).toHaveLength(3);
    expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(1_200);
    expect(requestTimes[2]! - requestTimes[1]!).toBeGreaterThanOrEqual(28_000);
    expect(requestTimes[2]! - requestTimes[1]!).toBeLessThan(30_000);
    expect((await initialIngestionProgress(testD1.db, "account-1")).job.status).toBe("complete");
  });

  it("hands priority from Durable Objects to Workers before admitting a probe", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 19, 45);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('variable-debit-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('variable-periodic','variable-debit-job','graphql:durable-objects',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2, dataset: "durableObjectsPeriodicGroups", zoneIds: [], maxPageSize: 10_000, units: 1, priority: 0,
      }), now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('variable-workers','variable-debit-job','graphql:workers',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1, priority: 1,
      }), now - DAY_MS, now),
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('variable-probe','variable-debit-job','graphql:worker_builds',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "workersBuildsBuildMinutesAdaptiveGroups",
        zoneIds: [],
        maxPageSize: 10_000,
        pageSizeHint: 2,
        activityProbe: true,
        units: 1,
        priority: 10,
      }), now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          jobId: "variable-debit-job",
          accounting: "logical_queries",
          limiterMode: "shared-paced",
          reportedRemaining: 30_000,
          reportedAt: now,
          reportedForRequestAt: now,
          observedCapacity: 33_189,
          observedMaxDebit: 9_306,
          observedCostMultiplier: 111,
          observedCosts: { "1": 111 },
          observedDebits: {
            durableObjectsPeriodicGroups: 9_306,
            workersInvocationsAdaptive: 111,
          },
          admissions: [],
        }), now),
    ]);
    const requestTimes: number[] = [];
    const queries: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestTimes.push(Date.now());
      queries.push((JSON.parse(String(init?.body)) as { query: string }).query);
      return Response.json({
        data: {
          cost: 111,
          viewer: {
            budget: requestTimes.length === 1 ? 30_000 : 29_889,
            accounts: [{
              durableObjectsPeriodicGroups: [],
              workersInvocationsAdaptive: [],
              workersBuildsBuildMinutesAdaptiveGroups: [],
            }],
          },
        },
      });
    }));

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "variable-debit-job",
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await run;

    expect(requestTimes).toHaveLength(3);
    expect(queries[0]).toContain("durableObjectsPeriodicGroups");
    expect(queries[1]).toContain("workersInvocationsAdaptive");
    expect(queries[2]).toContain("workersBuildsBuildMinutesAdaptiveGroups");
    expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(1_200);
    expect(requestTimes[1]! - requestTimes[0]!).toBeLessThan(2_000);
  });

  it("requires a recovered window after a successful query exhausts the reported budget", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 20);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    const metadata = JSON.stringify({
      version: 2, dataset: "hyperdriveQueriesAdaptiveGroups", zoneIds: [], maxPageSize: 10_000, units: 1,
    });
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('exhausted-budget-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 3 * DAY_MS, now),
      ...[0, 1].map(index => testD1!.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES(?1,'exhausted-budget-job','graphql:hyperdrive',?2,?3,?4,'pending','missing',?4)`,
      ).bind(`exhausted-budget-${index}`, metadata, now - (index + 1) * DAY_MS, now - index * DAY_MS)),
    ]);
    let calls = 0;
    const budgets = [33_300, 0, 33_300];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: {
        cost: 111,
        viewer: {
          budget: budgets[calls++] ?? 33_300,
          accounts: [{ hyperdriveQueriesAdaptiveGroups: [] }],
        },
      },
    })));

    const run = runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "exhausted-budget-job",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('exhausted-budget-2','exhausted-budget-job','graphql:hyperdrive',?1,?2,?3,'pending','missing',?3)`,
      ).bind(metadata, now - 3 * DAY_MS, now - 2 * DAY_MS),
      testD1.db.prepare(`UPDATE backfill_jobs SET status='running',updated_at=?2 WHERE id=?1`)
        .bind("exhausted-budget-job", Date.now()),
    ]);
    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "exhausted-budget-job",
    );

    const stored = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    const quota = JSON.parse(stored!.value) as {
      observedCapacity: number;
      observedMaxDebit: number;
      observedDebits: Record<string, number>;
      provisionalDebitKeys: Record<string, true>;
      admissions: Array<{ budgetDebit: number }>;
      capacityWaitUntil: number;
    };
    expect(calls).toBe(2);
    expect(quota.observedCapacity).toBe(33_411);
    expect(quota.observedMaxDebit).toBeLessThan(quota.observedCapacity);
    expect(quota.observedDebits.hyperdriveQueriesAdaptiveGroups).toBeGreaterThan(30_000);
    expect(quota.provisionalDebitKeys.hyperdriveQueriesAdaptiveGroups).toBe(true);
    expect(quota.admissions.at(-1)?.budgetDebit).toBe(quota.observedCapacity);
    expect(quota.capacityWaitUntil).toBeGreaterThan(now + 4 * 60_000);

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "exhausted-budget-job",
    );
    const corrected = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    const correctedQuota = JSON.parse(corrected!.value) as {
      observedDebits: Record<string, number>;
      provisionalDebitKeys: Record<string, true>;
    };
    expect(calls).toBe(3);
    expect(correctedQuota.provisionalDebitKeys.hyperdriveQueriesAdaptiveGroups).toBeUndefined();
    expect(correctedQuota.observedDebits.hyperdriveQueriesAdaptiveGroups).toBeLessThan(1_000);
  });

  it("keeps capability planning resumable when the shared query window is full", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    await testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
      .bind("initial_ingestion_quota:account-1", JSON.stringify({ windowStartedAt: now, used: 300 }), now).run();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureInitialIngestionJob(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      { now, billingAvailable: false },
    );

    expect(result).toMatchObject({ status: "planning", slices: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checkpoints capability planning before its final wall-time reserve", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 20, 30);
    vi.setSystemTime(now);
    testD1 = createTestD1();
    let graphqlCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/graphql")) {
        graphqlCalls += 1;
        vi.setSystemTime(now + 34_000);
        return Response.json({ data: { viewer: { accounts: [{ settings: {} }] } } });
      }
      return Response.json({ success: true, result: [], result_info: { page: 1, per_page: 50, total_pages: 1 } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureInitialIngestionJob(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      { now, billingAvailable: false },
    );
    const checkpoint = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key=?1`,
    ).bind(`initial_ingestion_capabilities:${result.id}`).first<{ value: string }>();

    expect(result.status).toBe("planning");
    expect(graphqlCalls).toBe(1);
    expect(JSON.parse(checkpoint!.value)).toHaveLength(12);
  });

  it("persists the exact rolling-budget wait when the next capability batch does not fit", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    await testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
      .bind("initial_ingestion_quota:account-1", JSON.stringify({
        jobId: "prior-job",
        accounting: "logical_queries",
        limiterMode: "shared-paced",
        admissions: [{ admittedAt: now, logicalQueries: 265, physicalRequests: 10 }],
      }), now).run();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureInitialIngestionJob(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      { now, billingAvailable: false },
    );
    const progress = await initialIngestionProgress(testD1.db, "account-1");

    expect(result).toMatchObject({ status: "planning", slices: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(progress.job.resumeAt).toBeGreaterThanOrEqual(now + 5 * 60_000);
    expect(progress.job.logicalQueryUnitsUsed).toBe(265);
  });

  it("finishes planning from a persisted capability checkpoint", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    const zoneIds = ["1".repeat(32), "2".repeat(32)];
    const cachedCapabilities = [
      ...accountCapabilities(),
      ...HISTORICAL_DATASETS.filter(spec => spec.root === "zone" && !spec.fallbackFor)
        .flatMap(spec => zoneIds.map(zoneId => enabledCapability(spec, { zoneId, retentionDays: 30, maxDays: 30 }))),
    ];
    await testD1.db.batch([
      testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('cached-plan','account-1','initial_v2',?1,?2,'planning_failed',?2,?2)`,
      ).bind(now - 90 * DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_capabilities:cached-plan", JSON.stringify(cachedCapabilities), now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('onboarding_complete','true',?1)`).bind(now),
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).not.toContain("/graphql");
      return Response.json({
        success: true,
        result: zoneIds.map(id => ({ id })),
        result_info: { page: 1, per_page: 50, total_pages: 1 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureInitialIngestionJob(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      { now, billingAvailable: false },
    );

    expect(result).toMatchObject({ id: "cached-plan", status: "running" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_capabilities:cached-plan'`,
    ).first()).toBeNull();
  });

  it("imports Billing history before capability discovery", async () => {
    vi.useFakeTimers();
    testD1 = createTestD1();
    const now = Date.now();
    vi.setSystemTime(now);
    const calls: string[] = [];
    const analyticsTimes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/graphql")) {
        analyticsTimes.push(Date.now());
        return Response.json({ data: { viewer: { accounts: [{ settings: {} }] } } });
      }
      if (url.includes("/zones?")) {
        return Response.json({ success: true, result: [], result_info: { page: 1, per_page: 50, total_pages: 1 } });
      }
      return Response.json({ success: true, result: [] });
    }));

    const planning = ensureInitialIngestionJob(
      {
        DB: testD1.db,
        BROLLY_ACCOUNT_ID: "account-1",
        CLOUDFLARE_OAUTH_TOKEN: "token",
        CLOUDFLARE_BILLING_TOKEN: "billing-token",
      } as Env,
      { now, billingAvailable: true },
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await planning;

    const firstAnalytics = calls.findIndex(url => url.includes("/graphql"));
    const billingCalls = calls.map((url, index) => ({ url, index })).filter(item => item.url.includes("/billable/usage"));
    expect(billingCalls).toHaveLength(3);
    expect(firstAnalytics).toBeGreaterThan(billingCalls.at(-1)!.index);
    expect(analyticsTimes.length).toBeGreaterThan(1);
    expect(analyticsTimes.slice(1).every((time, index) => {
      const interval = time - analyticsTimes[index]!;
      return interval >= 1_200 && interval < 1_500;
    })).toBe(true);
    expect((await initialIngestionProgress(testD1.db, "account-1")).readiness.billing).toBe("ready");
  });

  it("completes billing slices before Analytics fetches", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('billing-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
    ).bind(now - 2 * DAY_MS, now).run();
    const metadata = JSON.stringify({ version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 10_000, units: 1 });
    await testD1.db.batch([
      testD1.db.prepare(`INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at) VALUES('billing-slice','billing-job','billing',?1,?2,?3,'pending','missing',?3)`).bind(JSON.stringify({ version: 2, dataset: "billable-usage", zoneIds: [], maxPageSize: 10_000, units: 1 }), now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at) VALUES('analytics-slice','billing-job','graphql:workers',?1,?2,?3,'pending','missing',?3)`).bind(metadata, now - DAY_MS, now),
    ]);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return url.includes("/graphql")
        ? Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } })
        : Response.json({ success: true, result: [] });
    }));

    await runInitialIngestion({ DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token", CLOUDFLARE_BILLING_TOKEN: "billing-token" } as Env, "billing-job");

    expect(calls[0]).toContain("/billable/usage");
    expect(calls.some(call => call.includes("/graphql"))).toBe(true);
  });

  it("makes a failed zone terminal while completing its valid sibling", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    const validZone = "1".repeat(32);
    const deniedZone = "2".repeat(32);
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('zone-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
    ).bind(now - DAY_MS, now).run();
    await testD1.db.prepare(
      `INSERT INTO backfill_slices(
         id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,next_eligible_at,coverage_status,error,updated_at
       ) VALUES('zone-slice','zone-job','graphql:email',?1,?2,?3,'pending',0,?3,'missing',NULL,?3)`,
    ).bind(JSON.stringify({
      version: 2, dataset: "emailSendingAdaptiveGroups", zoneIds: [validZone, deniedZone], maxPageSize: 10_000, units: 2,
    }), now - DAY_MS, now).run();
    const requestedZones: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { zones?: string[] } };
      const zones = body.variables?.zones ?? [];
      requestedZones.push(zones);
      if (zones.includes(deniedZone)) return Response.json({ errors: [{ message: `zone ${deniedZone} is not authorized` }] });
      return Response.json({ data: { viewer: { accounts: [{ zones: zones.map(zoneTag => ({ zoneTag, emailSendingAdaptiveGroups: [] })) }] } } });
    }));

    await runInitialIngestion({ DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env, "zone-job");

    const partitions = await testD1.db.prepare(
      `SELECT scope_key,status FROM backfill_slices WHERE backfill_job_id='zone-job' AND status!='superseded' ORDER BY status`,
    ).all<{ scope_key: string; status: string }>();
    expect(partitions.results.map(row => ({
      status: row.status,
      zoneIds: (JSON.parse(row.scope_key) as { zoneIds: string[] }).zoneIds,
    }))).toEqual([
      { status: "complete", zoneIds: [validZone] },
      { status: "failed", zoneIds: [deniedZone] },
    ]);
    expect(requestedZones.filter(zones => zones.includes(deniedZone))).toHaveLength(1);
  });

  it("finishes a single-day row-limit gap instead of leaving the slice running", async () => {
    testD1 = createTestD1();
    const startsAt = Date.UTC(2026, 7, 16);
    const endsAt = startsAt + DAY_MS;
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('row-limit-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
    ).bind(startsAt, endsAt).run();
    await testD1.db.prepare(
      `INSERT INTO backfill_slices(
         id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,retry_count,next_eligible_at,coverage_status,error,updated_at
       ) VALUES('row-limit-slice','row-limit-job','graphql:workers',?1,?2,?3,'pending',0,?3,'missing',NULL,?3)`,
    ).bind(JSON.stringify({
      version: 2, dataset: "workersInvocationsAdaptive", zoneIds: [], maxPageSize: 1, units: 1,
    }), startsAt, endsAt).run();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{}] }] } },
    })));

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "row-limit-job",
    );

    const slice = await testD1.db.prepare(
      `SELECT scope_key,status,coverage_status,error FROM backfill_slices WHERE id='row-limit-slice'`,
    ).first<{ scope_key: string; status: string; coverage_status: string; error: string | null }>();
    const job = await testD1.db.prepare(`SELECT status FROM backfill_jobs WHERE id='row-limit-job'`)
      .first<{ status: string }>();
    expect(slice).toMatchObject({ status: "failed", coverage_status: "partial" });
    expect(slice?.error).toContain("row limit was reached for a single day");
    expect(JSON.parse(slice!.scope_key)).toMatchObject({ availability: "available", terminalGap: true });
    expect(job?.status).toBe("complete_with_gaps");
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

function metadata(slice: InitialIngestionSlicePlan): {
  dataset: string;
  zoneIds: string[];
  units: number;
  priority?: number;
  pageSizeHint?: number;
  freshGraphqlBudgetRequired?: boolean;
  activityProbe?: boolean;
} {
  return JSON.parse(slice.scopeKey) as ReturnType<typeof metadata>;
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
