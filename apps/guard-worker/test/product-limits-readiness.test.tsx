// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ProductLimitsStep } from "../src/client/onboarding/ProductLimitsStep";
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
    metrics: {},
    series: [],
    cycles: [],
  }));
  vi.stubGlobal("fetch", fetchMock);
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
    await Promise.resolve();
  });

  expect(container.querySelector("[data-product-import-state='ready']")).not.toBeNull();
  expect(container.querySelector<HTMLInputElement>("[role='switch']")?.disabled).toBe(false);
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
  families: [{ family: "workers", label: "Workers", metrics: [], protection: "active" }],
  scopedAssets: [],
};
