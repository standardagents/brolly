import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshConfiguration } from "../src/configuration.js";
import type { Env } from "../src/env.js";

afterEach(() => vi.unstubAllGlobals());

describe("configuration verification", () => {
  it("independently verifies a configured Worker and its namespace", async () => {
    const settings = new Map<string, string>();
    const assets = [
      { family: "workers", asset_id: "chat-worker", name: "Chat worker", scope: "resource", tier: "standard", metadata_json: JSON.stringify({ brollyFuse: "true", workerScript: "chat-worker" }), seen_at: 100 },
      { family: "durable_objects", asset_id: "namespace-1", name: "Rooms", scope: "namespace", tier: "standard", metadata_json: JSON.stringify({ brollyFuse: "true", workerScript: "chat-worker", cloudflareWorkerScript: "chat-worker", durableObjectClass: "Room", durableObjectStorage: "SQLite" }), seen_at: 100 },
    ];
    const db = {
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        return Promise.all(statements.map(statement => statement.run()));
      },
      prepare(sql: string) {
        const statement = {
          values: [] as unknown[],
          bind(...values: unknown[]) { this.values = values; return this; },
          async all() {
            if (sql.includes("SELECT asset_id FROM assets")) return { results: [{ asset_id: "chat-worker" }], meta: {} };
            if (sql.includes("configuration_verification:%")) return { results: [...settings.entries()].map(([key, value]) => ({ key, value })), meta: {} };
            if (sql.includes("FROM assets")) return { results: assets, meta: {} };
            return { results: [], meta: {} };
          },
          async run() {
            if (sql.includes("INSERT INTO settings")) settings.set(String(this.values[0]), String(this.values[1]));
            return { meta: { changes: 1 } };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    vi.stubGlobal("fetch", vi.fn(async (urlValue: string) => {
      if (urlValue.endsWith("/secrets")) return Response.json({ success: true, result: [{ name: "BROLLY_FUSE", type: "secret_text" }] });
      if (urlValue.endsWith("/deployments")) return Response.json({ success: true, result: { deployments: [{ id: "deployment-1", versions: [{ version_id: "version-1", percentage: 100 }] }] } });
      return new Response(`export const marker = "BROLLY_QUARANTINED";`);
    }));

    const result = await refreshConfiguration({ DB: db, BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env, ["chat-worker"]) as {
      summary: { configuredWorkers: number; configuredNamespaces: number };
      workers: Array<{ status: string; checks: { fuseSecret: { state: string }; runtimeBundle: { state: string } } }>;
    };
    expect(result.summary).toMatchObject({ configuredWorkers: 1, configuredNamespaces: 1 });
    expect(result.workers[0]).toMatchObject({ status: "configured", checks: { fuseSecret: { state: "pass" }, runtimeBundle: { state: "pass" } } });
  });
});
