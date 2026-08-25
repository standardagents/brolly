// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ChartScaleProvider, LimitsChart } from "../src/client/components/limits-chart";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const levels = [
  { id: "warning", label: "Warning", color: "#e79021" },
  { id: "critical", label: "Critical", color: "#a8232f" },
];
const series = [4, 5, 6, 5, 4, 900].map((value, index) => ({ day: `2026-08-${String(index + 1).padStart(2, "0")}`, value }));

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("chart-pair scale mode", () => {
  it("shows one daily control and updates its daily/cycle pair", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChartScaleProvider initialMode="logarithmic">
        <LimitsChart kind="usage" unit="requests" window="day" series={series} levels={levels}
          value={{ warning: 20, critical: 100 }} onChange={() => {}} />
        <LimitsChart kind="usage" unit="requests" window="cycle" series={series} levels={levels}
          value={{ warning: 20, critical: 100 }} onChange={() => {}} readOnly />
      </ChartScaleProvider>,
    ));

    expect(container.querySelectorAll("[data-chart-scale-toggle]")).toHaveLength(1);
    expect((container.querySelector("[data-chart-scale-toggle]")?.parentElement as HTMLElement).style.marginLeft).toBe("62px");
    expect([...container.querySelectorAll("[data-limits-chart]")].map(chart => chart.getAttribute("data-axis-kind"))).toEqual(["symlog", "symlog"]);

    const linear = container.querySelector("[data-chart-scale-toggle] button") as HTMLButtonElement;
    await act(async () => linear.click());

    expect([...container.querySelectorAll("[data-limits-chart]")].map(chart => chart.getAttribute("data-axis-kind"))).toEqual(["linear", "linear"]);
    expect([...container.querySelectorAll("[data-chart-scale-toggle] button:first-child")].every(button => button.getAttribute("aria-pressed") === "true")).toBe(true);
  });

  it("keeps separate chart pairs independent", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const chart = (window: "day" | "cycle") => <LimitsChart kind="usage" unit="requests" window={window} series={series} levels={levels}
      value={{ warning: 20, critical: 100 }} onChange={() => {}} />;
    await act(async () => root!.render(<>
      <ChartScaleProvider initialMode="logarithmic">{chart("day")}{chart("cycle")}</ChartScaleProvider>
      <ChartScaleProvider initialMode="linear">{chart("day")}{chart("cycle")}</ChartScaleProvider>
    </>));

    const controls = container.querySelectorAll("[data-chart-scale-toggle]");
    expect(controls).toHaveLength(2);
    expect([...container.querySelectorAll("[data-limits-chart]")].map(chart => chart.getAttribute("data-scale-mode"))).toEqual(["logarithmic", "logarithmic", "linear", "linear"]);
    await act(async () => (controls[0]!.querySelector("button") as HTMLButtonElement).click());
    expect([...container.querySelectorAll("[data-limits-chart]")].map(chart => chart.getAttribute("data-scale-mode"))).toEqual(["linear", "linear", "linear", "linear"]);
  });
});
