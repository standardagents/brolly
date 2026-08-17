import { afterEach, describe, expect, it, vi } from "vitest";
import { RunBudget } from "@standardagents/brolly-core";
import { CloudflareClient } from "../src/cloudflare.js";
import type { Env } from "../src/env.js";

const env = { BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "token" } as Env;

afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare durable object telemetry", () => {
  it("collects 20,000 active objects in two stable 10,000-row pages", async () => {
    let calls = 0;
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      bodies.push(String(init?.body));
      const offset = (calls - 1) * 10_000;
      const rowsRead = Array.from({ length: 10_000 }, (_, index) => ({
        dimensions: { namespaceId: "namespace-1", objectId: String(offset + index).padStart(64, "0") },
        sum: { rowsRead: 1 },
      }));
      return Response.json({ data: { viewer: { accounts: [{ rowsRead }] } } });
    }));

    const result = await new CloudflareClient(env, new RunBudget()).durableObjectUsagePaged(0, 300_000, { expectedActiveObjects: 20_000 });

    expect(calls).toBe(2);
    expect(result).toMatchObject({ complete: true, pages: 2, continuation: null });
    expect(result.samples).toHaveLength(20_000);
    expect(bodies[0]).toContain("limit: 10000");
    expect(bodies[0]).toContain("dimensions_objectId_ASC");
    expect(bodies[1]).toContain('"rowsReadCursor":"0000000000000000000000000000000000000000000000000000000000009999"');
  });

  it("unions the top objects for reads, writes, and requests", async () => {
    const group = (id: string, rowsRead: number, rowsWritten: number, requests: number) => ({
      dimensions: { namespaceId: "namespace-1", objectId: id }, sum: { rowsRead, rowsWritten, requests },
    });
    let requestBody = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = String(init?.body);
      return Response.json({ success: true, data: { viewer: { accounts: [{
        byRowsRead: [group("read-heavy", 5_000_000, 1, 2)],
        byRowsWritten: [group("write-heavy", 4, 25_000, 3)],
        byRequests: [group("request-heavy", 5, 6, 1_000_000)],
      }] } } });
    }));
    const result = await new CloudflareClient(env, new RunBudget()).durableObjectUsage(0, 300_000);
    expect(new Set(result.samples.map(sample => sample.asset.id))).toEqual(new Set(["read-heavy", "write-heavy", "request-heavy"]));
    expect(result.coverage.map(item => item.metric)).toEqual([
      "requests",
      "duration_gb_seconds",
      "incoming_websocket_messages",
      "rows_read",
      "rows_written",
      "kv_read_units",
      "kv_write_units",
      "kv_delete_requests",
      "sql_storage_bytes",
      "kv_storage_bytes",
    ]);
    expect(result.samples.find(sample => sample.asset.id === "read-heavy" && sample.metric === "rows_read")?.value).toBe(5_000_000);
    expect(result.samples.find(sample => sample.asset.id === "request-heavy" && sample.metric === "requests")?.value).toBe(1_000_000);
    expect(requestBody).toContain("durableObjectsPeriodicGroups");
    expect(requestBody).toContain("durableObjectsInvocationsAdaptiveGroups");
    expect(requestBody).toContain("sum_rowsRead_DESC");
    expect(requestBody).toContain("sum_rowsWritten_DESC");
    expect(requestBody).toContain("sum_requests_DESC");
    expect(requestBody).toContain("objectId type");
    expect(requestBody).toContain("sum_duration_DESC");
    expect(requestBody).toContain("sum_inboundWebsocketMsgCount_DESC");
    expect(requestBody).toContain("sum_storageReadUnits_DESC");
    expect(requestBody).toContain("sum_storageWriteUnits_DESC");
    expect(requestBody).toContain("sum_storageDeletes_DESC");
    expect(requestBody).toContain("durableObjectsSqlStorageGroups");
    expect(requestBody).toContain("durableObjectsStorageGroups");
  });

  it("prices every billable Durable Objects meter exposed by analytics", async () => {
    const object = (id: string, sum: Record<string, number>, type?: string) => ({ dimensions: { namespaceId: "namespace-1", objectId: id, type }, sum });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, data: { viewer: { accounts: [{
      byRequests: [object("object-1", { requests: 1_000_000 }, "http")],
      byDuration: [object("object-1", { duration: 1_000_000 })],
      byIncomingWebsocketMessages: [object("object-1", { inboundWebsocketMsgCount: 20_000_000 })],
      byRowsRead: [object("object-1", { rowsRead: 1_000_000 })],
      byRowsWritten: [object("object-1", { rowsWritten: 1_000_000 })],
      byStorageReadUnits: [object("object-1", { storageReadUnits: 1_000_000 })],
      byStorageWriteUnits: [object("object-1", { storageWriteUnits: 1_000_000 })],
      byStorageDeletes: [object("object-1", { storageDeletes: 1_000_000 })],
      sqlStorage: [{ dimensions: { namespaceId: "namespace-1" }, max: { storedBytes: 1_000_000_000 } }],
      kvStorage: [{ max: { storedBytes: 1_000_000_000 } }],
    }] } } })));

    const result = await new CloudflareClient(env, new RunBudget()).durableObjectUsage(0, 300_000);
    const byMetric = new Map(result.samples.map(sample => [sample.metric, sample]));
    expect(byMetric.get("requests")?.estimatedCostUsd).toBeCloseTo(0.15);
    expect(byMetric.get("duration_gb_seconds")?.estimatedCostUsd).toBeCloseTo(12.5);
    expect(byMetric.get("incoming_websocket_messages")?.estimatedCostUsd).toBeCloseTo(0.15);
    expect(byMetric.get("rows_read")?.estimatedCostUsd).toBeCloseTo(0.001);
    expect(byMetric.get("rows_written")?.estimatedCostUsd).toBeCloseTo(1);
    expect(byMetric.get("kv_read_units")?.estimatedCostUsd).toBeCloseTo(0.2);
    expect(byMetric.get("kv_write_units")?.estimatedCostUsd).toBeCloseTo(1);
    expect(byMetric.get("kv_delete_requests")?.estimatedCostUsd).toBeCloseTo(1);
    expect(byMetric.get("sql_storage_bytes")?.asset.scope).toBe("namespace");
    expect(byMetric.get("kv_storage_bytes")?.asset.scope).toBe("account");
  });

  it("applies WebSocket request conversion to hibernation invocations", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, data: { viewer: { accounts: [{
      byRequests: [{ dimensions: { namespaceId: "namespace-1", objectId: "object-1", type: "hibernation" }, sum: { requests: 20_000_000 } }],
    }] } } })));
    const result = await new CloudflareClient(env, new RunBudget()).durableObjectUsage(0, 300_000);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]).toMatchObject({ metric: "incoming_websocket_messages", value: 20_000_000 });
    expect(result.samples[0]?.estimatedCostUsd).toBeCloseTo(0.15);
  });

  it("walks bounded inventory pages without treating discovery as usage coverage", async () => {
    vi.stubGlobal("fetch", vi.fn(async (urlValue: string) => {
      const url = new URL(urlValue);
      if (url.pathname.endsWith("/workers/scripts")) {
        const page = Number(url.searchParams.get("page") ?? "1");
        return Response.json({ success: true, result: [{ id: `worker-${page}` }], result_info: { page, per_page: 1, total_pages: 2 } });
      }
      if (url.pathname.endsWith("/workers/durable_objects/namespaces")) {
        return Response.json({ success: true, result: [{ id: "namespace-1", name: "Rooms", script: "worker-1", class: "Room", use_sqlite: true }], result_info: { page: 1, per_page: 100, total_pages: 1 } });
      }
      return Response.json({ success: true, result: [], result_info: { page: 1, per_page: 100, total_pages: 1 } });
    }));
    const result = await new CloudflareClient(env, new RunBudget()).inventory();
    expect(result.assets.filter(asset => asset.family === "workers").map(asset => asset.id)).toEqual(["worker-1", "worker-2"]);
    expect(result.assets.find(asset => asset.id === "namespace-1")?.tags).toEqual({ cloudflareWorkerScript: "worker-1", durableObjectClass: "Room", durableObjectStorage: "SQLite" });
    expect(result.coverage.find(item => item.family === "workers")).toMatchObject({ metric: "asset_inventory", state: "healthy" });
  });

  it("collects independent asset families concurrently", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return Response.json({ success: true, result: [], result_info: { page: 1, per_page: 100, total_pages: 1 } });
    }));
    await new CloudflareClient(env, new RunBudget()).inventory();
    expect(peakInFlight).toBeGreaterThan(1);
  });
});

describe("Cloudflare Worker telemetry", () => {
  it("collects and prices per-script requests and CPU time", async () => {
    let requestBody = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = String(init?.body);
      return Response.json({ success: true, data: { viewer: { accounts: [{
        byRequests: [{ dimensions: { scriptName: "checkout" }, sum: { requests: 1_000_000 } }],
        byCpu: [{ dimensions: { scriptName: "checkout" }, sum: { cpuTimeUs: 1_000_000_000 } }],
      }] } } });
    }));
    const result = await new CloudflareClient(env, new RunBudget()).workerUsage(0, 300_000);
    expect(result.samples.find(sample => sample.metric === "requests")).toMatchObject({ asset: { id: "checkout", scope: "resource" }, value: 1_000_000, estimatedCostUsd: 0.3 });
    expect(result.samples.find(sample => sample.metric === "cpu_ms")).toMatchObject({ value: 1_000_000, estimatedCostUsd: 0.02 });
    expect(result.coverage.find(item => item.metric === "cache_requests")).toMatchObject({
      state: "unavailable",
      detail: expect.stringContaining("complete per-Worker data Cloudflare provides"),
    });
    expect(requestBody).toContain("workersInvocationsAdaptive");
    expect(requestBody).toContain("dimensions_scriptName_ASC");
    expect(requestBody).toContain("scriptName_gt");
  });
});

describe("Cloudflare product dataset discovery", () => {
  it("maps account and zone dataset settings to registered product collectors", async () => {
    let query = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname.endsWith("/zones")) {
        return Response.json({ success: true, result: [{ id: "zone-1" }], result_info: { page: 1, total_pages: 1 } });
      }
      query = String(init?.body);
      return Response.json({ data: { viewer: {
        accounts: [{ settings: {
          d1AnalyticsAdaptiveGroups: { enabled: true, availableFields: ["rowsRead"], notOlderThan: 7_776_000, maxPageSize: 10_000 },
        } }],
        zones: [{ settings: {
          emailSendingAdaptiveGroups: { enabled: true, availableFields: ["datetime"], notOlderThan: 2_592_000, maxPageSize: 10_000 },
        } }],
      } } });
    }));

    const result = await new CloudflareClient(env, new RunBudget()).analyticsCapabilities();

    expect(query).toContain("queueMessageOperationsAdaptiveGroups");
    expect(query).toContain("containersUsageAdaptiveGroups");
    expect(query).toContain("emailSendingAdaptiveGroups");
    expect(query).toContain("zoneTag_in: $zones");
    expect(result.find(item => item.dataset === "d1AnalyticsAdaptiveGroups")).toMatchObject({ collectorKey: "graphql:d1", available: true, retentionDays: 90 });
    expect(result.find(item => item.dataset === "emailSendingAdaptiveGroups")).toMatchObject({ collectorKey: "graphql:email", available: true, retentionDays: 30 });
  });
});

describe("Cloudflare billing telemetry", () => {
  it("uses the authoritative daily usage endpoint with explicit date bounds", async () => {
    const billingEnv = { ...env, CLOUDFLARE_BILLING_TOKEN: "cfut_test_billing_token_value" } as Env;
    let requestedUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requestedUrl = url;
      return Response.json({ success: true, result: [{
        BilledCost: 0.75,
        ChargePeriodStart: "2026-08-12T00:00:00Z",
        ChargePeriodEnd: "2026-08-13T00:00:00Z",
        ConsumedQuantity: 150_000,
        ConsumedUnit: "Count",
        EffectiveCost: 0.75,
        ListCost: 0.75,
        x_BillableMetricId: "workers_standard_requests",
        x_BillableMetricName: "Workers Standard Requests",
        x_ProductFamilyId: "workers",
        x_ProductFamilyName: "Workers",
        x_ZoneId: "zone-1",
        x_ZoneName: "example.com",
      }] });
    }));

    const result = await new CloudflareClient(billingEnv, new RunBudget()).billingUsage(Date.now() - 86_400_000, Date.now());

    expect(new URL(requestedUrl).pathname).toBe("/client/v4/accounts/account-1/billable/usage");
    expect(new URL(requestedUrl).searchParams.get("from")).toBeTruthy();
    expect(new URL(requestedUrl).searchParams.get("to")).toBeTruthy();
    expect(result?.[0]).toMatchObject({
      x_BillableMetricId: "workers_standard_requests",
      x_BillableMetricName: "Workers Standard Requests",
      x_ProductFamilyId: "workers",
      x_ProductFamilyName: "Workers",
      x_ZoneId: "zone-1",
      BilledCost: 0.75,
    });
  });

  it("falls back to the Billing Read-compatible PayGo endpoint when v2 is restricted", async () => {
    const billingEnv = { ...env, CLOUDFLARE_BILLING_TOKEN: "cfut_test_billing_token_value" } as Env;
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      paths.push(new URL(url).pathname);
      if (paths.length === 1) return Response.json({ success: false, errors: [{ code: 10000, message: "restricted" }] }, { status: 403 });
      return Response.json({ success: true, result: [{
        BilledCost: 0.75, ChargePeriodStart: "2026-08-12T00:00:00Z", ChargePeriodEnd: "2026-08-13T00:00:00Z",
        ConsumedQuantity: 150_000, ConsumedUnit: "Count", ServiceName: "Workers Standard Requests", ServiceFamilyName: "Workers",
      }] });
    }));

    const result = await new CloudflareClient(billingEnv, new RunBudget()).billingUsage(Date.now() - 86_400_000, Date.now());

    expect(paths).toEqual([
      "/client/v4/accounts/account-1/billable/usage",
      "/client/v4/accounts/account-1/billable-usage",
    ]);
    expect(result?.[0]).toMatchObject({ x_BillableMetricId: "workers_standard_requests", x_ProductFamilyId: "workers" });
  });

  it("retries one 429 response after Retry-After", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ errors: [{ message: "rate limited" }] }), {
        status: 429, headers: { "Retry-After": "0" },
      });
      return Response.json({ success: true, result: [] });
    }));

    const billingEnv = { ...env, CLOUDFLARE_BILLING_TOKEN: "cfut_test_billing_token_value" } as Env;
    await new CloudflareClient(billingEnv, new RunBudget()).billingUsage(Date.now() - 86_400_000, Date.now());
    expect(calls).toBe(2);
  });

  it("aligns a billing window to the current cycle start within the 31-day limit", async () => {
    const billingEnv = { ...env, CLOUDFLARE_BILLING_TOKEN: "cfut_test_billing_token_value" } as Env;
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return Response.json({ success: true, result: [{
        BilledCost: 0.75,
        ChargePeriodStart: "2026-08-12T00:00:00Z",
        ChargePeriodEnd: "2026-08-13T00:00:00Z",
        BillingPeriodStart: "2026-08-09T00:00:00Z",
        BillingPeriodEnd: "2026-09-09T00:00:00Z",
        ConsumedQuantity: 1,
        ConsumedUnit: "Count",
        x_BillableMetricId: "workers_standard_requests",
        x_BillableMetricName: "Workers Standard Requests",
        x_ProductFamilyId: "workers",
        x_ProductFamilyName: "Workers",
      }] });
    }));

    await new CloudflareClient(billingEnv, new RunBudget()).billingUsage(
      Date.parse("2026-07-17T00:00:00Z"), Date.parse("2026-08-17T00:00:00Z"),
    );
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]!).searchParams.get("from")).toBe("2026-08-09");
    expect(Date.parse(new URL(urls[1]!).searchParams.get("to")!) - Date.parse(new URL(urls[1]!).searchParams.get("from")!))
      .toBeLessThanOrEqual(31 * 86_400_000);
  });

  it("aligns the Billing Read PayGo fallback to the current cycle start", async () => {
    const billingEnv = { ...env, CLOUDFLARE_BILLING_TOKEN: "cfut_test_billing_token_value" } as Env;
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      if (urls.length === 1) return Response.json({ success: false, errors: [{ message: "restricted" }] }, { status: 403 });
      return Response.json({ success: true, result: [{
        BilledCost: 0.75,
        ChargePeriodStart: "2026-08-12T00:00:00Z",
        ChargePeriodEnd: "2026-08-13T00:00:00Z",
        BillingPeriodStart: "2026-08-09T00:00:00Z",
        BillingPeriodEnd: "2026-09-09T00:00:00Z",
        ConsumedQuantity: 1,
        ConsumedUnit: "Count",
        ServiceName: "Workers Standard Requests",
        ServiceFamilyName: "Workers",
      }] });
    }));

    await new CloudflareClient(billingEnv, new RunBudget()).billingUsage(
      Date.parse("2026-07-17T00:00:00Z"), Date.parse("2026-08-17T00:00:00Z"),
    );
    expect(urls).toHaveLength(3);
    expect(new URL(urls[1]!).searchParams.get("from")).toBe("2026-07-17");
    expect(new URL(urls[2]!).searchParams.get("from")).toBe("2026-08-09");
    expect(new URL(urls[2]!).searchParams.get("to")).toBe("2026-08-17");
  });
});
