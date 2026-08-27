import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bisectInitialIngestionRange,
  ensureInitialIngestionJob,
  initialIngestionProgress,
  initialIngestionSchedulingState,
  initialIngestionSlicePlan,
  runInitialIngestion,
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

  it("plans each zone independently for account-based rate limiting", () => {
    const zoneIds = Array.from({ length: 12 }, (_, index) => `zone-${index + 1}`);
    const zoneCapabilities = HISTORICAL_DATASETS
      .filter(spec => spec.root === "zone")
      .flatMap(spec => zoneIds.map(zoneId => enabledCapability(spec, { zoneId, retentionDays: 30, maxDays: 30 })));
    const slices = initialIngestionSlicePlan(NOW, false, [...accountCapabilities(), ...zoneCapabilities]);
    const zones = datasetSlices(slices, "httpRequestsAdaptiveGroups");

    expect(zones).toHaveLength(24);
    expect(zones.every(slice => metadata(slice).zoneIds.length === 1)).toBe(true);
    expect(new Set(zones.flatMap(slice => metadata(slice).zoneIds))).toEqual(new Set(zoneIds));
    expect(zones.filter(slice => slice.status === "pending")).toHaveLength(12);
    expect(zones.filter(slice => slice.status === "complete")).toHaveLength(12);
    expect(zones.reduce((sum, slice) => sum + metadata(slice).units, 0)).toBe(90 * zoneIds.length);
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

    expect(gaps).toHaveLength(2);
    expect(gaps.every(gap => gap.status === "failed" && gap.coverageStatus === "missing")).toBe(true);
    expect(gaps.reduce((sum, gap) => sum + metadata(gap).units, 0)).toBe(180);
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
      limiterMode: "optimistic",
    });
  });

  afterEach(() => {
    testD1?.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

  it("fetches up to six Analytics slices concurrently and finalizes each slice", async () => {
    testD1 = createTestD1();
    const now = Date.now();
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
      dataset: "httpRequestsAdaptiveGroups",
      zoneIds: [(index + 1).toString(16).padStart(32, "0")],
      maxPageSize: 10_000,
      units: 1,
    }), now - (index + 1) * DAY_MS, now - index * DAY_MS, now)));

    let inFlight = 0;
    let peakInFlight = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      const zoneId = (JSON.parse(String(init?.body)) as { variables: { zone: string } }).variables.zone;
      return Response.json({ data: { viewer: { zones: [{ zoneTag: zoneId, httpRequestsAdaptiveGroups: [] }] } } });
    }));

    await runInitialIngestion({ DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env, "parallel-job");

    expect(peakInFlight).toBe(6);
    const completed = await testD1.db.prepare(
      `SELECT COUNT(*) AS count FROM backfill_slices WHERE backfill_job_id='parallel-job' AND status='complete'`,
    ).first<{ count: number }>();
    expect(completed?.count).toBe(7);
  });

  it("paces repeated requests to one zone while other zones remain concurrent", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    const zoneId = "a".repeat(32);
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('zone-pace-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
    ).bind(now - 2 * DAY_MS, now).run();
    await testD1.db.batch(Array.from({ length: 2 }, (_, index) => testD1!.db.prepare(
      `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
       VALUES(?1,'zone-pace-job','graphql:zones',?2,?3,?4,'pending','missing',?4)`,
    ).bind(`zone-pace-${index}`, JSON.stringify({
      version: 2, dataset: "httpRequestsAdaptiveGroups", zoneIds: [zoneId], maxPageSize: 10_000, units: 1,
    }), now - (index + 1) * DAY_MS, now - index * DAY_MS)));
    const requestTimes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      requestTimes.push(Date.now());
      return Response.json({ data: { viewer: { zones: [{ zoneTag: zoneId, httpRequestsAdaptiveGroups: [] }] } } });
    }));

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "zone-pace-job",
    );

    expect(requestTimes).toHaveLength(2);
    expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(950);
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
    expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(950);
  });

  it("keeps Analytics fetching active while D1 persistence is serialized", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('overlap-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
    ).bind(now - 2 * DAY_MS, now).run();
    await testD1.db.batch(Array.from({ length: 7 }, (_, index) => testD1!.db.prepare(
      `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
       VALUES(?1,'overlap-job','graphql:workers',?2,?3,?4,'pending','missing',?4)`,
    ).bind(`overlap-${index}`, JSON.stringify({
      version: 2,
      dataset: "httpRequestsAdaptiveGroups",
      zoneIds: [(index + 1).toString(16).padStart(32, "0")],
      maxPageSize: 10_000,
      units: 1,
    }), now - (index + 1) * DAY_MS, now - index * DAY_MS)));

    let persistenceStarted = false;
    let seventhFetchStartedDuringPersistence = false;
    let fetchCount = 0;
    const baseDb = testD1.db;
    const delayedDb = {
      prepare: baseDb.prepare.bind(baseDb),
      async batch(statements: D1PreparedStatement[]) {
        persistenceStarted = true;
        await new Promise(resolve => setTimeout(resolve, 25));
        return baseDb.batch(statements);
      },
    } as unknown as D1Database;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const request = fetchCount++;
      if (request >= 6 && persistenceStarted) seventhFetchStartedDuringPersistence = true;
      if (request > 0) await new Promise(resolve => setTimeout(resolve, 5));
      const zoneId = (JSON.parse(String(init?.body)) as { variables: { zone: string } }).variables.zone;
      return Response.json({ data: { viewer: { zones: [{ zoneTag: zoneId, httpRequestsAdaptiveGroups: [{
        dimensions: { date: "2026-08-01" }, count: 1,
      }] }] } } });
    }));

    await runInitialIngestion({ DB: delayedDb, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env, "overlap-job");

    expect(seventhFetchStartedDuringPersistence).toBe(true);
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

  it("requeues a wall-time stop without marking or splitting the range", async () => {
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
    ]);
    const baseDb = testD1.db;
    let movedClock = false;
    const elapsedDb = {
      prepare: baseDb.prepare.bind(baseDb),
      async batch(statements: D1PreparedStatement[]) {
        const results = await baseDb.batch(statements);
        if (!movedClock) {
          movedClock = true;
          vi.setSystemTime(now + 56_000);
        }
        return results;
      },
    } as unknown as D1Database;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { viewer: { accounts: [{
      workersInvocationsAdaptive: [{
        dimensions: { date: "2026-08-26", scriptName: "worker" }, sum: { requests: 1, cpuTimeUs: 1 },
      }],
    }] } } })));

    await runInitialIngestion(
      { DB: elapsedDb, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "wall-job",
    );

    const slices = await baseDb.prepare(
      `SELECT status,scope_key,next_eligible_at FROM backfill_slices WHERE backfill_job_id='wall-job'`,
    ).all<{ status: string; scope_key: string; next_eligible_at: number | null }>();
    expect(slices.results).toHaveLength(1);
    expect(slices.results[0]?.status).toBe("pending");
    expect(slices.results[0]?.next_eligible_at).toBe(now + 116_000);
    expect(JSON.parse(slices.results[0]!.scope_key)).not.toHaveProperty("persistenceRetry");
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
        if (sql.includes("SELECT * FROM backfill_slices") && ++claimReads === 2) throw new Error("claim failed");
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
         VALUES('admission-slice','admission-job','graphql:zones',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({
        version: 2,
        dataset: "httpRequestsAdaptiveGroups",
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
    ["HTTP 429", () => Response.json({ errors: [{ message: "too many requests" }] }, { status: 429 })],
    ["GraphQL budget error", () => Response.json({ errors: [{ message: "query budget exceeded", extensions: { code: "budget" } }] })],
  ])("defers %s without consuming a retry", async (_name, response) => {
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
    expect(slice?.retry_count).toBe(0);
    expect(slice?.next_eligible_at).toBeGreaterThan(now);
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
    expect(state).toMatchObject({ jobId: "long-pause-job", limiterMode: "shared-fallback", sharedUsed: 280 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("paces resumed work through the persisted shared fallback lane", async () => {
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
      sharedQueryLimit: 280,
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
    expect(admissions[1]! - admissions[0]!).toBeGreaterThanOrEqual(Math.ceil(5 * 60_000 / 280));
    expect(admissions[2]! - admissions[1]!).toBeGreaterThanOrEqual(Math.ceil(5 * 60_000 / 280));
    const stored = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    expect(JSON.parse(stored!.value)).toMatchObject({
      jobId: "fallback-job",
      limiterMode: "shared-fallback",
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
        limiterMode: "optimistic",
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
       VALUES(?1,'named-limit-job','graphql:zones',?2,?3,?4,'pending','missing',?4)`,
    ).bind(`slice-${zoneId}`, JSON.stringify({
      version: 2, dataset: "httpRequestsAdaptiveGroups", zoneIds: [zoneId], maxPageSize: 10_000, units: 1,
    }), now - DAY_MS, now)));
    let limitedCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { zone?: string } };
      const zoneId = body.variables?.zone;
      if (zoneId === limitedZone) {
        limitedCalls += 1;
        return Response.json({
          errors: [{ message: `Zone ${limitedZone} has exceeded its rate limit. Please try again after 5 minutes.`, extensions: { code: "budget" } }],
        }, { status: 429 });
      }
      return Response.json({ data: { viewer: { zones: [{ zoneTag: healthyZone, httpRequestsAdaptiveGroups: [] }] } } });
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
      limiterMode: "optimistic",
      zonePausedUntil: { [limitedZone]: expect.any(Number) },
    });
  });

  it("continues zone work when the account query bucket is full", async () => {
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
         VALUES('zone-slice','scoped-job','graphql:zones',?1,?2,?3,'pending','missing',?3)`,
      ).bind(JSON.stringify({ version: 2, dataset: "httpRequestsAdaptiveGroups", zoneIds: [zoneId], maxPageSize: 10_000, units: 1 }), now - DAY_MS, now),
      testD1.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)`)
        .bind("initial_ingestion_quota:account-1", JSON.stringify({
          windowStartedAt: now, physicalUsed: 0, accountUsed: 240, zoneUsed: {},
        }), now),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: { viewer: { zones: [{ zoneTag: zoneId, httpRequestsAdaptiveGroups: [] }] } },
    })));

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "scoped-job",
    );

    const rows = await testD1.db.prepare(
      `SELECT id,status FROM backfill_slices WHERE backfill_job_id='scoped-job' ORDER BY id`,
    ).all<{ id: string; status: string }>();
    expect(rows.results).toEqual([
      { id: "account-slice", status: "pending" },
      { id: "zone-slice", status: "complete" },
    ]);
  });

  it("persists independent quota usage for a 55-zone account", async () => {
    testD1 = createTestD1();
    const now = Date.now();
    const zoneIds = Array.from({ length: 55 }, (_, index) => index.toString(16).padStart(32, "0"));
    await testD1.db.prepare(
      `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
       VALUES('zone-quota-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
    ).bind(now - DAY_MS, now).run();
    await testD1.db.batch(zoneIds.map((zoneId, index) => testD1!.db.prepare(
      `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
       VALUES(?1,'zone-quota-job','graphql:zones',?2,?3,?4,'pending','missing',?4)`,
    ).bind(`zone-quota-${index}`, JSON.stringify({
      version: 2, dataset: "httpRequestsAdaptiveGroups", zoneIds: [zoneId], maxPageSize: 10_000, units: 1,
    }), now - DAY_MS, now)));
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { zone?: string } };
      const zoneId = body.variables?.zone;
      return Response.json({ data: { viewer: { zones: zoneId ? [{ zoneTag: zoneId, httpRequestsAdaptiveGroups: [] }] : [] } } });
    }));

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "zone-quota-job",
    );

    const quota = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    const state = JSON.parse(quota!.value) as { physicalUsed: number; zoneUsed: Record<string, number> };
    expect(state.physicalUsed).toBe(55);
    expect(Object.keys(state.zoneUsed)).toHaveLength(55);
    expect(Object.values(state.zoneUsed).every(used => used === 1)).toBe(true);
  });

  it("carries logical GraphQL usage across resumed runs", async () => {
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
        windowStartedAt: now, physicalUsed: 699, accountUsed: 239, zoneUsed: {},
      }), now),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } })));

    await runInitialIngestion({ DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env, "quota-job");

    const quota = await testD1.db.prepare("SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'").first<{ value: string }>();
    expect(JSON.parse(quota!.value)).toMatchObject({ windowStartedAt: now, physicalUsed: 700, accountUsed: 240 });
  });

  it("attributes requests after a mid-run rollover to the new quota window", async () => {
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
          windowStartedAt: now - 299_000, physicalUsed: 699, accountUsed: 239, zoneUsed: {},
        }), now),
    ]);
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (++calls === 1) vi.setSystemTime(now + 2_000);
      return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } });
    }));

    await runInitialIngestion(
      { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env,
      "rollover-job",
    );

    const quota = await testD1.db.prepare(
      `SELECT value FROM settings WHERE key='initial_ingestion_quota:account-1'`,
    ).first<{ value: string }>();
    expect(JSON.parse(quota!.value)).toMatchObject({
      windowStartedAt: now + 2_000,
      physicalUsed: 1,
      accountUsed: 1,
    });
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

    expect(result).toMatchObject({ status: "planning", slices: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
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
       ) VALUES('zone-slice','zone-job','graphql:zones',?1,?2,?3,'pending',0,?3,'missing',NULL,?3)`,
    ).bind(JSON.stringify({
      version: 2, dataset: "httpRequestsAdaptiveGroups", zoneIds: [validZone, deniedZone], maxPageSize: 10_000, units: 2,
    }), now - DAY_MS, now).run();
    const requestedZones: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { zone?: string } };
      const zone = body.variables?.zone ?? "";
      requestedZones.push(zone);
      if (zone === deniedZone) return Response.json({ errors: [{ message: `zone ${deniedZone} is not authorized` }] });
      return Response.json({ data: { viewer: { zones: [{ zoneTag: zone, httpRequestsAdaptiveGroups: [] }] } } });
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
    expect(requestedZones.filter(zone => zone === deniedZone)).toHaveLength(1);
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
