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
  it("creates, renames, reorders, and deletes any level", async () => {
    const testD1 = createTestD1();
    try {
      const env = testEnv(testD1);
      const initial = await levels(testD1, env);
      expect(initial.map(level => level.label)).toEqual(["Warning", "Critical", "Emergency"]);

      const created = await alertLevelsApiRoute(request("/api/alert-levels", "POST", {
        label: "Low", afterLevelId: initial[0]!.id,
      }), env, "test-actor");
      expect(created?.status).toBe(201);
      const createdLevel = await created!.json() as { level: { id: string; label: string; position: number } };
      expect(createdLevel.level).toMatchObject({ label: "Low", position: 1 });

      const renamed = await alertLevelsApiRoute(request(`/api/alert-levels/${createdLevel.level.id}`, "PATCH", {
        label: "Notice", position: 3,
      }), env, "test-actor");
      expect(renamed?.status).toBe(200);
      const current = await levels(testD1, env);
      expect(current.map(level => level.label)).toEqual(["Warning", "Critical", "Emergency", "Notice"]);
      expect(current.at(-1)).toMatchObject({ id: createdLevel.level.id, position: 3, label: "Notice" });

      const deleted = await alertLevelsApiRoute(request(`/api/alert-levels/${createdLevel.level.id}`, "DELETE"), env, "test-actor");
      expect(deleted?.status).toBe(200);
      expect((await levels(testD1, env)).map(level => level.label)).toEqual(["Warning", "Critical", "Emergency"]);
    } finally {
      testD1.close();
    }
  });

  it("refuses a duplicate name regardless of case", async () => {
    const testD1 = createTestD1();
    try {
      const env = testEnv(testD1);
      const response = await alertLevelsApiRoute(request("/api/alert-levels", "POST", {
        label: "wArNiNg", afterLevelId: null,
      }), env, "test-actor");
      expect(response?.status).toBe(400);
      await expect(response?.json()).resolves.toMatchObject({ error: "Alert level names must be unique" });
    } finally {
      testD1.close();
    }
  });

  it("allows eight levels and rejects a ninth", async () => {
    const testD1 = createTestD1();
    try {
      const env = testEnv(testD1);
      for (let index = 1; index <= 5; index += 1) {
        const response = await alertLevelsApiRoute(request("/api/alert-levels", "POST", {
          label: `Custom ${index}`, afterLevelId: null,
        }), env, "test-actor");
        expect(response?.status).toBe(201);
      }
      expect((await levels(testD1, env))).toHaveLength(8);
      const ninth = await alertLevelsApiRoute(request("/api/alert-levels", "POST", {
        label: "Ninth", afterLevelId: null,
      }), env, "test-actor");
      expect(ninth?.status).toBe(400);
      await expect(ninth?.json()).resolves.toMatchObject({ error: "Brolly supports up to eight alert levels" });
    } finally {
      testD1.close();
    }
  });

  it("refuses deleting the last remaining level", async () => {
    const testD1 = createTestD1();
    try {
      const env = testEnv(testD1);
      const initial = await levels(testD1, env);
      for (const level of initial.slice(1)) {
        expect((await alertLevelsApiRoute(request(`/api/alert-levels/${level.id}`, "DELETE"), env, "test-actor"))?.status).toBe(200);
      }
      const last = (await levels(testD1, env))[0]!;
      const response = await alertLevelsApiRoute(request(`/api/alert-levels/${last.id}`, "DELETE"), env, "test-actor");
      expect(response?.status).toBe(409);
      await expect(response?.json()).resolves.toMatchObject({ error: "At least one alert level must remain" });
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
