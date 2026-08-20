// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RiskToleranceStep } from "../src/client/onboarding/RiskToleranceStep";
import type { AlertLevel, Policy } from "../src/client/types";
import { pointer } from "./pointer";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const LEVELS: AlertLevel[] = [
  { id: "warn", position: 0, label: "Warn", entries: [] },
  { id: "critical", position: 1, label: "Critical", entries: [] },
  { id: "emergency", position: 2, label: "Emergency", entries: [] },
];

const INITIAL_POLICY: Policy = {
  version: "test",
  accountDailySpend: { warn: 5, critical: 10, emergency: 20 },
  familyDailySpend: {},
  assetDailySpend: {},
  thresholds: [],
  riskTolerance: {
    preset: "balanced",
    percentOfTypical: { warn: 90, critical: 200, emergency: 300 },
    baseline: { computedAt: 1, windowDays: 90 },
  },
};

let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    scope: "account",
    resourceId: "account",
    found: true,
    today: "2026-08-18",
    metrics: {},
    series: [
      { day: "2026-08-16", costUsd: 8, metrics: {}, sealed: true },
      { day: "2026-08-17", costUsd: 10, metrics: {}, sealed: true },
      { day: "2026-08-18", costUsd: 12, metrics: {}, sealed: false },
    ],
    cycles: [{ startsAt: Date.UTC(2026, 7, 1), endsAt: Date.UTC(2026, 8, 1), approximate: false }],
  }), { headers: { "content-type": "application/json" } })));
  Object.assign(SVGElement.prototype, {
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
    releasePointerCapture: vi.fn(),
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function Harness() {
  const [policy, setPolicy] = useState(INITIAL_POLICY);
  return <div data-preset={policy.riskTolerance?.preset} data-values={JSON.stringify(policy.riskTolerance?.percentOfTypical)}>
    <RiskToleranceStep token="test" policy={policy} levels={LEVELS} setPolicy={setPolicy} />
  </div>;
}

describe("RiskToleranceStep", () => {
  it("renders one slider per level, presets, and account-spend readouts", async () => {
    await render();
    expect(document.querySelectorAll("[role='slider']")).toHaveLength(3);
    expect(document.querySelector("[role='slider']")?.getAttribute("aria-orientation")).toBe("horizontal");
    expect(button("Conservative")).toBeTruthy();
    expect(button("Balanced").getAttribute("aria-pressed")).toBe("true");
    expect(button("Growth")).toBeTruthy();
    expect(document.body.textContent).toContain("$9.00");
  });

  it("moves every level when a preset is selected", async () => {
    await render();
    await act(async () => { button("Growth").click(); });
    const state = document.querySelector("[data-preset]")!;
    expect(state.getAttribute("data-preset")).toBe("growth");
    expect(JSON.parse(state.getAttribute("data-values")!)).toEqual({ warn: 100, critical: 300, emergency: 500 });
    expect([...document.querySelectorAll("[role='slider']")].map(element => element.getAttribute("aria-valuenow")))
      .toEqual(["100", "300", "500"]);
  });

  it("marks the selection Custom when a slider is dragged", async () => {
    await render();
    const slider = document.querySelector("[role='slider']")!;
    await act(async () => {
      pointer(slider, "pointerdown", { clientX: 300 });
      pointer(slider, "pointermove", { clientX: 340 });
      pointer(slider, "pointerup", { clientX: 340 });
    });
    expect(document.querySelector("[data-preset]")?.getAttribute("data-preset")).toBe("custom");
  });

  it("supports chart-style keyboard changes on sliders and fields", async () => {
    await render();
    const slider = document.querySelector("[role='slider']")!;
    await act(async () => slider.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true })));
    expect(Number(slider.getAttribute("aria-valuenow"))).toBeGreaterThan(90);
    const field = document.querySelector("input[aria-label='Warn percent of typical']")!;
    const before = Number((field as HTMLInputElement).value);
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(Number((field as HTMLInputElement).value)).toBeGreaterThan(before);
  });
});

async function render(): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness />);
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(element => element.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
