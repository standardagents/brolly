import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store";
import { createTestD1, type TestD1 } from "./d1";

describe("resource identity inventory reconciliation", () => {
  let testD1: TestD1 | null = null;
  afterEach(() => testD1?.close());

  it("learns a supplied name once and preserves it when a later source has no name", async () => {
    testD1 = createTestD1();
    const writes: number[] = [];
    const store = new Store(testD1.db, (amount, kind) => { if (kind === "write") writes.push(amount); });
    await testD1.db.prepare(
      `INSERT INTO resources(id,account_id,product_family,resource_type,cloudflare_id,display_name,first_seen_at,last_seen_at)
       VALUES('resource-1','account-1','durable_objects','durable_objects:namespace','namespace-1','namespace-1',1,1)`,
    ).run();
    const named = {
      accountId: "account-1", family: "durable_objects", id: "namespace-1", name: "AgentThread",
      nameKind: "named" as const, scope: "namespace" as const, tier: "standard" as const,
      tags: { cloudflareWorkerScript: "api-worker" },
    };

    await store.saveAssets([named]);
    writes.length = 0;
    await store.saveAssets([named]);
    expect(writes.reduce((sum, value) => sum + value, 0)).toBe(0);

    await store.saveAssets([{ ...named, name: undefined, nameKind: "id_only" }]);
    const row = await testD1.db.prepare(
      `SELECT cloudflare_name,name_kind,metadata_json FROM resources WHERE id='resource-1'`,
    ).first<{ cloudflare_name: string | null; name_kind: string; metadata_json: string }>();
    expect(row).toMatchObject({ cloudflare_name: "AgentThread", name_kind: "named" });
    expect(JSON.parse(row!.metadata_json)).toMatchObject({ cloudflareWorkerScript: "api-worker" });
  });

  it("does not replace a Brolly aggregate identity with a colliding asset name", async () => {
    testD1 = createTestD1();
    const store = new Store(testD1.db, () => undefined);
    await testD1.db.prepare(
      `INSERT INTO resources(
         id,account_id,product_family,resource_type,cloudflare_id,display_name,
         cloudflare_name,name_kind,metadata_json,first_seen_at,last_seen_at
       ) VALUES('workers-product','account-1','workers','product','workers','Workers',NULL,'brolly','{}',1,1)`,
    ).run();

    await store.saveAssets([{
      accountId: "account-1",
      family: "workers",
      id: "workers",
      name: "workers",
      nameKind: "named",
      scope: "resource",
      tier: "standard",
      tags: { routeCount: 2 },
    }]);

    const aggregate = await testD1.db.prepare(
      `SELECT display_name,cloudflare_name,name_kind,metadata_json FROM resources WHERE id='workers-product'`,
    ).first<{ display_name: string; cloudflare_name: string | null; name_kind: string; metadata_json: string }>();
    expect(aggregate).toEqual({ display_name: "Workers", cloudflare_name: null, name_kind: "brolly", metadata_json: "{}" });
  });
});
