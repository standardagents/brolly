import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LEDGER_RUN_LIMITS, LedgerRunBudget, resourceId } from "@standardagents/brolly-core";
import { metricSeries, type UsageSeriesResponse as ClientUsageSeriesResponse } from "../src/client/components/limits-chart/api.js";
import { usageSeriesResponse, type UsageSeriesResponse } from "../src/usage-series.js";
import { coverageSpansForMetrics, saveCoverageInterval } from "../src/coverage-intervals.js";
import { projectCycle } from "../src/client/components/limits-chart/cycles.js";
import { ingestWindow } from "../src/ingest.js";
import { LedgerStore } from "../src/ledger-store.js";
import type { CloudflareClient } from "../src/cloudflare.js";
import type { Env } from "../src/env.js";
import { createTestD1, type TestD1 } from "./d1.js";

const ACCOUNT = "coverage-account";
const NOW = Date.UTC(2026, 7, 17, 12);

describe("usage coverage", () => {
  let d1: TestD1 | undefined;
  afterEach(() => { d1?.close(); d1 = undefined; });

  it("reports a successful empty interval as measured zero", async () => {
    d1 = createTestD1();
    const id = resourceId(ACCOUNT, "workers", "product", "workers");
    await d1.db.batch([
      d1.db.prepare(
        `INSERT INTO resources(id,account_id,parent_resource_id,product_family,resource_type,cloudflare_id,display_name,first_seen_at,last_seen_at)
         VALUES(?1,?2,NULL,'workers','product','workers','Workers',?3,?3)`,
      ).bind(id, ACCOUNT, NOW),
      d1.db.prepare(
        `INSERT INTO metric_definitions(id,product_family,metric_key,display_name,unit,aggregation_kind,billing_mapping,collector_key,finest_scope,catalog_version)
         VALUES('workers:requests','workers','requests','Requests','requests','sum','workers_requests','graphql:workers','resource','v1')`,
      ),
      d1.db.prepare(
        `INSERT INTO coverage_intervals(account_id,dataset,scope_key,starts_at,ends_at,state,reason,recorded_at)
         VALUES(?1,'workersInvocationsAdaptive','',?2,?3,'measured',NULL,?4)`,
      ).bind(ACCOUNT, NOW - 2 * 86_400_000, NOW + 86_400_000, NOW),
    ]);

    const body = await (await usageSeriesResponse(
      d1.db, ACCOUNT, new URL("https://brolly.test/api/usage-series?scope=family:workers&days=1"), NOW,
    )).json() as UsageSeriesResponse;
    const points = metricSeries(body as ClientUsageSeriesResponse, "workers:requests");

    expect(body.series).toEqual([]);
    expect(body.costCoverage).toEqual([{ fromDay: "2026-08-16", toDay: "2026-08-17", state: "measured" }]);
    expect(points).toHaveLength(2);
    expect(points.every(point => point.value === 0 && point.missing === false && point.coverage === "measured")).toBe(true);
  });

  it("keeps the canonical metric visible when a product has measured usage", async () => {
    d1 = createTestD1();
    const id = resourceId(ACCOUNT, "workers_ai", "product", "workers_ai");
    await d1.db.batch([
      d1.db.prepare(
        `INSERT INTO resources(id,account_id,parent_resource_id,product_family,resource_type,cloudflare_id,display_name,first_seen_at,last_seen_at)
         VALUES(?1,?2,NULL,'workers_ai','product','workers_ai','Workers AI',?3,?3)`,
      ).bind(id, ACCOUNT, NOW),
      d1.db.prepare(
        `INSERT INTO metric_definitions(id,product_family,metric_key,display_name,unit,aggregation_kind,billing_mapping,collector_key,finest_scope,catalog_version)
         VALUES('workers_ai:neurons','workers_ai','neurons','Neurons','count','sum','neurons','graphql:workers_ai','resource','v1')`,
      ),
      d1.db.prepare(
        `INSERT INTO usage_daily(resource_id,local_day,period_start_at,period_end_at,metrics_json,estimated_cost_usd,completeness,sealed,revised_at)
         VALUES(?1,'2026-08-17',0,0,'{"workers_ai:neurons":120}',0.12,'complete',1,?2)`,
      ).bind(id, NOW),
      d1.db.prepare(
        `INSERT INTO coverage_intervals(account_id,dataset,scope_key,starts_at,ends_at,state,reason,recorded_at)
         VALUES(?1,'aiInferenceAdaptiveGroups','',?2,?3,'measured',NULL,?4)`,
      ).bind(ACCOUNT, NOW - 2 * 86_400_000, NOW + 86_400_000, NOW),
    ]);

    const body = await (await usageSeriesResponse(
      d1.db, ACCOUNT, new URL("https://brolly.test/api/usage-series?scope=family:workers_ai&days=1"), NOW,
    )).json() as UsageSeriesResponse;

    expect(body.metrics).toMatchObject({
      "workers_ai:neurons": { label: "Neurons", role: "billable", productLimit: true },
    });
    expect(body.series).toEqual([{ day: "2026-08-17", costUsd: 0.12, metrics: { "workers_ai:neurons": 120 }, sealed: true }]);
    expect(body.costCoverage).toEqual([{ fromDay: "2026-08-16", toDay: "2026-08-17", state: "measured" }]);
  });

  it("includes hidden cost-bearing metrics when computing product cost coverage", async () => {
    d1 = createTestD1();
    const id = resourceId(ACCOUNT, "workers", "product", "workers");
    await d1.db.batch([
      d1.db.prepare(
        `INSERT INTO resources(id,account_id,parent_resource_id,product_family,resource_type,cloudflare_id,display_name,first_seen_at,last_seen_at)
         VALUES(?1,?2,NULL,'workers','product','workers','Workers',?3,?3)`,
      ).bind(id, ACCOUNT, NOW),
      d1.db.prepare(
        `INSERT INTO metric_definitions(id,product_family,metric_key,display_name,unit,aggregation_kind,billing_mapping,collector_key,finest_scope,catalog_version)
         VALUES
           ('workers:requests','workers','requests','Requests','requests','sum','workers_requests','graphql:workers','resource','v1'),
           ('workers:cache_requests','workers','cache_requests','Cache requests','requests','sum','cache_requests','graphql:workers','resource','v1')`,
      ),
      d1.db.prepare(
        `INSERT INTO coverage_intervals(account_id,dataset,scope_key,starts_at,ends_at,state,reason,recorded_at)
         VALUES
           (?1,'workersInvocationsAdaptive','',?2,?3,'measured',NULL,?4),
           (?1,'billable-usage','',?2,?3,'unavailable','Billing data unavailable',?4)`,
      ).bind(ACCOUNT, NOW - 2 * 86_400_000, NOW + 86_400_000, NOW),
    ]);

    const body = await (await usageSeriesResponse(
      d1.db, ACCOUNT, new URL("https://brolly.test/api/usage-series?scope=family:workers&days=1"), NOW,
    )).json() as UsageSeriesResponse;

    expect(Object.keys(body.metrics)).toEqual(["workers:requests"]);
    expect(body.coverage).toEqual({
      "workers:requests": [{ fromDay: "2026-08-16", toDay: "2026-08-17", state: "measured" }],
    });
    expect(body.costCoverage).toEqual([
      { fromDay: "2026-08-16", toDay: "2026-08-17", state: "partial", reason: "Billing data unavailable" },
    ]);
  });

  it("keeps unavailable and pending intervals out of chart math", () => {
    const response = {
      scope: "family:workers",
      resourceId: "workers",
      found: true,
      fromDay: "2026-08-15",
      today: "2026-08-17",
      metrics: { "workers:requests": { key: "requests", label: "Requests", unit: "requests", billable: true } },
      series: [{ day: "2026-08-17", costUsd: 0, metrics: { "workers:requests": 4 }, sealed: false }],
      coverage: { "workers:requests": [
        { fromDay: "2026-08-15", toDay: "2026-08-15", state: "unavailable" },
        { fromDay: "2026-08-16", toDay: "2026-08-16", state: "pending" },
        { fromDay: "2026-08-17", toDay: "2026-08-17", state: "measured" },
      ] },
      costCoverage: [],
      cycles: [],
    } satisfies ClientUsageSeriesResponse;

    expect(metricSeries(response, "workers:requests").map(point => ({ day: point.day, value: point.value, missing: point.missing }))).toEqual([
      { day: "2026-08-15", value: 0, missing: true },
      { day: "2026-08-16", value: 0, missing: true },
      { day: "2026-08-17", value: 4, missing: false },
    ]);
  });

  it("reports mixed Email coverage across zones without a generic traffic collector", async () => {
    d1 = createTestD1();
    const startsAt = Date.UTC(2026, 7, 15);
    const endsAt = Date.UTC(2026, 7, 16);
    const rows = [
      ["emailSendingAdaptiveGroups", "zone-1", "measured"],
      ["emailSendingAdaptiveGroups", "zone-2", "unavailable"],
    ] as const;
    for (const [dataset, scopeKey, state] of rows) await saveCoverageInterval(d1.db, {
      accountId: ACCOUNT, dataset, scopeKey, startsAt, endsAt, state,
      reason: state === "unavailable" ? "Unavailable for this zone" : undefined,
    });

    const account = await coverageSpansForMetrics(
      d1.db, ACCOUNT, ["email:sent"], "2026-08-15", "2026-08-15", "family:email",
    );
    const availableAsset = await coverageSpansForMetrics(
      d1.db, ACCOUNT, ["email:sent"], "2026-08-15", "2026-08-15", "asset:email:zone:zone-1",
    );
    const unavailableAsset = await coverageSpansForMetrics(
      d1.db, ACCOUNT, ["email:sent"], "2026-08-15", "2026-08-15", "asset:email:zone:zone-2",
    );

    expect(account["email:sent"]?.[0]?.state).toBe("partial");
    expect(availableAsset["email:sent"]?.[0]?.state).toBe("measured");
    expect(unavailableAsset["email:sent"]?.[0]).toMatchObject({ state: "unavailable", reason: "Unavailable for this zone" });
  });

  it("extends adjacent monitor evidence without adding interval rows", async () => {
    d1 = createTestD1();
    const startsAt = Date.UTC(2026, 7, 15);
    await saveCoverageInterval(d1.db, {
      accountId: ACCOUNT, dataset: "workersInvocationsAdaptive", startsAt,
      endsAt: startsAt + 5 * 60_000, state: "measured",
    });
    await saveCoverageInterval(d1.db, {
      accountId: ACCOUNT, dataset: "workersInvocationsAdaptive", startsAt: startsAt + 5 * 60_000,
      endsAt: startsAt + 10 * 60_000, state: "measured",
    });
    const rows = await d1.db.prepare(
      `SELECT starts_at,ends_at FROM coverage_intervals WHERE account_id=?1 AND dataset='workersInvocationsAdaptive'`,
    ).bind(ACCOUNT).all<{ starts_at: number; ends_at: number }>();

    expect(rows.results).toEqual([{ starts_at: startsAt, ends_at: startsAt + 10 * 60_000 }]);
  });

  it("keeps observed partial values out of projection pace", () => {
    const startsAt = Date.UTC(2026, 7, 1);
    const series = Array.from({ length: 8 }, (_, index) => ({
      day: `2026-08-${String(index + 1).padStart(2, "0")}`,
      value: index === 7 ? 1_000 : 10,
      coverage: index === 7 ? "partial" as const : "measured" as const,
    }));
    const projection = projectCycle(series, [{ startsAt, endsAt: Date.UTC(2026, 8, 1) }], "2026-08-08");

    expect(projection?.toDate).toBe(1_070);
    expect(projection?.rate).toBe(10);
  });

  it("does not persist partial evidence for an incomplete historical billing request", async () => {
    d1 = createTestD1();
    const env = { DB: d1.db, BROLLY_ACCOUNT_ID: ACCOUNT } as Env;
    const budget = new LedgerRunBudget(DEFAULT_LEDGER_RUN_LIMITS);
    const client = { billingUsage: async () => null } as unknown as CloudflareClient;

    const result = await ingestWindow({
      env, client, ledger: new LedgerStore(d1.db, budget), collector: "billing",
      startsAt: NOW - 86_400_000, endsAt: NOW, budget, timeZone: "UTC", historical: true,
    });
    const rows = await d1.db.prepare(
      `SELECT state FROM coverage_intervals WHERE account_id=?1 AND dataset='billable-usage'`,
    ).bind(ACCOUNT).all<{ state: string }>();

    expect(result.complete).toBe(false);
    expect(rows.results).toEqual([]);
  });
});
