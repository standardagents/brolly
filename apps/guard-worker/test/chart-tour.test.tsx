// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetWizard } from "../src/client/onboarding/BudgetWizard";
import { ChartTour } from "../src/client/onboarding/ChartTour";
import type { AlertLevel, OnboardingData, Policy } from "../src/client/types";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const levels: AlertLevel[] = [
  { id: "warning", position: 0, label: "Warning", entries: [] },
  { id: "critical", position: 1, label: "Critical", entries: [] },
  { id: "emergency", position: 2, label: "Emergency", entries: [] },
];

const policy: Policy = {
  version: "legacy",
  accountDailySpend: {},
  familyDailySpend: {},
  assetDailySpend: {},
  thresholds: [],
  riskTolerance: {
    preset: "balanced",
    percentOfTypical: { warning: 90, critical: 200, emergency: 300 },
    baseline: { computedAt: 1, windowDays: 90 },
  },
};

let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function renderTour(onDone: () => void, done = false) {
  await act(async () => {
    root!.render(<ChartTour levels={levels} policy={policy} done={done} onDone={onDone} />);
    await Promise.resolve();
  });
}

function stageKey(): string | undefined {
  return container.querySelector<HTMLElement>("[data-tour-stage]")?.dataset.tourStage;
}

async function next() {
  await act(async () => {
    container.querySelector<HTMLButtonElement>("button[data-action='tour-next']")!.click();
    await Promise.resolve();
  });
}

describe("ChartTour", () => {
  it("layers both charts stage by stage over one sample series, with pointer labels", async () => {
    const onDone = vi.fn();
    await renderTour(onDone);
    await waitFor(() => expect(stageKey()).toBe("charts"));
    // Both charts are present from the first stage, with pointer labels and no levels yet.
    expect(container.querySelectorAll("[data-limits-chart]").length).toBe(2);
    expect(container.querySelectorAll("[data-level-line]").length).toBe(0);
    await waitFor(() => expect(container.querySelectorAll("[data-tour-callout]").length).toBeGreaterThan(0));

    await next();
    expect(stageKey()).toBe("levels");
    // Level lines join both charts together, as one group.
    expect(container.querySelectorAll("[data-level-line]").length).toBe(levels.length * 2);

    await next();
    expect(stageKey()).toBe("alerts");
    // Days under every level are washed out; every bar-line intersection gets
    // an alarm bell, and the cycle chart badges where its total crossed a level.
    expect(container.querySelector("[data-crossing-dim]")).not.toBeNull();
    const charts = container.querySelectorAll("[data-limits-chart]");
    expect(charts[0]!.querySelectorAll("[data-alarm-badge]").length).toBeGreaterThan(0);
    expect(charts[1]!.querySelectorAll("[data-alarm-badge]").length).toBeGreaterThan(0);

    await next();
    await waitFor(() => expect(stageKey()).toBe("free"));
    // The free-usage layers join the same charts once the alarms' exit has
    // played out: the sample series never changes.
    await waitFor(() => expect(container.querySelector("[data-free-left]")).not.toBeNull());
    expect(container.querySelector("[data-included-pill]")).not.toBeNull();

    await next();
    expect(stageKey()).toBe("motion");
    // The demonstration is animated: a pointer sprite, no interactive sliders.
    expect(container.querySelector("[data-tour-cursor]")).not.toBeNull();
    expect(container.querySelectorAll("[role='slider']").length).toBe(0);

    expect(onDone).not.toHaveBeenCalled();
    await next();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("plays layer exits in reverse when stepping backward", async () => {
    const onDone = vi.fn();
    await renderTour(onDone);
    await waitFor(() => expect(stageKey()).toBe("charts"));
    await next();
    await next();
    await next();
    expect(stageKey()).toBe("free");
    await waitFor(() => expect(container.querySelector("[data-free-left]")).not.toBeNull());
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[data-action='tour-back']")!.click();
      await Promise.resolve();
    });
    expect(stageKey()).toBe("alerts");
    // The quota layers hold through their reverse sweep and unmount when it
    // completes; only then do the alarms make their entrance.
    expect(container.querySelector("[data-free-left]")).not.toBeNull();
    expect(container.querySelectorAll("[data-alarm-badge]").length).toBe(0);
    expect(container.querySelector("[data-tour-exit]")?.getAttribute("data-tour-exit")).toContain("quota");
    await waitFor(() => expect(container.querySelector("[data-free-left]")).toBeNull());
    await waitFor(() => expect(container.querySelectorAll("[data-alarm-badge]").length).toBeGreaterThan(0));
  });

  it("keeps Back present but disabled on the first stage", async () => {
    const onDone = vi.fn();
    await renderTour(onDone);
    await waitFor(() => expect(stageKey()).toBe("charts"));
    const back = container.querySelector<HTMLButtonElement>("button[data-action='tour-back']")!;
    expect(back.disabled).toBe(true);
    await next();
    expect(container.querySelector<HTMLButtonElement>("button[data-action='tour-back']")!.disabled).toBe(false);
  });

  it("stays replayable once done, without wizard side effects", async () => {
    const onDone = vi.fn();
    await renderTour(onDone, true);
    await waitFor(() => expect(stageKey()).toBe("charts"));
    // Next still walks stages in the done state; the last stage's Next is
    // disabled instead of finishing again.
    await next();
    expect(stageKey()).toBe("levels");
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("BudgetWizard chart tour", () => {
  const data: OnboardingData = {
    accountId: "test-account",
    complete: false,
    policy,
    families: [{ family: "workers", label: "Workers", metrics: ["requests"], protection: "active" }],
    scopedAssets: [],
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://brolly.test");
      if (url.pathname === "/api/usage-series") return json({
        scope: "account", resourceId: "account", found: true, today: "2026-08-20", planTier: "paid", metrics: {},
        series: [{ day: "2026-08-19", costUsd: 10, metrics: {}, sealed: true }, { day: "2026-08-20", costUsd: 12, metrics: {}, sealed: false }],
        cycles: [{ startsAt: Date.UTC(2026, 7, 1), endsAt: Date.UTC(2026, 8, 1), approximate: false }],
      });
      if (url.pathname === "/api/targets") return json({ credentialStorageReady: true, targets: [{ id: "target", kind: "discord", label: "Ops", providerId: null, enabled: true, createdAt: 1, updatedAt: 1, lastDeliveryAt: null, lastDeliveryOk: null, lastDeliveryError: null }] });
      if (url.pathname === "/api/alert-levels") return json({ levels });
      if (url.pathname === "/api/onboarding/ingest") return json({ job: { id: "done", status: "complete", startedAt: 1, updatedAt: 1 }, collectors: [] });
      if (url.pathname === "/api/onboarding/estimates") return json({
        generatedAt: 1, windowStartAt: 1, windowEndAt: 1, cached: true, apiCalls: 0,
        headroom: { warning: 0.25, critical: 0.75, emergency: 1.5 }, account: null, families: {}, assets: {}, unchangedFamilies: [],
        access: {
          workers: { state: "connected", detail: "Connected" },
          durable_objects: { state: "connected", detail: "Connected" },
          billing: { state: "connected", detail: "Connected" },
        },
      });
      return json({ ok: true });
    }));
  });

  it("opens between risk tolerance and account limits, unlocks the account step, and stays in the flow", async () => {
    await act(async () => {
      root!.render(<BudgetWizard data={data} token="test" editing={false} initialStep={3} onLogout={() => {}} onSaved={async () => {}} />);
      await Promise.resolve();
    });
    await waitFor(() => expect(continueButton()).not.toBeNull());
    expect(container.querySelector("[data-chart-tour]")).toBeNull();

    await act(async () => { continueButton()!.click(); await Promise.resolve(); });
    await waitFor(() => expect(container.querySelector("[data-chart-tour]")).not.toBeNull());
    // The account step stays locked behind the guide.
    expect(container.querySelector("section[aria-label='Account limits (locked)']")).not.toBeNull();

    // Walk to the last stage, then finish with "Set your limits".
    for (let step = 0; step < 5; step += 1) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>("[data-chart-tour] button[data-action='tour-next']")!.click();
        await Promise.resolve();
      });
    }
    // The account step unlocks and the guide card remains in the flow.
    await waitFor(() => expect(container.querySelector("section[aria-label='Account limits (locked)']")).toBeNull());
    expect(container.querySelector("[data-chart-tour]")).not.toBeNull();
  });

  function continueButton(): HTMLButtonElement | null {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Continue") ?? null;
  }
});

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { assertion(); return; }
    catch (error) { failure = error; await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); }); }
  }
  throw failure;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
