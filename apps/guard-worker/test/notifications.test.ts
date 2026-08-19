import { describe, expect, it } from "vitest";
import type { Incident } from "@standardagents/brolly-core";
import { notify } from "@standardagents/brolly-notifiers";
import { openJson } from "../src/credentials.js";
import { notificationApiRoute, validateNotificationConfig, validateProviderConfig } from "../src/notification-api.js";
import type { Env } from "../src/env.js";
import { createTestD1, type TestD1 } from "./d1.js";

const credentialKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const incident: Incident = {
  id: "incident", key: "incident", asset: {
    accountId: "account-1", family: "workers", id: "worker", name: "Worker",
    scope: "resource", tier: "standard",
  },
  metric: "requests", severity: "critical", observed: 10, threshold: 5,
  reason: "limit crossed", action: "notify", status: "open",
  firstSeen: 1, lastSeen: 1, occurrences: 1,
};

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

async function targetConfig(testD1: TestD1, id: string): Promise<Record<string, unknown>> {
  const row = await testD1.db.prepare("SELECT config_json FROM notification_targets WHERE id=?1").bind(id).first<{ config_json: string }>();
  expect(row).not.toBeNull();
  return openJson<Record<string, unknown>>(row!.config_json, credentialKey);
}

describe("notification configuration", () => {
  it("requires webhook URLs for Discord and Slack", () => {
    expect(validateNotificationConfig("discord", {})).toContain("webhook URL");
    expect(validateNotificationConfig("slack", { url: "https://hooks.slack.com/services/example" })).toBeNull();
    expect(validateNotificationConfig("slack", { url: "https://attacker.example/services/example" })).toContain("hooks.slack.com");
    expect(validateNotificationConfig("discord", { url: "http://discord.com/api/webhooks/1/2" })).toContain("HTTPS");
    expect(validateNotificationConfig("discord", { url: "https://discord.com.evil.example/api/webhooks/1/2" })).toContain("discord.com");
  });

  it("requires every Twilio SMS credential", () => {
    expect(validateNotificationConfig("twilio", { accountSid: "AC1", token: "secret", from: "+15550000000" })).toContain("destination");
    expect(validateNotificationConfig("twilio", { accountSid: "AC1", token: "secret", from: "+15550000000", to: "+15551111111" })).toBeNull();
  });

  it("accepts email recipient groups while keeping Twilio single-recipient", () => {
    expect(validateNotificationConfig("resend", { token: "secret", from: "alerts@example.com", to: ["ops@example.com", "finance@example.com"] })).toBeNull();
    expect(validateNotificationConfig("postmark", { token: "secret", from: "alerts@example.com", to: [] })).toContain("recipient");
    expect(validateNotificationConfig("twilio", { accountSid: "AC1", token: "secret", from: "+15550000000", to: ["+15551111111"] })).toContain("destination number");
  });

  it("refuses private generic webhook destinations", () => {
    expect(validateNotificationConfig("webhook", { url: "https://192.168.1.2/hook" })).toContain("private network");
    expect(validateNotificationConfig("webhook", { url: "https://alerts.example.com/hook" })).toBeNull();
  });

  it("never accepts an absent configuration", () => {
    expect(validateNotificationConfig("discord", undefined)).toBe("Notification configuration is required");
  });

  it("validates saved account credentials for each provider kind", () => {
    expect(validateProviderConfig("twilio", { accountSid: "AC1", token: "secret", from: "+15550000000" })).toBeNull();
    expect(validateProviderConfig("twilio", { accountSid: "AC1", token: "secret" })).toContain("from number");
    expect(validateProviderConfig("resend", { token: "secret", from: "alerts@example.com" })).toBeNull();
    expect(validateProviderConfig("postmark", { token: "secret", from: "alerts@example.com" })).toBeNull();
    expect(validateProviderConfig("cloudflare_email", {
      accountId: "account-1", token: "secret", from: "alerts@example.com",
    }, "account-1")).toBeNull();
    expect(validateProviderConfig("cloudflare_email", {
      accountId: "other-account", token: "secret", from: "alerts@example.com",
    }, "account-1")).toContain("connected account");
    expect(validateProviderConfig("discord", { url: "https://discord.com/api/webhooks/1/2" })).toContain("saved account");
  });

  it("rejects an inactive Cloudflare Email API token before saving a target", async () => {
    const testD1 = createTestD1();
    try {
      const response = await notificationApiRoute(request("/api/targets", "POST", {
        kind: "cloudflare_email", label: "Email", provider: { config: {
          accountId: "account-1", token: "inactive-token", from: "alerts@example.com",
        } }, destination: { to: "owner@example.com" },
      }), testEnv(testD1), "test-actor", (async () => Response.json({
        success: true, result: { status: "inactive" },
      })) as typeof fetch);
      expect(response?.status).toBe(400);
      await expect(response?.json()).resolves.toMatchObject({ error: expect.stringContaining("inactive") });
      await expect(testD1.db.prepare("SELECT COUNT(*) AS count FROM notification_targets").first<{ count: number }>())
        .resolves.toMatchObject({ count: 0 });
    } finally {
      testD1.close();
    }
  });

  it("reuses an existing provider when a later target only supplies its destination", async () => {
    const testD1 = createTestD1();
    try {
      const env = testEnv(testD1);
      const first = await notificationApiRoute(request("/api/targets", "POST", {
        kind: "twilio", label: "Primary SMS", provider: { config: {
          accountSid: "AC1", token: "secret", from: "+15550000000",
        } }, destination: { to: "+15551111111" },
      }), env, "test-actor");
      expect(first?.status).toBe(200);

      const second = await notificationApiRoute(request("/api/targets", "POST", {
        kind: "twilio", label: "Backup SMS", destination: { to: "+15552222222" },
      }), env, "test-actor");
      expect(second?.status).toBe(200);
      const secondBody = await second!.json() as { id: string };
      await expect(targetConfig(testD1, secondBody.id)).resolves.toMatchObject({
        accountSid: "AC1", token: "secret", from: "+15550000000", to: "+15552222222",
      });
      const provider = await testD1.db.prepare("SELECT COUNT(*) AS count FROM notification_providers WHERE kind='twilio'").first<{ count: number }>();
      expect(provider?.count).toBe(1);
    } finally {
      testD1.close();
    }
  });

  it("stores separate email groups against one reusable provider", async () => {
    const testD1 = createTestD1();
    try {
      const env = testEnv(testD1);
      const first = await notificationApiRoute(request("/api/targets", "POST", {
        kind: "resend", label: "Operations", provider: { config: {
          token: "secret", from: "alerts@example.com",
        } }, destination: { to: [" ops@example.com ", "finance@example.com", "OPS@example.com"] },
      }), env, "test-actor");
      expect(first?.status).toBe(200);
      const firstId = (await first!.json() as { id: string }).id;

      const second = await notificationApiRoute(request("/api/targets", "POST", {
        kind: "resend", label: "Security", destination: { to: ["security@example.com", "owner@example.com"] },
      }), env, "test-actor");
      expect(second?.status).toBe(200);
      const secondId = (await second!.json() as { id: string }).id;

      await expect(targetConfig(testD1, firstId)).resolves.toMatchObject({ to: ["ops@example.com", "finance@example.com"] });
      await expect(targetConfig(testD1, secondId)).resolves.toMatchObject({ to: ["security@example.com", "owner@example.com"] });
      await expect(testD1.db.prepare("SELECT COUNT(*) AS count FROM notification_providers WHERE kind='resend'").first<{ count: number }>())
        .resolves.toMatchObject({ count: 1 });
    } finally {
      testD1.close();
    }
  });

  it("requires provider credentials for the first provider-backed target", async () => {
    const testD1 = createTestD1();
    try {
      const response = await notificationApiRoute(request("/api/targets", "POST", {
        kind: "twilio", label: "Primary SMS", destination: { to: "+15551111111" },
      }), testEnv(testD1), "test-actor");
      expect(response?.status).toBe(400);
      await expect(response?.json()).resolves.toMatchObject({ error: "Twilio account details are required" });
    } finally {
      testD1.close();
    }
  });

  it("rejects duplicate target labels case-insensitively", async () => {
    const testD1 = createTestD1();
    try {
      const env = testEnv(testD1);
      const body = { kind: "webhook", label: "Operations", config: { url: "https://alerts.example.com/brolly" } };
      expect((await notificationApiRoute(request("/api/targets", "POST", body), env, "test-actor"))?.status).toBe(200);
      const duplicate = await notificationApiRoute(request("/api/targets", "POST", {
        ...body, label: " operations ", config: { url: "https://alerts.example.com/other" },
      }), env, "test-actor");
      expect(duplicate?.status).toBe(400);
      await expect(duplicate?.json()).resolves.toMatchObject({ error: expect.stringContaining("uses this label") });
    } finally {
      testD1.close();
    }
  });

  it("reseals every dependent target when a provider token changes", async () => {
    const testD1 = createTestD1();
    try {
      const env = testEnv(testD1);
      const first = await notificationApiRoute(request("/api/targets", "POST", {
        kind: "twilio", label: "Primary SMS", provider: { config: {
          accountSid: "AC1", token: "old-token", from: "+15550000000",
        } }, destination: { to: "+15551111111" },
      }), env, "test-actor");
      const firstId = (await first!.json() as { id: string }).id;
      const second = await notificationApiRoute(request("/api/targets", "POST", {
        kind: "twilio", label: "Backup SMS", destination: { to: "+15552222222" },
      }), env, "test-actor");
      const secondId = (await second!.json() as { id: string }).id;

      const replaced = await notificationApiRoute(request("/api/providers/twilio", "PATCH", {
        config: { accountSid: "AC1", token: "new-token", from: "+15550000000" },
      }), env, "test-actor");
      expect(replaced?.status).toBe(200);
      await expect(targetConfig(testD1, firstId)).resolves.toMatchObject({ token: "new-token", to: "+15551111111" });
      await expect(targetConfig(testD1, secondId)).resolves.toMatchObject({ token: "new-token", to: "+15552222222" });

      const requests: Request[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        requests.push(new Request(input, init));
        return new Response("ok", { status: 200 });
      };
      for (const id of [firstId, secondId]) {
        const config = await targetConfig(testD1, id);
        await expect(notify({ id, kind: "twilio", enabled: true, ...config } as never, incident, fetcher)).resolves.toMatchObject({ ok: true });
      }
      expect(requests).toHaveLength(2);
      for (const sent of requests) {
        expect(new Headers(sent.headers).get("authorization")).toBe(`Basic ${btoa("AC1:new-token")}`);
      }
    } finally {
      testD1.close();
    }
  });

  it("reseals existing destinations when a new channel changes the account", async () => {
    const testD1 = createTestD1();
    try {
      const env = testEnv(testD1);
      const first = await notificationApiRoute(request("/api/targets", "POST", {
        kind: "twilio", label: "Primary SMS", provider: { config: {
          accountSid: "AC1", token: "old-token", from: "+15550000000",
        } }, destination: { to: "+15551111111" },
      }), env, "test-actor");
      const firstId = (await first!.json() as { id: string }).id;

      await notificationApiRoute(request("/api/targets", "POST", {
        kind: "twilio", label: "Backup SMS", provider: { config: {
          accountSid: "AC2", token: "new-token", from: "+15559999999",
        } }, destination: { to: "+15552222222" },
      }), env, "test-actor");

      await expect(targetConfig(testD1, firstId)).resolves.toMatchObject({
        accountSid: "AC2", token: "new-token", from: "+15559999999", to: "+15551111111",
      });
    } finally {
      testD1.close();
    }
  });

  it("keeps the saved account when a new channel has an invalid destination", async () => {
    const testD1 = createTestD1();
    try {
      const env = testEnv(testD1);
      const first = await notificationApiRoute(request("/api/targets", "POST", {
        kind: "twilio", label: "Primary SMS", provider: { config: {
          accountSid: "AC1", token: "old-token", from: "+15550000000",
        } }, destination: { to: "+15551111111" },
      }), env, "test-actor");
      const firstId = (await first!.json() as { id: string }).id;

      const invalid = await notificationApiRoute(request("/api/targets", "POST", {
        kind: "twilio", label: "Invalid SMS", provider: { config: {
          accountSid: "AC2", token: "new-token", from: "+15559999999",
        } }, destination: { to: "" },
      }), env, "test-actor");

      expect(invalid?.status).toBe(400);
      await expect(targetConfig(testD1, firstId)).resolves.toMatchObject({
        accountSid: "AC1", token: "old-token", from: "+15550000000", to: "+15551111111",
      });
    } finally {
      testD1.close();
    }
  });
});
