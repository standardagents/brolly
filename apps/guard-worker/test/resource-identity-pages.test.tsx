// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertInstancesPage } from "../src/client/pages/AlertInstancesPage";
import { AssetsPage } from "../src/client/pages/AssetsPage";
import { LimitsPage } from "../src/client/pages/LimitsPage";
import { ResourcesPage } from "../src/client/pages/ResourcesPage";
import { UsagePage } from "../src/client/pages/UsagePage";
import type { AlertInstanceView, DashboardData, LedgerResource } from "../src/client/types";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("real-account resource identity pages", () => {
  it("paginates Resources, keeps raw IDs in code, and copies the canonical ID from the drawer", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => index.toString(16).padStart(64, index % 2 ? "a" : "b"));
    const rows = ids.map(id => ledgerResource(id));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://brolly.test");
      const second = Boolean(url.searchParams.get("cursor"));
      return json({ resources: second ? rows.slice(100) : rows.slice(0, 100), families: ["durable_objects"], nextCursor: second ? null : "page-2" });
    }));

    await render(<ResourcesPage token="token" onNavigate={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(100));
    assertRawHexOnlyInCode();
    await act(async () => clickButton("Load more resources"));
    await waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(101));

    await act(async () => clickButton("Details"));
    const fullId = document.querySelector("[aria-modal='true'] code")?.textContent;
    expect(fullId).toBe(ids[0]);
    await act(async () => clickButton("Copy ID"));
    expect(writeText).toHaveBeenCalledWith(ids[0]);
  });

  it("renders Usage identities without exposing a raw 64-hex text label", async () => {
    const resource = ledgerResource("c".repeat(64));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://brolly.test");
      if (url.pathname === "/api/usage") return json({ resource, metricDefinitions: [], metricId: null, period: "day", points: [], oldestRetainedAt: null, freshnessAt: null });
      return json({ resources: [resource], families: ["durable_objects"], nextCursor: null });
    }));

    await render(<UsagePage token="token" />);
    await waitFor(() => expect(document.querySelector("[data-identity-kind='id_only'] code")).not.toBeNull());
    assertRawHexOnlyInCode();
  });

  it("renders Assets with a supplied parent namespace name", async () => {
    const id = "d".repeat(64);
    vi.stubGlobal("fetch", vi.fn(async () => json({ assets: [{
      accountId: "account-1", family: "durable_objects", id, parentId: "namespace-1", parentName: "AgentThread",
      name: null, scope: "object", tier: "standard", tags: {}, discoveredAt: 1, seenAt: 2, incidentCount: 0, lastSignalAt: 3,
    }], nextCursor: null })));

    await render(<AssetsPage data={dashboardData} token="token" onNavigate={() => {}} onBudgets={() => {}} />);
    await waitFor(() => expect(document.body.textContent).toContain("AgentThread"));
    expect(document.querySelector("[data-identity-kind='id_only'] code")?.textContent).toContain("dddddddd…dddddd");
    assertRawHexOnlyInCode();
  });

  it("renders Alert targets through the shared ID-only treatment", async () => {
    const id = "e".repeat(64);
    const instance: AlertInstanceView = {
      id: "alert-1", alertRuleId: "rule-1", alertLineId: "line-1", targetResourceId: "resource-1",
      periodStartAt: 1, periodEndAt: 2, observedValue: 2, thresholdValue: 1, evidence: {}, dataQuality: "complete",
      status: "open", firstBreachedAt: 1, lastBreachedAt: 2, nextNotificationAt: null, notificationCount: 1,
      acknowledgedAt: null, acknowledgedBy: null, linkedActionId: null, historical: 0, metricDefinitionId: "durable_objects:requests",
      label: "Warning", color: "#f59e0b", priority: 0, cloudflareName: null, nameKind: "id_only",
      resourceType: "durable_objects:object", productFamily: "durable_objects", cloudflareId: id,
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://brolly.test");
      return url.pathname === "/api/alert-levels"
        ? json({ levels: [{ id: "warning", position: 0, label: "Warning", entries: [] }] })
        : json({ instances: [instance] });
    }));

    await render(<AlertInstancesPage token="token" />);
    await waitFor(() => expect(document.querySelector("[data-identity-kind='id_only'] code")).not.toBeNull());
    assertRawHexOnlyInCode();
  });

  it("searches the limit target picker and submits the canonical resource ID", async () => {
    const canonicalId = "f".repeat(64);
    const target = { ...ledgerResource(canonicalId), productFamily: "workers", resourceType: "workers:resource", parentIdentity: null };
    const initial = { ...target, id: "account-resource", productFamily: "account", resourceType: "account", cloudflareId: "account-1", cloudflareName: "Cloudflare account", nameKind: "brolly" as const };
    let submitted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://brolly.test");
      if (url.pathname === "/api/alert-rules" && init?.method === "POST") {
        submitted = JSON.parse(String(init.body));
        return json({ ok: true });
      }
      if (url.pathname === "/api/alert-rules") return json({ rules: [] });
      if (url.pathname === "/api/ledger/resources") return json({ resources: url.searchParams.get("q") ? [target] : [initial], nextCursor: null });
      if (url.pathname === "/api/metric-definitions") return json({ metricDefinitions: [{ id: "workers:requests", productFamily: "workers", metricKey: "requests", displayName: "Requests", unit: "requests", aggregationKind: "sum", billingMapping: null, collectorKey: "graphql:workers", finestScope: "resource", active: true }] });
      if (url.pathname === "/api/alert-levels") return json({ levels: [{ id: "warning", position: 0, label: "Warning", entries: [] }] });
      if (url.pathname === "/api/dashboard") return json({ planTier: "paid" });
      return json({});
    }));

    await render(<LimitsPage token="token" />);
    await waitFor(() => expect([...document.querySelectorAll("button")].some(item => item.textContent?.includes("New limit"))).toBe(true));
    await act(async () => clickButton("New limit"));
    const search = document.querySelector<HTMLInputElement>("input[role='combobox']")!;
    changeInput(search, canonicalId.slice(-6));
    await waitFor(() => {
      const code = document.querySelector("[role='option'] code");
      expect(code).not.toBeNull();
      expect(code!.textContent).toContain("ffffffff…ffffff");
    });
    await act(async () => (document.querySelector("[role='option']") as HTMLButtonElement).click());
    await act(async () => clickButton("Create limit"));
    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted).toMatchObject({ targetResourceId: target.id });
  });
});

function ledgerResource(id: string): LedgerResource {
  return {
    id: `resource:${id}`, accountId: "account-1", parentResourceId: "namespace-resource", productFamily: "durable_objects",
    resourceType: "durable_objects:object", cloudflareId: id, cloudflareName: null, nameKind: "id_only",
    parentIdentity: { cloudflareId: "namespace-1", cloudflareName: "AgentThread", nameKind: "named", resourceType: "durable_objects:namespace", productFamily: "durable_objects" },
    firstSeenAt: 1, lastSeenAt: 2, lastActiveAt: 3, coverageStatus: "complete", controlCapability: "runtime_fuse",
    runtimeFuseStatus: "verified", autoQuarantinePolicy: "inherit", tier: "standard", excluded: false, metadata: {},
    childCount: 0, usageUpdatedAt: 3, oldestDay: "2026-08-01", openAlerts: 0,
  };
}

const dashboardData = {
  summary: { assets: 1 },
  policy: { assetDailySpend: {}, familyDailySpend: {} },
  assets: { families: [{ family: "durable_objects", label: "Durable Objects", assets: 1, gaps: 0 }], tiers: { unclassified: 0 } },
} as unknown as DashboardData;

async function render(node: React.ReactNode): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { assertion(); return; }
    catch (error) {
      failure = error;
      await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 2)); });
    }
  }
  throw failure;
}

function clickButton(label: string): void {
  const button = [...document.querySelectorAll("button")].find(item => item.textContent?.includes(label));
  if (!button) throw new Error(`Missing button: ${label}`);
  (button as HTMLButtonElement).click();
}

function changeInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function assertRawHexOnlyInCode(): void {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (/[a-f0-9]{64}/i.test(node.textContent ?? "")) expect((node.parentElement as Element | null)?.closest("code")).not.toBeNull();
    node = walker.nextNode();
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
