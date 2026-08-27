import { afterEach, describe, expect, it, vi } from "vitest";
import { RunBudget } from "@standardagents/brolly-core";
import { HistoricalAnalyticsClient, HistoricalRateLimitError } from "../src/historical-analytics.js";
import type { Env } from "../src/env.js";

const env = { BROLLY_ACCOUNT_ID: "account-1" } as Env;
const DAY_MS = 86_400_000;

afterEach(() => vi.unstubAllGlobals());

describe("historical Analytics collection", () => {
  it("uses exact-zone account-based requests and reports an absent zone node", async () => {
    let request: Request | undefined;
    const rateBudget = { admit: vi.fn(async () => undefined), pauseUntil: vi.fn() };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return Response.json({ data: { viewer: { zones: [] } } });
    }));
    const zoneId = "a".repeat(32);
    const client = new HistoricalAnalyticsClient(
      env,
      new RunBudget(),
      undefined,
      async () => "token",
      undefined,
      { accountBasedRateLimit: true, rateBudget },
    );

    const result = await client.collect({
      dataset: "httpRequestsAdaptiveGroups",
      startsAt: Date.UTC(2026, 7, 15),
      endsAt: Date.UTC(2026, 7, 16),
      maxPageSize: 10_000,
      zoneIds: [zoneId],
    });

    const body = await request!.clone().json() as { query: string; variables: Record<string, unknown> };
    expect(request!.headers.get("x-rate-limit-type")).toBe("account-based");
    expect(body.query).toContain("zoneTag: $zone");
    expect(body.query).not.toContain("zoneTag_in");
    expect(body.variables.zone).toBe(zoneId);
    expect(rateBudget.admit).toHaveBeenCalledWith({ kind: "zone", zoneId }, 1);
    expect(result).toMatchObject({
      complete: false,
      rows: 0,
      zoneGaps: [{ zoneId, state: "unavailable" }],
    });
  });

  it.each([
    ["HTTP 429", () => Response.json({ errors: [{ message: "too many requests" }] }, { status: 429 })],
    ["GraphQL budget error", () => Response.json({ errors: [{ message: "query budget exceeded", extensions: { code: "budget" } }] })],
  ])("classifies %s as a resumable rate limit", async (_name, response) => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    const client = new HistoricalAnalyticsClient(env, new RunBudget(), undefined, async () => "token");

    await expect(client.collect({
      dataset: "workersInvocationsAdaptive",
      startsAt: Date.UTC(2026, 7, 15),
      endsAt: Date.UTC(2026, 7, 16),
      maxPageSize: 10_000,
    })).rejects.toBeInstanceOf(HistoricalRateLimitError);
  });

  it("normalizes a multi-day Worker response into distinct daily samples", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { viewer: { accounts: [{
      workersInvocationsAdaptive: [
        { dimensions: { date: "2026-08-15", scriptName: "checkout" }, sum: { requests: 10, cpuTimeUs: 1_000 } },
        { dimensions: { date: "2026-08-16", scriptName: "checkout" }, sum: { requests: 20, cpuTimeUs: 2_000 } },
      ],
    }] } } })));
    const client = new HistoricalAnalyticsClient(env, new RunBudget(), undefined, async () => "token");

    const result = await client.collect({
      dataset: "workersInvocationsAdaptive",
      startsAt: Date.UTC(2026, 7, 15),
      endsAt: Date.UTC(2026, 7, 17),
      maxPageSize: 10_000,
    });

    expect(result).toMatchObject({ complete: true, rows: 2 });
    expect(result.samples.filter(sample => sample.metric === "requests").map(sample => ({
      start: sample.start,
      end: sample.end,
      value: sample.value,
    }))).toEqual([
      { start: Date.UTC(2026, 7, 15), end: Date.UTC(2026, 7, 15) + DAY_MS, value: 10 },
      { start: Date.UTC(2026, 7, 16), end: Date.UTC(2026, 7, 16) + DAY_MS, value: 20 },
    ]);
  });

  it("marks a range incomplete when a dataset reaches its returned row limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { viewer: { accounts: [{
      workersInvocationsAdaptive: [
        { dimensions: { date: "2026-08-15", scriptName: "one" }, sum: { requests: 1, cpuTimeUs: 1 } },
        { dimensions: { date: "2026-08-15", scriptName: "two" }, sum: { requests: 1, cpuTimeUs: 1 } },
      ],
    }] } } })));
    const client = new HistoricalAnalyticsClient(env, new RunBudget(), undefined, async () => "token");

    const result = await client.collect({
      dataset: "workersInvocationsAdaptive",
      startsAt: Date.UTC(2026, 7, 15),
      endsAt: Date.UTC(2026, 7, 16),
      maxPageSize: 2,
    });

    expect(result.complete).toBe(false);
    expect(new Set(result.coverage.map(item => item.state))).toEqual(new Set(["delayed"]));
  });
});

describe("historical Analytics capability discovery", () => {
  it("isolates an account dataset that makes a combined settings query fail", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body);
      requests.push(body);
      if (body.includes("workersInvocationsAdaptive")) {
        return Response.json({ errors: [{ message: "workersInvocationsAdaptive is not authorized" }] });
      }
      const settings: Record<string, ReturnType<typeof setting>> = {};
      if (body.includes("durableObjectsInvocationsAdaptiveGroups")) settings.durableObjectsInvocationsAdaptiveGroups = setting();
      return Response.json({ data: { viewer: { accounts: [{ settings }] } } });
    }));
    const client = new HistoricalAnalyticsClient(env, new RunBudget(), undefined, async () => "token", async () => []);

    const capabilities = await client.discoverCapabilities();

    expect(capabilities.find(item => item.dataset === "workersInvocationsAdaptive")?.state).toBe("permission_denied");
    expect(capabilities.find(item => item.dataset === "durableObjectsInvocationsAdaptiveGroups")?.state).toBe("healthy");
    expect(requests.length).toBeGreaterThan(1);
  });

  it("isolates a zone dataset that makes a combined settings query fail", async () => {
    const zoneId = "a".repeat(32);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body);
      if (body.includes("httpRequestsAdaptiveGroups")) {
        return Response.json({ errors: [{ message: "httpRequestsAdaptiveGroups is not authorized" }] });
      }
      const settings: Record<string, ReturnType<typeof setting>> = {};
      if (body.includes("emailSendingAdaptiveGroups")) settings.emailSendingAdaptiveGroups = setting();
      return Response.json({ data: { viewer: { zones: [{ zoneTag: zoneId, settings }] } } });
    }));
    const client = new HistoricalAnalyticsClient(env, new RunBudget(), undefined, async () => "token", async () => [zoneId]);

    const capabilities = await client.discoverCapabilities();

    expect(capabilities.find(item => item.dataset === "httpRequestsAdaptiveGroups" && item.zoneId === zoneId)?.state).toBe("permission_denied");
    expect(capabilities.find(item => item.dataset === "emailSendingAdaptiveGroups" && item.zoneId === zoneId)?.state).toBe("healthy");
  });

  it("isolates a denied zone during product collection and preserves valid zone rows", async () => {
    const validZone = "1".repeat(32);
    const deniedZone = "2".repeat(32);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { zones?: string[] } };
      const zones = body.variables?.zones ?? [];
      if (zones.includes(deniedZone)) return Response.json({ errors: [{ message: `zone ${deniedZone} is not authorized` }] });
      return Response.json({ data: { viewer: { zones: zones.map(zoneTag => ({ zoneTag, httpRequestsAdaptiveGroups: [{ dimensions: { date: "2026-08-15" }, count: 7 }] })) } } });
    }));
    const client = new HistoricalAnalyticsClient(env, new RunBudget(), undefined, async () => "token");

    const result = await client.collect({
      dataset: "httpRequestsAdaptiveGroups",
      startsAt: Date.UTC(2026, 7, 15),
      endsAt: Date.UTC(2026, 7, 16),
      maxPageSize: 10_000,
      zoneIds: [validZone, deniedZone],
    });

    expect(result.rows).toBe(1);
    expect(result.samples).toHaveLength(2);
    expect(result.complete).toBe(false);
    expect(result.coverage.every(item => item.state === "permission_denied")).toBe(true);
    expect(result.coverage[0]?.detail).toContain(deniedZone);
    expect(result.zoneGaps).toMatchObject([{ zoneId: deniedZone, state: "permission_denied" }]);
  });

  it("keeps zone data requests inside Cloudflare's ten-zone scope limit", async () => {
    const zoneIds = Array.from({ length: 12 }, (_, index) => (index + 1).toString(16).padStart(32, "0"));
    const requests: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { zones?: string[] } };
      const zones = body.variables?.zones ?? [];
      requests.push(zones);
      return Response.json({ data: { viewer: { zones: zones.map(zoneTag => ({ zoneTag, httpRequestsAdaptiveGroups: [] })) } } });
    }));
    const client = new HistoricalAnalyticsClient(env, new RunBudget(), undefined, async () => "token");

    const result = await client.collect({
      dataset: "httpRequestsAdaptiveGroups",
      startsAt: Date.UTC(2026, 7, 15),
      endsAt: Date.UTC(2026, 7, 16),
      maxPageSize: 10_000,
      zoneIds,
    });

    expect(result.complete).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests.every(zones => zones.length <= 10)).toBe(true);
  });

  it("does not amplify a transient zone request failure through isolation retries", async () => {
    const zoneIds = ["1".repeat(32), "2".repeat(32)];
    const fetch = vi.fn(async () => Response.json({ errors: [{ message: "temporary service failure" }] }, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const client = new HistoricalAnalyticsClient(env, new RunBudget(), undefined, async () => "token");

    await expect(client.collect({
      dataset: "httpRequestsAdaptiveGroups",
      startsAt: Date.UTC(2026, 7, 15),
      endsAt: Date.UTC(2026, 7, 16),
      maxPageSize: 10_000,
      zoneIds,
    })).rejects.toThrow("temporary service failure");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps zone batches bounded and isolates an unauthorized zone as a coverage gap", async () => {
    const zoneIds = Array.from({ length: 12 }, (_, index) => (index + 1).toString(16).padStart(32, "0"));
    const unauthorized = zoneIds[4]!;
    const requestedZoneBatches: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { variables?: { zones?: string[] } };
      const zones = request.variables?.zones;
      if (!zones) return Response.json({ data: { viewer: { accounts: [{ settings: {} }] } } });
      requestedZoneBatches.push(zones);
      if (zones.includes(unauthorized)) {
        return Response.json({ errors: [{ message: `zones [${unauthorized}] are not authorized` }] });
      }
      return Response.json({ data: { viewer: { zones: zones.map(zoneTag => ({
        zoneTag,
        settings: {
          httpRequestsAdaptiveGroups: setting(),
          emailSendingAdaptiveGroups: setting(),
          emailRoutingAdaptiveGroups: setting(),
        },
      })) } } });
    }));
    const client = new HistoricalAnalyticsClient(
      env,
      new RunBudget(),
      undefined,
      async () => "token",
      async () => zoneIds,
    );

    const capabilities = await client.discoverCapabilities();
    const zoneCapabilities = capabilities.filter(item => item.root === "zone");

    expect(requestedZoneBatches.every(batch => batch.length <= 10)).toBe(true);
    expect(zoneCapabilities.filter(item => item.zoneId === unauthorized)).toHaveLength(4);
    expect(new Set(zoneCapabilities.filter(item => item.zoneId === unauthorized).map(item => item.state))).toEqual(new Set(["permission_denied"]));
    expect(zoneCapabilities.filter(item => item.zoneId !== unauthorized && item.enabled)).toHaveLength(11 * 3);
  });
});

function setting() {
  return { enabled: true, maxDuration: 2_592_000, maxPageSize: 10_000, notOlderThan: 2_592_000 };
}
