import { describe, expect, it } from "vitest";
import { alertLevelsApiRoute } from "../src/alert-levels.js";
import { notificationApiRoute } from "../src/notification-api.js";
import type { Env } from "../src/env.js";
import { createTestD1, type TestD1 } from "./d1.js";

const credentialKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function testEnv(testD1: TestD1): Env {
  return { DB: testD1.db, BROLLY_ACCOUNT_ID: "account-1", BROLLY_CREDENTIAL_KEY: credentialKey };
}

function request(path: string, method: string, body?: unknown): Request {
  return new Request(`https://brolly.test${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function levels(testD1: TestD1, env: Env): Promise<Array<{ id: string; label: string; position: number; entries: Array<Record<string, unknown>> }>> {
  const response = await alertLevelsApiRoute(request("/api/alert-levels", "GET"), env, "test-actor");
  const body = await response!.json() as { levels: Array<{ id: string; label: string; position: number; entries: Array<Record<string, unknown>> }> };
  return body.levels;
}

async function addWebhookTarget(testD1: TestD1, env: Env): Promise<string> {
  const response = await notificationApiRoute(request("/api/targets", "POST", {
    kind: "webhook", label: "Operations", config: { url: "https://alerts.example.com/brolly" },
  }), env, "test-actor");
  expect(response?.status).toBe(200);
  return (await response!.json() as { id: string }).id;
}

describe("alert level API", () => {
  it("renames and reorders the three fixed levels", async () => {
    const testD1 = createTestD1();
    try {
      const env = testEnv(testD1);
      const initial = await levels(testD1, env);
      expect(initial.map(level => level.label)).toEqual(["Warning", "Critical", "Emergency"]);

      const renamed = await alertLevelsApiRoute(request(`/api/alert-levels/${initial[0]!.id}`, "PATCH", {
        label: "Notice", position: 2,
      }), env, "test-actor");
      expect(renamed?.status).toBe(200);
      const current = await levels(testD1, env);
      expect(current.map(level => level.label)).toEqual(["Critical", "Emergency", "Notice"]);
      expect(current.at(-1)).toMatchObject({ id: initial[0]!.id, position: 2, label: "Notice" });
    } finally {
      testD1.close();
    }
  });

  it("refuses a duplicate name regardless of case", async () => {
    const testD1 = createTestD1();
    try {
      const env = testEnv(testD1);
      const initial = await levels(testD1, env);
      const response = await alertLevelsApiRoute(request(`/api/alert-levels/${initial[1]!.id}`, "PATCH", {
        label: "wArNiNg",
      }), env, "test-actor");
      expect(response?.status).toBe(400);
      await expect(response?.json()).resolves.toMatchObject({ error: "Alert level names must be unique" });
    } finally {
      testD1.close();
    }
  });

  it("refuses adding or removing levels", async () => {
    const testD1 = createTestD1();
    try {
      const env = testEnv(testD1);
      const initial = await levels(testD1, env);
      const created = await alertLevelsApiRoute(request("/api/alert-levels", "POST", {
        label: "Low", afterLevelId: null,
      }), env, "test-actor");
      expect(created?.status).toBe(405);
      await expect(created?.json()).resolves.toMatchObject({ error: "Brolly uses exactly 3 alert levels" });
      const deleted = await alertLevelsApiRoute(request(`/api/alert-levels/${initial[2]!.id}`, "DELETE"), env, "test-actor");
      expect(deleted?.status).toBe(405);
      expect((await levels(testD1, env)).map(level => level.label)).toEqual(["Warning", "Critical", "Emergency"]);
    } finally {
      testD1.close();
    }
  });

  it("validates channel intervals and cascades target deletion to entries", async () => {
    const testD1 = createTestD1();
    try {
      const env = testEnv(testD1);
      const warning = (await levels(testD1, env))[0]!;
      const targetId = await addWebhookTarget(testD1, env);
      const entry = await alertLevelsApiRoute(request(`/api/alert-levels/${warning.id}/entries`, "POST", {
        kind: "channel", targetId, repeatIntervalMs: 15 * 60_000,
      }), env, "test-actor");
      expect(entry?.status).toBe(201);
      const entryBody = await entry!.json() as { entry: { targetId: string; repeatIntervalMs: number } };
      expect(entryBody.entry).toMatchObject({ targetId, repeatIntervalMs: 15 * 60_000 });

      const invalid = await alertLevelsApiRoute(request(`/api/alert-levels/${warning.id}/entries`, "POST", {
        kind: "channel", targetId, repeatIntervalMs: 1234,
      }), env, "test-actor");
      expect(invalid?.status).toBe(400);
      await expect(invalid?.json()).resolves.toMatchObject({ error: "Invalid repeat interval" });

      const removedTarget = await notificationApiRoute(request(`/api/targets/${targetId}`, "DELETE"), env, "test-actor");
      expect(removedTarget?.status).toBe(200);
      expect((await levels(testD1, env))[0]!.entries).toEqual([]);
    } finally {
      testD1.close();
    }
  });
});
