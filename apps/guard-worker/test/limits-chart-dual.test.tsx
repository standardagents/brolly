// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LimitsChartDual, type WindowLimits } from "../src/client/components/limits-chart/LimitsChartDual";

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
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function Harness({ dayCost = {}, cycleCost = {}, costOnly = false, deviated }: { dayCost?: Record<string, number>; cycleCost?: Record<string, number>; costOnly?: boolean; deviated?: ReadonlySet<string> }) {
  const [day, setDay] = useState<WindowLimits>({ cost: dayCost, usage: { requests: { warn: 150, critical: 300 } } });
  const [cycle, setCycle] = useState<WindowLimits>({ cost: cycleCost, usage: {} });
  const [tolerance, setTolerance] = useState({ warn: 150, critical: 800 });
  const [open, setOpen] = useState<string | null>("cost");
  return <div data-day={JSON.stringify(day)} data-cycle={JSON.stringify(cycle)}>
    <button type="button" onClick={() => setTolerance({ warn: 250, critical: 3000 })}>Change tolerance</button>
    <button type="button" onClick={() => setTolerance({ warn: 400, critical: 5000 })}>Change tolerance again</button>
    <button type="button" onClick={() => setDay(current => ({ ...current, cost: { warn: 50, critical: 100 } }))}>Set day</button>
    <LimitsChartDual data={response} levels={levels} day={day} cycle={cycle} costOnly={costOnly}
      onChange={(window, change) => window === "day" ? setDay(change) : setCycle(change)}
      tolerance={tolerance} deviated={deviated} open={open} onOpenChange={setOpen} />
  </div>;
}

describe("LimitsChartDual tolerance behavior", () => {
  it("seeds an empty chart from tolerance while hand-edited maps stay fixed", async () => {
    const container = await render(<Harness />);
    await waitFor(() => expect(readWindow(container, "day").cost.warn).toBeGreaterThan(0));
    const seeded = readWindow(container, "day").cost;
    const savedUsage = readWindow(container, "day").usage;
    await act(async () => button(container, "Change tolerance").click());
    await waitFor(() => expect(readWindow(container, "day").cost.warn).toBeGreaterThan(seeded.warn));
    expect(readWindow(container, "day").usage).toEqual(savedUsage);
  });

  it("seeds the cycle chart from the daily map and never moves it on day changes", async () => {
    const container = await render(<Harness dayCost={{ warn: 40, critical: 80 }} />);
    await waitFor(() => expect(readWindow(container, "cycle").cost).toEqual({ warn: 40 * 31, critical: 80 * 31 }));
    // A hand-set day map leaves the cycle off the tolerance base, so reset is offered.
    const charts = container.querySelectorAll("[data-limits-chart='cost']");
    expect(buttons(charts[1] as HTMLElement, "Reset to tolerance")).toHaveLength(1);
    // Day changes never move the cycle map.
    await act(async () => button(container, "Set day").click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(readWindow(container, "cycle").cost).toEqual({ warn: 40 * 31, critical: 80 * 31 });
    // Reset lands on the tolerance base, not either day map's multiple, and hides.
    await act(async () => button(charts[1] as HTMLElement, "Reset to tolerance").click());
    await waitFor(() => expect(buttons(charts[1] as HTMLElement, "Reset to tolerance")).toHaveLength(0));
    const reset = readWindow(container, "cycle").cost;
    expect(reset).not.toEqual({ warn: 40 * 31, critical: 80 * 31 });
    expect(reset).not.toEqual({ warn: 50 * 31, critical: 100 * 31 });
  });

  it("resets each window to the tolerance base independently: a later day reset never adjusts the cycle", async () => {
    const container = await render(<Harness />);
    await waitFor(() => expect(readWindow(container, "cycle").cost.warn).toBeGreaterThan(0));
    const seededDay = readWindow(container, "day").cost;
    const seededCycle = readWindow(container, "cycle").cost;
    const charts = container.querySelectorAll("[data-limits-chart='cost']");
    const slider = (index: number) => charts[index]!.querySelector("[role='slider']") as SVGGElement;
    // Edit both windows.
    await act(async () => slider(0).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    await act(async () => slider(1).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    // Cycle reset returns to the tolerance base even though the day map is edited.
    await act(async () => button(charts[1] as HTMLElement, "Reset to tolerance").click());
    await waitFor(() => expect(readWindow(container, "cycle").cost).toEqual(seededCycle));
    expect(buttons(charts[1] as HTMLElement, "Reset to tolerance")).toHaveLength(0);
    // Day reset returns the day map without adjusting the cycle map at all.
    await act(async () => button(charts[0] as HTMLElement, "Reset to tolerance").click());
    await waitFor(() => expect(readWindow(container, "day").cost).toEqual(seededDay));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(readWindow(container, "cycle").cost).toEqual(seededCycle);
    expect(buttons(charts[0] as HTMLElement, "Reset to tolerance")).toHaveLength(0);
    expect(buttons(charts[1] as HTMLElement, "Reset to tolerance")).toHaveLength(0);
  });

  it("does not offer reset on the cycle chart after a day-only edit of a tolerance-seeded scope", async () => {
    const container = await render(<Harness />);
    await waitFor(() => expect(readWindow(container, "cycle").cost.warn).toBeGreaterThan(0));
    const seededCycle = readWindow(container, "cycle").cost;
    const charts = container.querySelectorAll("[data-limits-chart='cost']");
    const daySlider = charts[0]!.querySelector("[role='slider']") as SVGGElement;
    await act(async () => daySlider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(readWindow(container, "cycle").cost).toEqual(seededCycle);
    expect(buttons(charts[0] as HTMLElement, "Reset to tolerance")).toHaveLength(1);
    expect(buttons(charts[1] as HTMLElement, "Reset to tolerance")).toHaveLength(0);
  });

  it("moves both unedited charts together on a tolerance change", async () => {
    const container = await render(<Harness />);
    await waitFor(() => expect(readWindow(container, "cycle").cost.warn).toBeGreaterThan(0));
    const seededDay = readWindow(container, "day").cost;
    await act(async () => button(container, "Change tolerance").click());
    await waitFor(() => expect(readWindow(container, "day").cost.warn).toBeGreaterThan(seededDay.warn!));
    const day = readWindow(container, "day").cost;
    await waitFor(() => expect(readWindow(container, "cycle").cost).toEqual({ warn: day.warn! * 31, critical: day.critical! * 31 }));
    const charts = container.querySelectorAll("[data-limits-chart='cost']");
    expect(buttons(charts[0] as HTMLElement, "Reset to tolerance")).toHaveLength(0);
    expect(buttons(charts[1] as HTMLElement, "Reset to tolerance")).toHaveLength(0);
  });

  it("stops following tolerance once either chart is edited until both are reset", async () => {
    const container = await render(<Harness />);
    await waitFor(() => expect(readWindow(container, "cycle").cost.warn).toBeGreaterThan(0));
    const seededDay = readWindow(container, "day").cost;
    const seededCycle = readWindow(container, "cycle").cost;
    expect(seededCycle).toEqual({ warn: seededDay.warn! * 31, critical: seededDay.critical! * 31 });
    // Edit the cycle chart: neither window follows tolerance now.
    const charts = container.querySelectorAll("[data-limits-chart='cost']");
    const slider = charts[1]!.querySelector("[role='slider']") as SVGGElement;
    await act(async () => slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    const editedCycle = readWindow(container, "cycle").cost;
    expect(editedCycle).not.toEqual(seededCycle);
    expect(buttons(charts[1] as HTMLElement, "Reset to tolerance")).toHaveLength(1);
    await act(async () => button(container, "Change tolerance").click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(readWindow(container, "day").cost).toEqual(seededDay);
    expect(readWindow(container, "cycle").cost).toEqual(editedCycle);
    // Reset both: the day chart moves to the new tolerance, then the cycle
    // chart's reset lands on that day map's multiple. After that they follow again.
    await act(async () => button(charts[0] as HTMLElement, "Reset to tolerance").click());
    await waitFor(() => expect(readWindow(container, "day").cost.warn).toBeGreaterThan(seededDay.warn!));
    const day = readWindow(container, "day").cost;
    expect(readWindow(container, "cycle").cost).toEqual(editedCycle);
    await act(async () => button(charts[1] as HTMLElement, "Reset to tolerance").click());
    await waitFor(() => expect(readWindow(container, "cycle").cost).toEqual({ warn: day.warn! * 31, critical: day.critical! * 31 }));
    expect(buttons(charts[0] as HTMLElement, "Reset to tolerance")).toHaveLength(0);
    expect(buttons(charts[1] as HTMLElement, "Reset to tolerance")).toHaveLength(0);
    await act(async () => button(container, "Change tolerance again").click());
    await waitFor(() => expect(readWindow(container, "day").cost.warn).toBeGreaterThan(day.warn!));
    const again = readWindow(container, "day").cost;
    await waitFor(() => expect(readWindow(container, "cycle").cost).toEqual({ warn: again.warn! * 31, critical: again.critical! * 31 }));
  });

  it("allows a cycle value below its daily reference and shows the note", async () => {
    const container = await render(<Harness dayCost={{ warn: 50, critical: 60 }} cycleCost={{ warn: 40, critical: 80 }} />);
    await waitFor(() => expect(container.textContent).toContain("Warn is below its daily limit ($50.00)."));
    const charts = container.querySelectorAll("[data-limits-chart='cost']");
    const slider = charts[1]!.querySelector("[role='slider']") as SVGGElement;
    await act(async () => slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(readWindow(container, "cycle").cost.warn).toBeLessThan(40);
  });

  it("resets one chart to tolerance and restores it with undo", async () => {
    const initial = { warn: 40, critical: 80 };
    const container = await render(<Harness dayCost={initial} />);
    const chart = container.querySelector("[data-limits-chart='cost']")!;
    await act(async () => button(chart as HTMLElement, "Reset to tolerance").click());
    await waitFor(() => expect(readWindow(container, "day").cost).not.toEqual(initial));
    await act(async () => (chart.querySelector("[aria-label='Undo last limit change']") as HTMLButtonElement).click());
    await waitFor(() => expect(readWindow(container, "day").cost).toEqual(initial));
  });

  it("follows a tolerance change without creating an undo step on adhering charts", async () => {
    const container = await render(<Harness />);
    await waitFor(() => expect(readWindow(container, "cycle").cost.warn).toBeGreaterThan(0));
    const seeded = readWindow(container, "day").cost;
    await act(async () => button(container, "Change tolerance").click());
    await waitFor(() => expect(readWindow(container, "day").cost.warn).toBeGreaterThan(seeded.warn!));
    for (const chart of container.querySelectorAll("[data-limits-chart='cost']")) {
      const undo = chart.querySelector("[aria-label='Undo last limit change']") as HTMLButtonElement;
      expect(undo.disabled).toBe(true);
    }
  });

  it("marks deviated rows with the edge glow", async () => {
    const container = await render(<Harness dayCost={{ warn: 40, critical: 80 }} deviated={new Set(["cost"])} />);
    await waitFor(() => expect(container.querySelectorAll("[data-deviated]")).toHaveLength(1));
  });

  it("toggles a level on and off from the row diamond, per window", async () => {
    const container = await render(<Harness dayCost={{ warn: 40, critical: 80 }} cycleCost={{ warn: 400, critical: 800 }} costOnly />);
    const diamonds = [...container.querySelectorAll("[data-level-field][data-variant='chip'] button[role='switch']")];
    expect(diamonds.length).toBe(levels.length * 2);
    await act(async () => (diamonds[0] as HTMLButtonElement).click());
    await waitFor(() => expect(readWindow(container, "day").costLevelEnabled).toEqual({ warn: false }));
    expect(readWindow(container, "cycle").costLevelEnabled).toBeUndefined();
    await act(async () => (diamonds[0] as HTMLButtonElement).click());
    await waitFor(() => expect(readWindow(container, "day").costLevelEnabled).toEqual({ warn: true }));
    // Cycle window diamonds write the cycle map.
    await act(async () => (diamonds[levels.length] as HTMLButtonElement).click());
    await waitFor(() => expect(readWindow(container, "cycle").costLevelEnabled).toEqual({ warn: false }));
  });

  it("opens the day and cycle charts together and supports a cost-only scope", async () => {
    const container = await render(<Harness dayCost={{ warn: 40, critical: 80 }} cycleCost={{ warn: 400, critical: 800 }} costOnly />);
    expect(container.querySelectorAll("[data-limits-chart='cost']")).toHaveLength(2);
    expect(container.textContent).not.toContain("Requests");
    const chips = [...container.querySelectorAll("[data-level-field][data-variant='chip']")];
    expect(chips).toHaveLength(levels.length * 2);
    expect(chips.every(chip => !chip.querySelector("[data-level-label]"))).toBe(true);
    expect(container.querySelectorAll("[data-level-field][data-variant='bare'] [role='switch']")).toHaveLength(levels.length * 2);
  });
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(node); await Promise.resolve(); });
  return container;
}

function readWindow(container: HTMLElement, window: "day" | "cycle"): WindowLimits {
  return JSON.parse(container.querySelector(`[data-${window}]`)!.getAttribute(`data-${window}`)!);
}

function buttons(container: HTMLElement, label: string): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")].filter(element => element.textContent === label);
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
