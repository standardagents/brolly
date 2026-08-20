// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LimitsChartDual, type WindowLimits } from "../src/client/components/limits-chart";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const levels = [
  { id: "warning", label: "Warning", color: "#e79021" },
  { id: "critical", label: "Critical", color: "#c9412c" },
];
const data = {
  scope: "family:workers",
  resourceId: "workers",
  found: true,
  today: "2026-08-18",
  metrics: { requests: { key: "requests", label: "Requests", unit: "requests", billable: true } },
  series: [{ day: "2026-08-18", costUsd: 8, metrics: { requests: 80 }, sealed: true }],
  cycles: [{ startsAt: Date.UTC(2026, 7, 1), endsAt: Date.UTC(2026, 8, 1), approximate: false }],
};
const day: WindowLimits = { cost: { warning: 10, critical: 20 }, usage: { requests: { warning: 100, critical: 200 } } };
const cycle: WindowLimits = { cost: { warning: 300, critical: 600 }, usage: { requests: { warning: 3_000, critical: 6_000 } } };

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("account and product limit fields", () => {
  it("uses value-only chips in rows and labeled bare fields in both open charts", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<>
      <div data-scope="account"><LimitsChartDual data={data} costOnly levels={levels} day={day} cycle={cycle} onChange={() => {}} open="cost" onOpenChange={() => {}} /></div>
      <div data-scope="product"><LimitsChartDual data={data} levels={levels} day={day} cycle={cycle} onChange={() => {}} open="cost" onOpenChange={() => {}} /></div>
    </>));

    const account = container.querySelector<HTMLElement>("[data-scope='account']")!;
    const product = container.querySelector<HTMLElement>("[data-scope='product']")!;
    expect(fieldVariants(account, "chip")).toEqual(fieldVariants(product, "chip"));
    expect(fieldVariants(account, "bare")).toEqual(fieldVariants(product, "bare"));

    for (const chip of container.querySelectorAll("[data-level-field][data-variant='chip']")) {
      expect(chip.querySelector("[data-level-label]")).toBeNull();
      // The diamond is the row-level toggle.
      expect(chip.querySelector("button[role='switch']")).not.toBeNull();
    }
    for (const field of container.querySelectorAll("[data-level-field][data-variant='bare']")) {
      expect(field.querySelector("[data-level-label]")).not.toBeNull();
      expect(field.querySelector("[role='switch']")).not.toBeNull();
    }
  });
});

function fieldVariants(scope: HTMLElement, variant: "chip" | "bare"): string[] {
  return [...new Set([...scope.querySelectorAll(`[data-level-field][data-variant='${variant}']`)].map(field => field.getAttribute("data-variant")!))];
}
