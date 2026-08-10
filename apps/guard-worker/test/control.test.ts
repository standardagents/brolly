import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlAction } from "@standardagents/brolly-core";
import { executeCloudflareControl, executeDeploymentFuseBatch, executeDeploymentFuseControl, executeRuntimeControl, prepareCloudflareControl } from "../src/control.js";
import type { Env } from "../src/env.js";

const env = {
  BROLLY_ACCOUNT_ID: "account-1",
  CLOUDFLARE_OAUTH_TOKEN: "token",
} as Env;

function action(kind: ControlAction["kind"]): ControlAction {
  return {
    id: "action-1",
    incidentId: "incident-1",
    kind,
    state: "approved",
    reason: "test",
    observed: { rows_read: 5_000_000 },
    rollback: {},
    actor: "test",
    createdAt: 1,
    asset: {
      accountId: "account-1",
      family: kind === "pause_consumer" ? "queues" : "workers",
      id: kind === "pause_consumer" ? "jobs" : "runaway-worker",
      scope: "resource",
      tier: "standard",
      tags: kind === "runtime_quarantine" ? { brollyFuse: "true" } : undefined,
    },
  };
}

function response(result: unknown): Response {
  return Response.json({ success: true, result });
}

afterEach(() => vi.unstubAllGlobals());

describe("reversible Cloudflare controls", () => {
  it("coalesces exact-object quarantines into one Worker deployment and clears only the owning action", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    let storedFuse: string | undefined;
    const db = {
      prepare(sql: string) {
        const statement = {
          values: [] as unknown[],
          bind(...values: unknown[]) { this.values = values; return this; },
          async first() {
            if (sql.includes("FROM assets")) return { tier: "standard", metadata_json: "{}" };
            return storedFuse ? { value: storedFuse } : null;
          },
          async run() {
            statements.push({ sql, values: this.values });
            if (sql.includes("INSERT INTO settings")) storedFuse = String(this.values[1]);
            return { meta: { changes: 1 } };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return response({ name: "BROLLY_FUSE", type: "secret_text" });
    }));
    const pending = action("runtime_quarantine");
    pending.asset = { ...pending.asset, family: "durable_objects", id: "a".repeat(64), scope: "object", tags: { cloudflareWorkerScript: "chat-worker", brollyFuse: "true" } };
    const second = { ...pending, id: "action-2", incidentId: "incident-2", asset: { ...pending.asset, id: "b".repeat(64) } };
    const applied = await executeDeploymentFuseBatch({ ...env, DB: db }, [pending, second], "chat-worker");
    expect(applied.manifest.objects?.["a".repeat(64)]).toMatchObject({ actionId: "action-1" });
    expect(applied.manifest.objects?.["b".repeat(64)]).toMatchObject({ actionId: "action-2" });
    expect(calls[0]?.url).toContain("/workers/scripts/chat-worker/secrets");
    const request = JSON.parse(String(calls[0]?.init?.body)) as { name: string; text: string; type: string };
    expect(request).toMatchObject({ name: "BROLLY_FUSE", type: "secret_text" });
    expect(JSON.parse(request.text)).toMatchObject({ version: 1, generation: 1 });
    expect(statements.some(item => item.sql.includes("INSERT INTO settings"))).toBe(true);

    const cleared = await executeDeploymentFuseControl({ ...env, DB: db }, pending, "chat-worker", "resume");
    expect(cleared.manifest.generation).toBe(2);
    expect(cleared.manifest.objects?.["a".repeat(64)]).toBeUndefined();
    expect(cleared.manifest.objects?.["b".repeat(64)]).toMatchObject({ actionId: "action-2" });
    expect(calls).toHaveLength(2);
  });

  it("fails closed before Cloudflare mutation when stored fuse state is corrupt", async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() {
            if (sql.includes("FROM assets")) return { tier: "standard", metadata_json: "{}" };
            if (sql.includes("FROM settings")) return { value: "not-json" };
            return null;
          },
          async run() { return { meta: { changes: 1 } }; },
        };
      },
    } as unknown as D1Database;
    const cloudflare = vi.fn();
    vi.stubGlobal("fetch", cloudflare);
    await expect(executeDeploymentFuseControl({ ...env, DB: db }, action("runtime_quarantine"), "runaway-worker"))
      .rejects.toThrow("corrupt");
    expect(cloudflare).not.toHaveBeenCalled();
  });

  it("rechecks the owning Worker safety tier before deploying a fuse", async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() { return sql.includes("FROM assets") ? { tier: "critical", metadata_json: "{}" } : null; },
          async run() { return { meta: { changes: 1 } }; },
        };
      },
    } as unknown as D1Database;
    const cloudflare = vi.fn();
    vi.stubGlobal("fetch", cloudflare);
    await expect(executeDeploymentFuseControl({ ...env, DB: db }, action("runtime_quarantine"), "runaway-worker"))
      .rejects.toThrow("protected as critical");
    expect(cloudflare).not.toHaveBeenCalled();
  });

  it("captures queue settings separately from the mutating pause", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return response(init?.method === "PATCH" ? { id: "jobs" } : { settings: { delivery_delay: 5, delivery_paused: false } });
    }));
    const pending = action("pause_consumer");
    pending.rollback = await prepareCloudflareControl(env, pending);
    expect(calls).toHaveLength(1);
    await executeCloudflareControl(env, pending);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ settings: { delivery_delay: 5, delivery_paused: true } });
  });

  it("refuses the legacy route-deleting Worker shutdown", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/schedules") && !init?.method) return response({ schedules: [{ cron: "*/5 * * * *" }] });
      if (url.includes("/subdomain") && !init?.method) return response({ enabled: false, previews_enabled: false });
      if (url.includes("/zones?")) return response([]);
      if (url.includes("/workers/domains?") && !init?.method) return response([{ id: "domain-1", hostname: "app.example.com", service: "runaway-worker", zone_id: "zone-1" }]);
      return response({ schedules: [] });
    }));
    const pending = action("disable_trigger");
    pending.rollback = await prepareCloudflareControl(env, pending);
    await expect(executeCloudflareControl(env, pending)).rejects.toThrow("Route-deleting Worker shutdown is retired");
    expect(calls.some(call => call.init?.method === "DELETE")).toBe(false);
  });

  it("signs exact-object runtime controls with a verifiable ES256 token", async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
    let authorization = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ ok: true });
    }));
    const pending = action("runtime_quarantine");
    pending.asset = { ...pending.asset, family: "durable_objects", id: "a".repeat(64), scope: "object", tags: { projectId: "project-1" } };
    await executeRuntimeControl({ ...env, BROLLY_CONTROL_PRIVATE_KEY_JWK: JSON.stringify(privateJwk) }, pending, "https://runtime.example");
    const token = authorization.slice("Brolly ".length);
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ object_id: "a".repeat(64), action_id: "action-1", action: "quarantine" });
    expect(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, keys.publicKey,
      Buffer.from(signature!, "base64url"), new TextEncoder().encode(`${header}.${payload}`),
    )).toBe(true);
  });
});
