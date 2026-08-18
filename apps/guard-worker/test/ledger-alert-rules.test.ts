import { describe, expect, it } from "vitest";
import { ledgerApiRoute } from "../src/ledger-api.js";
import type { Env } from "../src/env.js";
import { createTestD1 } from "./d1.js";

describe("level-backed alert rules", () => {
  it("creates one threshold per current level and limits line edits to threshold state", async () => {
    const testD1 = createTestD1();
    try {
      await testD1.db.prepare(
        `INSERT INTO metric_definitions(id,product_family,metric_key,display_name,unit,aggregation_kind,collector_key,finest_scope,active,catalog_version)
         VALUES('workers:requests','workers','requests','Requests','requests','sum','test','resource',1,'test')`,
      ).run();
      const env = { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1" } as Env;
      const response = await ledgerApiRoute(request("/api/alert-rules", "POST", {
        targetSelector: { productFamily: "workers" }, metricDefinitionId: "workers:requests",
        measurement: "usage", period: "day", enabled: true,
        lines: [
          line("warning", "Warning", 0, 10),
          line("critical", "Critical", 10, 20),
          line("emergency", "Emergency", 20, 30),
        ],
      }), env, "test-actor");
      expect(response?.status).toBe(201);
      const id = (await response!.json() as { id: string }).id;
      const stored = await testD1.db.prepare(
        `SELECT id,level_id,label,priority,threshold_value,action,repeat_interval_ms
         FROM alert_lines WHERE alert_rule_id=?1 ORDER BY priority`,
      ).bind(id).all<Record<string, unknown>>();
      expect(stored.results).toMatchObject([
        { level_id: "warning", label: "Warning", priority: 0, threshold_value: 10, action: "notify", repeat_interval_ms: null },
        { level_id: "critical", label: "Critical", priority: 10, threshold_value: 20, action: "notify", repeat_interval_ms: null },
        { level_id: "emergency", label: "Emergency", priority: 20, threshold_value: 30, action: "notify", repeat_interval_ms: null },
      ]);

      const lineId = String(stored.results[0]!.id);
      const changed = await ledgerApiRoute(request(`/api/alert-lines/${lineId}`, "PUT", {
        thresholdValue: 12, enabled: false, label: "Ignored", action: "quarantine", repeatIntervalMs: 60_000,
      }), env, "test-actor");
      expect(changed?.status).toBe(200);
      await expect(testD1.db.prepare(
        `SELECT label,threshold_value,action,repeat_interval_ms,enabled FROM alert_lines WHERE id=?1`,
      ).bind(lineId).first()).resolves.toMatchObject({
        label: "Warning", threshold_value: 12, action: "notify", repeat_interval_ms: null, enabled: 0,
      });
    } finally {
      testD1.close();
    }
  });

  it("rejects a rule that omits a current alert level", async () => {
    const testD1 = createTestD1();
    try {
      await testD1.db.prepare(
        `INSERT INTO metric_definitions(id,product_family,metric_key,display_name,unit,aggregation_kind,collector_key,finest_scope,active,catalog_version)
         VALUES('workers:requests','workers','requests','Requests','requests','sum','test','resource',1,'test')`,
      ).run();
      const response = await ledgerApiRoute(request("/api/alert-rules", "POST", {
        targetSelector: { productFamily: "workers" }, metricDefinitionId: "workers:requests",
        measurement: "usage", period: "day", lines: [line("warning", "Warning", 0, 10)],
      }), { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1" } as Env, "test-actor");
      expect(response?.status).toBe(400);
      await expect(response?.json()).resolves.toMatchObject({ error: "Every current alert level needs a threshold" });
    } finally {
      testD1.close();
    }
  });
});

function line(levelId: string, label: string, priority: number, thresholdValue: number) {
  return { levelId, label, priority, thresholdValue, color: "#f59e0b", action: "notify", repeatIntervalMs: null, enabled: true };
}

function request(path: string, method: string, body: unknown): Request {
  return new Request(`https://brolly.test${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
