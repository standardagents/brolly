// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUsageSeries, type UsageSeriesResponse } from "../src/client/components/limits-chart/api.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("usage series loading", () => {
  it("waits for a product section to become eligible before requesting its history", async () => {
    const response: UsageSeriesResponse = {
      scope: "family:workers",
      resourceId: "resource",
      found: true,
      today: "2026-08-26",
      metrics: {},
      series: [],
      cycles: [],
    };
    const fetch = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetch);
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root!.render(<UsageSeriesHarness enabled={false} />));
    expect(fetch).not.toHaveBeenCalled();
    expect(container.firstElementChild?.getAttribute("data-ready")).toBe("false");

    await act(async () => root!.render(<UsageSeriesHarness enabled />));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.firstElementChild?.getAttribute("data-ready")).toBe("true");
  });
});

function UsageSeriesHarness({ enabled }: { enabled: boolean }) {
  const state = useUsageSeries("session", "family:workers", enabled);
  return <div data-ready={String(Boolean(state.data))} data-loading={String(state.loading)} />;
}
