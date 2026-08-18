// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LimitsChartPair } from "../src/client/components/limits-chart/LimitsChartPair";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const levels = [
  { id: "warn", label: "Warn", color: "#e79021" },
  { id: "critical", label: "Critical", color: "#c9412c" },
];
const response = {
  scope: "account",
  resourceId: "account",
  found: true,
  today: "2026-08-18",
  metrics: { requests: { key: "requests", label: "Requests", unit: "requests", billable: true } },
  series: [
    { day: "2026-08-15", costUsd: 10, metrics: { requests: 100 }, sealed: true },
    { day: "2026-08-16", costUsd: 12, metrics: { requests: 120 }, sealed: true },
    { day: "2026-08-17", costUsd: 11, metrics: { requests: 110 }, sealed: true },
    { day: "2026-08-18", costUsd: 1_000, metrics: { requests: 10_000 }, sealed: false },
  ],
  cycles: [{ startsAt: Date.UTC(2026, 7, 1), endsAt: Date.UTC(2026, 8, 1), approximate: false }],
};

let root: Root | null = null;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } })));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function Harness({ initial = {}, window = "day" as "day" | "cycle", daily }: { initial?: Record<string, number>; window?: "day" | "cycle"; daily?: Record<string, number> }) {
  const [cost, setCost] = useState(initial);
  const [usage, setUsage] = useState({ requests: { warn: 150, critical: 300 } });
  const [tolerance, setTolerance] = useState({ warn: 150, critical: 800 });
  return <div data-cost={JSON.stringify(cost)} data-usage={JSON.stringify(usage)}>
    <button type="button" onClick={() => setTolerance({ warn: 250, critical: 3000 })}>Change tolerance</button>
    <LimitsChartPair token="test" scope="account" window={window} levels={levels}
      cost={cost} onCostChange={setCost} usage={usage} onUsageChange={setUsage}
      costFloor={daily} usageFloor={daily ? { requests: daily } : undefined} tolerance={tolerance} />
  </div>;
}

describe("LimitsChartPair tolerance behavior", () => {
  it("seeds an empty chart from tolerance and detaches after values exist", async () => {
    const container = await render(<Harness />);
    await waitFor(() => expect(JSON.parse(container.querySelector("[data-cost]")!.getAttribute("data-cost")!).warn).toBeGreaterThan(0));
    const seeded = container.querySelector("[data-cost]")!.getAttribute("data-cost");
    const savedUsage = container.querySelector("[data-usage]")!.getAttribute("data-usage");
    await act(async () => button(container, "Change tolerance").click());
    expect(container.querySelector("[data-cost]")!.getAttribute("data-cost")).toBe(seeded);
    expect(container.querySelector("[data-usage]")!.getAttribute("data-usage")).toBe(savedUsage);
  });

  it("allows a cycle value below its daily reference and shows the note", async () => {
    const container = await render(<Harness window="cycle" initial={{ warn: 40, critical: 80 }} daily={{ warn: 50, critical: 60 }} />);
    await waitFor(() => expect(container.textContent).toContain("Warn is below its daily limit ($50.00)."));
    const slider = container.querySelector("[data-limits-chart='cost'] [role='slider']") as SVGGElement;
    await act(async () => slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(JSON.parse(container.querySelector("[data-cost]")!.getAttribute("data-cost")!).warn).toBeLessThan(40);
  });

  it("resets one chart to tolerance and restores it with undo", async () => {
    const initial = { warn: 40, critical: 80 };
    const container = await render(<Harness initial={initial} />);
    const chart = container.querySelector("[data-limits-chart='cost']")!;
    await act(async () => button(chart as HTMLElement, "Reset to tolerance").click());
    await waitFor(() => expect(JSON.parse(container.querySelector("[data-cost]")!.getAttribute("data-cost")!)).not.toEqual(initial));
    await act(async () => (chart.querySelector("[aria-label='Undo last limit change']") as HTMLButtonElement).click());
    await waitFor(() => expect(JSON.parse(container.querySelector("[data-cost]")!.getAttribute("data-cost")!)).toEqual(initial));
  });
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(node); await Promise.resolve(); });
  return container;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(element => element.textContent === label);
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { assertion(); return; }
    catch (error) { failure = error; await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
  }
  throw failure;
}
