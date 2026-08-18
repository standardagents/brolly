import { resourceId } from "@standardagents/brolly-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scopeResourceId, usageSeriesResponse, type UsageSeriesResponse } from "../src/usage-series";
import { createTestD1, type TestD1 } from "./d1";

const ACCOUNT = "acct-1";
const NOW = Date.UTC(2026, 7, 17, 15);

describe("usage series", () => {
  let d1: TestD1;
  beforeEach(() => { d1 = createTestD1(); });
  afterEach(() => d1.close());

  it("maps policy scope keys to ledger resource ids", () => {
    expect(scopeResourceId(ACCOUNT, "account")).toBe(resourceId(ACCOUNT, "account", "account", ACCOUNT));
    expect(scopeResourceId(ACCOUNT, "family:workers")).toBe(resourceId(ACCOUNT, "workers", "product", "workers"));
    expect(scopeResourceId(ACCOUNT, "asset:durable_objects:namespace:ns-1")).toBe(resourceId(ACCOUNT, "durable_objects", "durable_objects:namespace", "ns-1"));
    expect(scopeResourceId(ACCOUNT, "bogus")).toBeNull();
  });

  it("returns sealed daily rows plus unsealed accumulator days, with cycles and metric units", async () => {
    const id = resourceId(ACCOUNT, "workers", "product", "workers");
    await d1.db.prepare(
      `INSERT INTO resources(id,account_id,parent_resource_id,product_family,resource_type,cloudflare_id,display_name,first_seen_at,last_seen_at)
       VALUES(?1,?2,NULL,'workers','product','workers','Workers',?3,?3)`,
    ).bind(id, ACCOUNT, NOW).run();
    await d1.db.prepare(
      `INSERT INTO metric_definitions(id,product_family,metric_key,display_name,unit,aggregation_kind,billing_mapping,collector_key,finest_scope,catalog_version)
       VALUES('workers.requests','workers','requests','Requests','requests','sum','workers_requests','graphql:workers','resource','v1')`,
    ).run();
    await d1.db.prepare(
      `INSERT INTO usage_daily(resource_id,local_day,period_start_at,period_end_at,metrics_json,estimated_cost_usd,completeness,sealed,revised_at)
       VALUES(?1,'2026-08-15',0,0,'{"workers.requests":1000}',0.30,'complete',1,?2)`,
    ).bind(id, NOW).run();
    await d1.db.prepare(
      `INSERT INTO usage_accumulator_shards(account_id,product_family,scope_type,local_day,billing_cycle_id,resource_hash_bucket,payload_json,updated_at)
       VALUES(?1,'workers','product','2026-08-17','cycle-1',0,?2,?3)`,
    ).bind(ACCOUNT, JSON.stringify({ resources: { [id]: { metrics: { "workers.requests": { day: 250, estimatedDayUsd: 0.075, quality: "complete", sampleInterval: 1 } } } } }), NOW).run();
    await d1.db.prepare(
      `INSERT INTO billing_cycles(id,account_id,starts_at,ends_at,status,currency,approximate)
       VALUES('cycle-1',?1,?2,?3,'open','USD',1)`,
    ).bind(ACCOUNT, Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1)).run();

    const response = await usageSeriesResponse(d1.db, ACCOUNT, new URL("https://brolly.test/api/usage-series?scope=family:workers"), NOW);
    expect(response.status).toBe(200);
    const body = await response.json() as UsageSeriesResponse;
    expect(body.found).toBe(true);
    expect(body.today).toBe("2026-08-17");
    expect(body.series.map(point => [point.day, point.costUsd, point.metrics["workers.requests"], point.sealed])).toEqual([
      ["2026-08-15", 0.3, 1000, true],
      ["2026-08-17", 0.075, 250, false],
    ]);
    expect(body.metrics["workers.requests"]).toEqual({ key: "requests", label: "Requests", unit: "requests", billable: true });
    expect(body.cycles).toEqual([{ startsAt: Date.UTC(2026, 7, 1), endsAt: Date.UTC(2026, 8, 1), approximate: true }]);
  });

  it("rejects malformed scopes and reports unknown resources as not found", async () => {
    expect((await usageSeriesResponse(d1.db, ACCOUNT, new URL("https://brolly.test/api/usage-series?scope=nope"), NOW)).status).toBe(400);
    const body = await (await usageSeriesResponse(d1.db, ACCOUNT, new URL("https://brolly.test/api/usage-series?scope=account"), NOW)).json() as UsageSeriesResponse;
    expect(body.found).toBe(false);
    expect(body.series).toEqual([]);
  });
});
