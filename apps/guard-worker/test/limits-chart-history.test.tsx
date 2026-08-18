// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LimitsChart } from "../src/client/components/limits-chart/LimitsChart";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const levels = [
  { id: "warning", label: "Warning", color: "#e79021" },
  { id: "critical", label: "Critical", color: "#c9412c" },
];
const series = [{ day: "2026-08-17", value: 4 }, { day: "2026-08-18", value: 5 }];
const initial = { warning: 10, critical: 20 };

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function renderChart(onChange: (value: Record<string, number>) => void, readOnly = false, resetToTolerance?: Record<string, number>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <LimitsChart kind="cost" unit="USD" window="day" series={series} today="2026-08-18"
        levels={levels} value={initial} onChange={onChange} readOnly={readOnly} resetToTolerance={resetToTolerance} />,
    );
  });
  return container;
}

describe("LimitsChart history shortcuts", () => {
  it("undoes and redoes a keyboard slider commit while focus is inside the chart", async () => {
    const onChange = vi.fn();
    const container = await renderChart(onChange);
    const slider = container.querySelector('[role="slider"]') as SVGGElement;
    const chart = container.querySelector("[data-limits-chart]") as HTMLDivElement;

    await act(async () => slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    const committed = onChange.mock.calls.at(-1)?.[0] as Record<string, number>;
    expect(committed.warning).toBeGreaterThan(initial.warning);

    await act(async () => chart.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith(initial);

    await act(async () => chart.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith(committed);
  });

  it("does not handle history shortcuts in read-only mode", async () => {
    const onChange = vi.fn();
    const container = await renderChart(onChange, true);
    const chart = container.querySelector("[data-limits-chart]") as HTMLDivElement;
    await act(async () => chart.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("records Reset to tolerance as one undoable chart change", async () => {
    const onChange = vi.fn();
    const reset = { warning: 15, critical: 35 };
    const container = await renderChart(onChange, false, reset);
    const chart = container.querySelector("[data-limits-chart]") as HTMLDivElement;
    const button = [...container.querySelectorAll("button")].find(element => element.textContent === "Reset to tolerance")!;

    await act(async () => button.click());
    expect(onChange).toHaveBeenLastCalledWith(reset);

    await act(async () => chart.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith(initial);

    await act(async () => chart.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith(reset);
  });
});
