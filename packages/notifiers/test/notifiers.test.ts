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
