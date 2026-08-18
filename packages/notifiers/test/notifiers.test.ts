import { describe, expect, it } from "vitest";
import type { Incident } from "@standardagents/brolly-core";
import { notify, type NotificationTarget } from "../src/index.js";

const incident: Incident = {
  id: "incident", key: "incident", asset: {
    accountId: "account", family: "workers", id: "worker", name: "Worker",
    scope: "resource", tier: "standard",
  },
  metric: "requests", severity: "emergency", observed: 10, threshold: 5,
  reason: "limit crossed", action: "notify", status: "open",
  firstSeen: 1, lastSeen: 1, occurrences: 1,
};

describe("notification requests", () => {
  it("blocks redirects and carries an optional generic webhook bearer token", async () => {
    let captured: RequestInit | undefined;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init;
      return new Response("ok", { status: 200 });
    };
    const target: NotificationTarget = {
      id: "webhook", kind: "webhook", enabled: true,
      url: "https://alerts.example.test/brolly", token: "secret",
    };
    await expect(notify(target, incident, fetcher as typeof fetch)).resolves.toMatchObject({ ok: true });
    expect(captured?.redirect).toBe("error");
    expect(new Headers(captured?.headers).get("authorization")).toBe("Bearer secret");
  });

  it("blocks redirects for Twilio delivery", async () => {
    let captured: RequestInit | undefined;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init;
      return new Response("ok", { status: 200 });
    };
    await notify({
      id: "sms", kind: "twilio", enabled: true, accountSid: "AC1", token: "secret",
      from: "+15550000000", to: "+15551111111",
    }, incident, fetcher as typeof fetch);
    expect(captured?.redirect).toBe("error");
  });

  it("builds a Cloudflare Email request and accepts queued delivery", async () => {
    let requestUrl: RequestInfo | URL | undefined;
    let captured: RequestInit | undefined;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = input;
      captured = init;
      return new Response(JSON.stringify({ result: { delivered: [], queued: ["owner@example.com"], permanent_bounces: [] } }), { status: 200 });
    };
    await expect(notify({
      id: "cloudflare", kind: "cloudflare_email", enabled: true,
      accountId: "account/123", token: "email-token", from: "alerts@example.com", to: "owner@example.com",
    }, incident, fetcher as typeof fetch)).resolves.toMatchObject({ ok: true, status: 200 });
    expect(String(requestUrl)).toBe("https://api.cloudflare.com/client/v4/accounts/account%2F123/email/sending/send");
    expect(new Headers(captured?.headers).get("authorization")).toBe("Bearer email-token");
    expect(captured?.redirect).toBe("error");
    expect(JSON.parse(String(captured?.body))).toMatchObject({
      from: "alerts@example.com", to: ["owner@example.com"], text: expect.stringContaining("limit crossed"),
    });
  });

  it("treats a Cloudflare Email permanent bounce as a failed delivery", async () => {
    const fetcher = async () => new Response(JSON.stringify({ result: {
      delivered: [], queued: [], permanent_bounces: ["owner@example.com"],
    } }), { status: 200 });
    await expect(notify({
      id: "cloudflare", kind: "cloudflare_email", enabled: true,
      accountId: "account", token: "email-token", from: "alerts@example.com", to: "owner@example.com",
    }, incident, fetcher as typeof fetch)).resolves.toMatchObject({
      ok: false, status: 200, error: expect.stringContaining("permanently bounced"),
    });
  });

  it("refuses generic webhook delivery to private and local addresses", async () => {
    let calls = 0;
    const fetcher = async () => { calls += 1; return new Response("ok"); };
    for (const url of [
      "https://127.0.0.1/hook",
      "https://169.254.169.254/hook",
      "https://[fd00::1]/hook",
      "https://service.local/hook",
    ]) {
      await expect(notify({ id: url, kind: "webhook", enabled: true, url }, incident, fetcher as typeof fetch))
        .resolves.toMatchObject({ ok: false, error: expect.stringContaining("private network") });
    }
    expect(calls).toBe(0);
  });
});
