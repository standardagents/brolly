// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetWizard, ContinueFooter } from "../src/client/onboarding/BudgetWizard";
import type { OnboardingData } from "../src/client/types";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const data: OnboardingData = {
  accountId: "test-account",
  complete: true,
  policy: {
    version: "legacy",
    accountDailySpend: { warning: 5, critical: 12, emergency: 25 },
    familyDailySpend: { workers: { warning: 1, critical: 5, emergency: 10 } },
    assetDailySpend: {},
    thresholds: [],
  },
  families: [{ family: "workers", label: "Workers", metrics: ["requests"], protection: "active" }],
  scopedAssets: [],
};

let root: Root | null = null;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "https://brolly.test").pathname;
    if (path === "/api/targets") return json({ credentialStorageReady: true, targets: [{ id: "target", kind: "discord", label: "Ops", providerId: null, enabled: true, createdAt: 1, updatedAt: 1, lastDeliveryAt: null, lastDeliveryOk: null, lastDeliveryError: null }] });
    if (path === "/api/alert-levels") return json({ levels: [
      { id: "warning", position: 0, label: "Warning", entries: [] },
      { id: "critical", position: 1, label: "Critical", entries: [] },
      { id: "emergency", position: 2, label: "Emergency", entries: [] },
    ] });
    if (path === "/api/usage-series") return json({
      scope: "account", resourceId: "account", found: true, today: "2026-08-18",
      metrics: { requests: { key: "requests", label: "Requests", unit: "requests", billable: true } },
      series: [{ day: "2026-08-17", costUsd: 10, metrics: { requests: 100 }, sealed: true }, { day: "2026-08-18", costUsd: 12, metrics: { requests: 120 }, sealed: false }],
      cycles: [{ startsAt: Date.UTC(2026, 7, 1), endsAt: Date.UTC(2026, 8, 1), approximate: false }],
    });
    if (path === "/api/onboarding/ingest") return json({ job: { id: "done", status: "complete", startedAt: 1, updatedAt: 1 }, collectors: [] });
    if (path === "/api/onboarding/estimates") return json({
      generatedAt: 1, windowStartAt: 1, windowEndAt: 1, cached: true, apiCalls: 0,
      headroom: { warning: 0.25, critical: 0.75, emergency: 1.5 }, account: null, families: {}, assets: {}, unchangedFamilies: [],
      access: {
        workers: { state: "connected", detail: "Connected" },
        durable_objects: { state: "connected", detail: "Connected" },
        billing: { state: "connected", detail: "Connected" },
      },
    });
    if (path === "/api/billing-access") return json({ configured: false, source: "none", updatedAt: null });
    return json({ ok: true });
  }));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("BudgetWizard", () => {
  it.each([
    ["free", "Free plans have hard usage caps, so Brolly continues with usage monitoring."],
    ["enterprise", "Enterprise billing reconciliation is unavailable, so Brolly continues with usage monitoring."],
  ] as const)("keeps the first step available for %s accounts without Billing Read", async (planTier, copy) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<ContinueFooter billingConnected={false} billingRequired={false} planTier={planTier} accessCheckComplete busy={false} firstStep onContinue={() => {}} onOpenBilling={() => {}} />);
      await Promise.resolve();
    });
    const button = container.querySelector("button");
    expect(button?.textContent).toContain("Continue to alerts");
    expect(button).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(container.textContent).toContain(copy);
  });

  it("renders risk tolerance between alert levels and the daily and cycle limit steps", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<BudgetWizard data={data} token="test" editing onLogout={() => {}} onSaved={async () => {}} />);
      await Promise.resolve();
    });
    await waitFor(() => expect(container.querySelectorAll("header ol li")).toHaveLength(8));
    expect([...container.querySelectorAll("header ol li")].map(item => (item as HTMLElement).dataset.step)).toEqual([
      "access",
      "alerts",
      "levels",
      "tolerance",
      "account",
      "products",
      "runtime",
      "verify",
    ]);
    // Fixture data (the account name supplied to the wizard) reaches the page.
    expect(container.textContent).toContain("test-account");
  });

  it("saves the balanced risk tolerance for an existing policy", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<BudgetWizard data={data} token="test" editing onLogout={() => {}} onSaved={async () => {}} />);
      await Promise.resolve();
    });
    await waitFor(() => expect(container.querySelector("button[data-action='finish']")).not.toBeNull());
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[data-action='finish']")!.click();
      await Promise.resolve();
    });
    const call = vi.mocked(fetch).mock.calls.find(([input]) => new URL(String(input), "https://brolly.test").pathname === "/api/policy");
    expect(call).toBeTruthy();
    expect(call![1]?.method).toBe("PUT");
    const saved = JSON.parse(String(call![1]?.body));
    expect(saved.policy.riskTolerance).toMatchObject({
      preset: "balanced",
      percentOfTypical: { warning: 90, critical: 200, emergency: 300 },
      baseline: { windowDays: 90 },
    });
    expect(saved.policy.riskTolerance.baseline.computedAt).toBeGreaterThan(0);
  });
});

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { assertion(); return; }
    catch (error) { failure = error; await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
  }
  throw failure;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
