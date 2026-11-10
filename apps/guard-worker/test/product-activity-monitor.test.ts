import { LedgerBudgetExceededError, LedgerRunBudget } from "@standardagents/brolly-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudflareClient } from "../src/cloudflare.js";
import type { Env } from "../src/env.js";
import { HISTORICAL_DATASETS, type HistoricalUsageRequest, type HistoricalUsageResult } from "../src/historical-analytics.js";
import { monitorProductActivity } from "../src/product-activity-monitor.js";
import type { LedgerStore } from "../src/ledger-store.js";
import { createTestD1, type TestD1 } from "./d1.js";

const ACCOUNT = "activity-monitor-account";
const START = Date.UTC(2026, 7, 1);
const END = Date.UTC(2026, 7, 31);
const STATE_KEY = "product_activity_monitor_v1";

function monitorableSpecs() {
  return HISTORICAL_DATASETS
    .filter(spec => spec.kind === "product" && spec.root === "account" && !spec.fallbackFor)
    .sort((left, right) => left.dataset.localeCompare(right.dataset));
}

function resultFor(
  request: HistoricalUsageRequest,
  value = 0,
): HistoricalUsageResult {
  const spec = monitorableSpecs().find(item => item.dataset === request.dataset)!;
  const metric = spec.source?.metrics[0]?.metric ?? "requests";
  return {
    collector: spec.collector,
    dataset: request.dataset,
    samples: value === 0 ? [] : [{
      asset: {
        accountId: ACCOUNT,
        family: spec.family,
        id: `${spec.family}-aggregate`,
        scope: "account",
        tier: "standard",
      },
      metric,
      unit: "count",
      value,
      start: request.startsAt,
      end: request.endsAt,
      source: "graphql",
    }],
    coverage: [{
      family: spec.family,
      metric,
      finestScope: "account",
      state: "healthy",
      checkedAt: request.endsAt,
      detail: "Activity monitor test evidence",
    }],
    complete: true,
    rows: value === 0 ? 0 : 1,
  };
}

function testEnv(testD1: TestD1): Env {
  return { DB: testD1.db, BROLLY_ACCOUNT_ID: ACCOUNT };
}

function testBudget(): LedgerRunBudget {
  return new LedgerRunBudget({
    graphqlQueries: 100,
    d1RowsRead: 10_000,
    d1RowsWritten: 10_000,
    wallMs: 55_000,
  });
}

function fakeClient(
  handler: (request: HistoricalUsageRequest) => HistoricalUsageResult | Promise<HistoricalUsageResult>,
) {
  const calls: HistoricalUsageRequest[] = [];
  const historicalUsage = vi.fn(async (request: HistoricalUsageRequest) => {
    calls.push({ ...request });
    return handler(request);
  });
  return {
    client: { historicalUsage } as unknown as CloudflareClient,
    calls,
    historicalUsage,
  };
}

function fakeLedger() {
  const applyObservations = vi.fn(async () => []);
  return {
    ledger: { applyObservations } as unknown as LedgerStore,
    applyObservations,
  };
}

async function runMonitor(
  env: Env,
  client: CloudflareClient,
  ledger: LedgerStore,
): Promise<Awaited<ReturnType<typeof monitorProductActivity>>> {
  // The monitor spaces requests by 1.2 seconds in production. An immediate
  // timer keeps this unit test focused on request sequencing and persistence.
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler) => {
    if (typeof handler === "function") (handler as () => void)();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  try {
    return await monitorProductActivity(env, client, ledger, testBudget(), "UTC", START, END);
  } finally {
    timer.mockRestore();
  }
}

async function savedState(testD1: TestD1): Promise<{
  activeDatasets: string[];
  probeCursor: number;
  activeCursor: number;
  failures: Record<string, { count: number; nextEligibleAt: number; detail: string }>;
}> {
  const row = await testD1.db.prepare(`SELECT value FROM settings WHERE key=?1 LIMIT 1`).bind(STATE_KEY)
    .first<{ value: string }>();
  return JSON.parse(row!.value) as Awaited<ReturnType<typeof savedState>>;
}

describe("product activity monitor", () => {
  let testD1: TestD1 | undefined;

  afterEach(() => {
    testD1?.close();
    testD1 = undefined;
    vi.restoreAllMocks();
  });

  it("uses one-row aggregate probes for inactive account product datasets", async () => {
    testD1 = createTestD1();
    const fake = fakeClient(request => resultFor(request));
    const ledger = fakeLedger();

    const result = await runMonitor(testEnv(testD1), fake.client, ledger.ledger);
    const expectedProbeCount = Math.min(10, monitorableSpecs().length);

    expect(fake.calls).toHaveLength(expectedProbeCount);
    expect(fake.calls.every(request => request.activityProbe === true && request.maxPageSize === 1)).toBe(true);
    expect(result).toEqual({ changes: [], samples: 0 });
    expect(ledger.applyObservations).not.toHaveBeenCalled();
    expect((await savedState(testD1)).probeCursor).toBe(expectedProbeCount % monitorableSpecs().length);
  });

  it("persists a positive probe as an active dataset without writing observations", async () => {
    testD1 = createTestD1();
    const target = monitorableSpecs()[0]!;
    const fake = fakeClient(request => {
      const result = resultFor(request, request.dataset === target.dataset ? 4 : 0);
      return request.dataset === target.dataset
        ? { ...result, complete: false, coverage: result.coverage.map(item => ({ ...item, state: "delayed" as const })) }
        : result;
    });
    const ledger = fakeLedger();

    await runMonitor(testEnv(testD1), fake.client, ledger.ledger);

    expect((await savedState(testD1)).activeDatasets).toEqual([target.dataset]);
    expect(fake.calls.find(request => request.dataset === target.dataset)).toMatchObject({
      activityProbe: true,
      maxPageSize: 1,
    });
    expect(ledger.applyObservations).not.toHaveBeenCalled();
    expect(await testD1.db.prepare(
      `SELECT state FROM coverage_intervals WHERE dataset=?1 LIMIT 1`,
    ).bind(`${target.dataset}#${target.source!.metrics[0]!.metric}`).first()).toMatchObject({ state: "partial" });
  });

  it("collects an active dataset with detailed history on a later run", async () => {
    testD1 = createTestD1();
    const target = monitorableSpecs()[0]!;
    const fake = fakeClient(request => {
      if (request.dataset === target.dataset) return resultFor(request, request.activityProbe ? 4 : 9);
      return resultFor(request);
    });
    const ledger = fakeLedger();

    await runMonitor(testEnv(testD1), fake.client, ledger.ledger);
    fake.calls.length = 0;
    const second = await runMonitor(testEnv(testD1), fake.client, ledger.ledger);

    const detailed = fake.calls.filter(request => request.dataset === target.dataset && request.activityProbe === false);
    expect(detailed).toHaveLength(1);
    expect(detailed[0]).toMatchObject({ dataset: target.dataset, maxPageSize: 10_000, activityProbe: false });
    expect(second.samples).toBe(1);
    expect(ledger.applyObservations).toHaveBeenCalledTimes(1);
    expect(ledger.applyObservations.mock.calls[0]?.[0].length).toBeGreaterThan(0);
  });

  it("does not write observations for empty probes", async () => {
    testD1 = createTestD1();
    const fake = fakeClient(request => resultFor(request));
    const ledger = fakeLedger();

    const result = await runMonitor(testEnv(testD1), fake.client, ledger.ledger);

    expect(result.samples).toBe(0);
    expect(ledger.applyObservations).not.toHaveBeenCalled();
    expect((await savedState(testD1)).activeDatasets).toEqual([]);
  });

  it("isolates probe errors and continues rotating through other datasets", async () => {
    testD1 = createTestD1();
    const specs = monitorableSpecs();
    const failed = specs[0]!;
    const fake = fakeClient(request => {
      if (request.dataset === failed.dataset) throw new Error("dataset unavailable");
      return resultFor(request);
    });
    const ledger = fakeLedger();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runMonitor(testEnv(testD1), fake.client, ledger.ledger);

    expect(result).toEqual({ changes: [], samples: 0 });
    expect(fake.calls.some(request => request.dataset === failed.dataset)).toBe(true);
    expect(fake.calls.some(request => request.dataset !== failed.dataset)).toBe(true);
    expect(warning.mock.calls.some(([label]) => label === "brolly.product_activity_probe_failed")).toBe(true);
    expect((await savedState(testD1)).activeDatasets).toEqual([]);
    expect((await savedState(testD1)).failures[failed.dataset]).toMatchObject({ count: 1 });
    expect(ledger.applyObservations).not.toHaveBeenCalled();
  });

  it("backs off a failed dataset on the following monitor run", async () => {
    testD1 = createTestD1();
    const failed = monitorableSpecs()[0]!;
    const fake = fakeClient(request => {
      if (request.dataset === failed.dataset) throw new Error("dataset unavailable");
      return resultFor(request);
    });
    const ledger = fakeLedger();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await runMonitor(testEnv(testD1), fake.client, ledger.ledger);
    fake.calls.length = 0;
    await runMonitor(testEnv(testD1), fake.client, ledger.ledger);

    expect(fake.calls.some(request => request.dataset === failed.dataset)).toBe(false);
  });

  it("propagates a shared budget stop", async () => {
    testD1 = createTestD1();
    const fake = fakeClient(() => {
      throw new LedgerBudgetExceededError("graphqlQueries", 101, 100);
    });
    const ledger = fakeLedger();

    await expect(runMonitor(testEnv(testD1), fake.client, ledger.ledger))
      .rejects.toBeInstanceOf(LedgerBudgetExceededError);
    expect(fake.calls).toHaveLength(1);
  });
});
