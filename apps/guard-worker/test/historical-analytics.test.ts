import { afterEach, describe, expect, it, vi } from "vitest";
import { RunBudget } from "@standardagents/brolly-core";
import { HistoricalAnalyticsClient } from "../src/historical-analytics.js";
import type { Env } from "../src/env.js";

const env = { BROLLY_ACCOUNT_ID: "account-1" } as Env;
const DAY_MS = 86_400_000;

afterEach(() => vi.unstubAllGlobals());

describe("historical Analytics collection", () => {
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
    expect(zoneCapabilities.filter(item => item.zoneId === unauthorized)).toHaveLength(3);
    expect(new Set(zoneCapabilities.filter(item => item.zoneId === unauthorized).map(item => item.state))).toEqual(new Set(["permission_denied"]));
    expect(zoneCapabilities.filter(item => item.zoneId !== unauthorized && item.enabled)).toHaveLength(11 * 3);
  });
});

function setting() {
  return { enabled: true, maxDuration: 2_592_000, maxPageSize: 10_000, notOlderThan: 2_592_000 };
}
