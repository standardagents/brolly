import { afterEach, describe, expect, it } from "vitest";
import { collectorWindow, coverageIncidents, isExpectedLiveCoverage, windowContinuation } from "../src/monitor.js";
import { Store } from "../src/store.js";
import { createTestD1, type TestD1 } from "./d1.js";
import type { Env } from "../src/env.js";

describe("fixed collector windows", () => {
  it("keeps a persisted continuation bound to its original interval", () => {
    const stored = { startAt: 1_000, endAt: 301_000, cursor: { after: "object-10000" } };
    expect(collectorWindow(stored, 601_000, 901_000)).toEqual(stored);
    expect(windowContinuation(stored, { after: "object-20000" }, 901_000)).toEqual({
      startAt: 1_000, endAt: 301_000, cursor: { after: "object-20000" },
    });
  });

  it("advances a completed catch-up window by one fixed interval", () => {
    const window = { startAt: 1_000, endAt: 301_000 };
    expect(windowContinuation(window, null, 901_000)).toEqual({ startAt: 301_000, endAt: 601_000 });
    expect(windowContinuation({ startAt: 601_000, endAt: 901_000 }, null, 901_000)).toBeNull();
  });

  it("replaces corrupt persisted bounds with the aligned fallback", () => {
    expect(collectorWindow({ startAt: 10, endAt: 10, cursor: "bad" }, 1_000, 301_000))
      .toEqual({ startAt: 1_000, endAt: 301_000 });
  });
});

describe("coverage incident eligibility", () => {
  let testD1: TestD1 | undefined;
  afterEach(() => testD1?.close());

  const coverage = (family: string, metric: string) => ({
    family, metric, finestScope: "account" as const, state: "unavailable" as const, checkedAt: Date.now(),
  });

  it("excludes passive worker cache coverage", () => {
    expect(isExpectedLiveCoverage(coverage("workers", "cache_requests"))).toBe(false);
  });

  it("excludes unseen passive product metrics", () => {
    for (const [family, metric] of [["d1", "rows_read"], ["r2", "class_a"], ["kv", "reads"], ["queues", "operations"]]) {
      expect(isExpectedLiveCoverage(coverage(family, metric))).toBe(false);
    }
  });

  it("keeps explicit active live metrics eligible", () => {
    expect(isExpectedLiveCoverage(coverage("workers", "requests"))).toBe(true);
    expect(isExpectedLiveCoverage(coverage("durable_objects", "requests"))).toBe(true);
    expect(isExpectedLiveCoverage(coverage("d1", "asset_inventory"))).toBe(true);
  });

  it("resolves legacy passive incidents while preserving active and inventory coverage", async () => {
    testD1 = createTestD1();
    const accountId = "account-1";
    const insert = (id: string, family: string, metric: string) => testD1!.db.prepare(
      `INSERT INTO incidents(
         id,incident_key,account_id,family,asset_id,severity,metric,observed,reason,proposed_action,status,first_seen,last_seen,occurrences
       ) VALUES(?1,?2,?3,?4,?5,'critical','telemetry_coverage',0,'missing','notify','open',1,1,1)`,
    ).bind(id, `${accountId}:coverage:${family}:${metric}`, accountId, family, metric);
    await testD1.db.batch([
      insert("passive", "workers", "cache_requests"),
      insert("live", "workers", "requests"),
      insert("inventory", "d1", "asset_inventory"),
      insert("billing", "billing", "authoritative_usage"),
    ]);

    await coverageIncidents(
      new Store(testD1.db, () => undefined),
      [],
      { DB: testD1.db, BROLLY_ACCOUNT_ID: accountId } as Env,
      new Map(),
    );

    const rows = await testD1.db.prepare(`SELECT id,status FROM incidents ORDER BY id`).all<{ id: string; status: string }>();
    expect(Object.fromEntries(rows.results.map(row => [row.id, row.status]))).toEqual({
      billing: "open",
      inventory: "open",
      live: "open",
      passive: "resolved",
    });
  });
});
