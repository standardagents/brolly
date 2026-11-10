// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ProductLimitsStep, productCostHistory } from "../src/client/onboarding/ProductLimitsStep";
import type { UsageSeriesResponse } from "../src/client/components/limits-chart/api";
import type { InitialIngestionResponse, OnboardingData, Policy } from "../src/client/types";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("enables a product only after its import reaches a usable terminal state", async () => {
  const fetchMock = vi.fn(async () => Response.json({
    scope: "family:workers",
    resourceId: "workers",
    found: true,
    today: "2026-08-28",
    metrics: { "workers:requests": { key: "requests", label: "Requests", unit: "requests", billable: true } },
    series: [{ day: "2026-08-28", costUsd: 0, metrics: { "workers:requests": 100 }, sealed: false }],
    cycles: [],
  }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("IntersectionObserver", undefined);
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const importing = { state: "importing" as const, percent: 42, errors: 0 };

  await act(async () => {
    root!.render(<Harness readiness={{ workers: importing }} />);
    await Promise.resolve();
  });

  expect(container.querySelector("[data-product-import-state='importing']")).not.toBeNull();
  expect(container.querySelector("[data-product-import-pending]")).not.toBeNull();
  expect(container.querySelector<HTMLInputElement>("[role='switch']")?.disabled).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();

  await act(async () => {
    root!.render(<Harness readiness={{ workers: { state: "ready", percent: 100, errors: 0 } }} />);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

  expect(container.querySelector("[data-product-import-state='ready']")).not.toBeNull();
  expect(container.querySelector<HTMLInputElement>("[role='switch']")?.disabled).toBe(false);
  expect(container.querySelector("[data-product-limit-item='cost']")).not.toBeNull();
  expect(container.querySelector("[data-product-limit-item='workers:requests']")).not.toBeNull();
  expect(container.querySelector("[data-product-family='unknown']")).toBeNull();
  expect(container.querySelector("[data-product-cost-state='measured-zero']")).not.toBeNull();
});

it("distinguishes measured zero cost from days whose cost is unavailable", () => {
  const usage = {
    scope: "family:queues",
    resourceId: "queues",
    found: true,
    fromDay: "2026-08-26",
    today: "2026-08-28",
    metrics: {},
    series: [{ day: "2026-08-28", costUsd: 0, metrics: {}, sealed: true }],
    costCoverage: [
      { fromDay: "2026-08-26", toDay: "2026-08-27", state: "unavailable" },
      { fromDay: "2026-08-28", toDay: "2026-08-28", state: "measured" },
    ],
    cycles: [],
  } satisfies UsageSeriesResponse;

  expect(productCostHistory(usage)).toEqual({
    state: "partial",
    measuredDays: 1,
    missingDays: 2,
    pendingDays: 0,
    partialDays: 0,
    unavailableDays: 2,
    allMeasuredZero: true,
  });
});

it("reports pending cost days as importing", () => {
  const usage = {
    scope: "family:queues",
    resourceId: "queues",
    found: true,
    fromDay: "2026-08-27",
    today: "2026-08-28",
    metrics: {},
    series: [],
    costCoverage: [{ fromDay: "2026-08-27", toDay: "2026-08-28", state: "pending" }],
    cycles: [],
  } satisfies UsageSeriesResponse;

  expect(productCostHistory(usage)).toEqual({
    state: "pending",
    measuredDays: 0,
    missingDays: 2,
    pendingDays: 2,
    partialDays: 0,
    unavailableDays: 0,
    allMeasuredZero: false,
  });
});

function Harness({ readiness }: { readiness: InitialIngestionResponse["readiness"]["products"] }) {
  const [policy, setPolicy] = useState<Policy>(initialPolicy);
  return <ProductLimitsStep
    token="token"
    data={data}
    policy={policy}
    levels={levels}
    setPolicy={setPolicy}
    readiness={readiness}
  />;
}

const levels = [
  { id: "warning", position: 0, label: "Warning", entries: [] },
  { id: "critical", position: 1, label: "Critical", entries: [] },
  { id: "emergency", position: 2, label: "Emergency", entries: [] },
];

const initialPolicy: Policy = {
  version: "test",
  accountDailySpend: {},
  familyDailySpend: {},
  assetDailySpend: {},
  thresholds: [],
  limits: { day: {}, cycle: {} },
};

const data: OnboardingData = {
  accountId: "account-1",
  complete: false,
  policy: initialPolicy,
  families: [
    { family: "workers", label: "Workers", metrics: [], protection: "active" },
    { family: "unknown", label: "Unknown", metrics: [], protection: "monitoring-only" },
  ],
  scopedAssets: [],
};
