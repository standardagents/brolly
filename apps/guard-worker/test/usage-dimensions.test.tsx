// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LimitsChart } from "../src/client/components/limits-chart/LimitsChart";
import { DimensionRows, type DimensionSummary } from "../src/client/components/limits-chart/UsageDimensions";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const levels = [
  { id: "warn", label: "Warn", color: "#e79021" },
  { id: "critical", label: "Critical", color: "#c9412c" },
];
const series = [{ day: "2026-08-17", value: 4 }, { day: "2026-08-18", value: 5 }];
const dimensions: DimensionSummary[] = [{ id: "requests", label: "Requests", unit: "requests", cycleToDate: 9, total: 9, series }];

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function Harness() {
  const [enabled, setEnabled] = useState<Record<string, Record<string, boolean>>>({ requests: {} });
  const values = { requests: { warn: 10, critical: 20 } };
  return <DimensionRows
    dimensions={dimensions}
    levels={levels}
    values={values}
    selected="requests"
    onSelect={() => {}}
    levelEnabled={enabled}
    onToggleLevel={(id, levelId, next) => setEnabled(current => ({ ...current, [id]: { ...current[id], [levelId]: next } }))}
    renderChart={() => <LimitsChart kind="usage" unit="requests" window="day" series={series} today="2026-08-18"
      levels={levels} value={values.requests} levelEnabled={enabled.requests} onChange={() => {}} />}
  />;
}

describe("dimension level fields", () => {
  it("toggles a level off and back on while the expanded chart follows", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<Harness />); });
    expect(container.querySelectorAll("[data-limits-chart] [role='slider']")).toHaveLength(2);

    const disable = container.querySelector("input[role='switch'][aria-label='Use Warn level']") as HTMLInputElement;
    await act(async () => disable.click());
    expect(container.querySelectorAll("[data-limits-chart] [role='slider']")).toHaveLength(1);
    expect(disable.checked).toBe(false);

    const enable = container.querySelector("input[role='switch'][aria-label='Use Warn level']") as HTMLInputElement;
    await act(async () => enable.click());
    expect(container.querySelectorAll("[data-limits-chart] [role='slider']")).toHaveLength(2);
  });
});
