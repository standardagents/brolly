import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRetentionMaintenance } from "../src/retention.js";
import { createTestD1, type TestD1 } from "./d1.js";

describe("D1 retention maintenance", () => {
  let d1: TestD1;

  beforeEach(() => { d1 = createTestD1(); });
  afterEach(() => d1.close());

  it("records unknown capacity without pruning when the runtime denies page metrics", async () => {
    const db = {
      prepare(sql: string) {
        if (sql.startsWith("PRAGMA ")) {
          return { first: async () => { throw new Error("not authorized: SQLITE_AUTH"); } } as D1PreparedStatement;
        }
        return d1.db.prepare(sql);
      },
      batch(statements: D1PreparedStatement[]) { return d1.db.batch(statements); },
    } as D1Database;

    const result = await runRetentionMaintenance(db, "account-1", undefined, Date.UTC(2026, 7, 25), "UTC");
    const incident = await d1.db.prepare(
      `SELECT action,target FROM audit_log WHERE action='d1.capacity.unavailable'`,
    ).first<{ action: string; target: string }>();

    expect(result).toMatchObject({ usedBytes: null, pressure: null, backfillPaused: null, prunedRows: 0 });
    expect(incident).toEqual({ action: "d1.capacity.unavailable", target: "capacity-unavailable:2026-08-25" });
  });
});
