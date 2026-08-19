// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessActions } from "../src/client/onboarding/access";
import { ContinueFooter } from "../src/client/onboarding/BudgetWizard";
import type { OnboardingBudgetEstimates } from "../src/client/types";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

const result: OnboardingBudgetEstimates = {
  generatedAt: 1,
  windowStartAt: 1,
  windowEndAt: 1,
  cached: true,
  apiCalls: 0,
  headroom: { warning: 0.25, critical: 0.75, emergency: 1.5 },
  account: null,
  families: {},
  assets: {},
  unchangedFamilies: [],
  access: {
    workers: { state: "connected", detail: "Connected" },
    durable_objects: { state: "connected", detail: "Connected" },
    billing: { state: "missing", detail: "Not connected" },
  },
};

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("step-one access actions", () => {
  it("reports completion after both visible checks resolve and uses two columns at wide widths", async () => {
    vi.useFakeTimers();
    const onCheckComplete = vi.fn();
    await render(<AccessActions accountId="account" families={[]} busy={false} result={result} notice="" error="" token="test"
      billingDialogOpen={false} onCheckComplete={onCheckComplete} onCloseBilling={() => {}} onOpenBilling={() => {}}
      onVerify={() => {}} onVerified={() => {}} />);

    expect(onCheckComplete).toHaveBeenLastCalledWith(false);
    expect(document.querySelector("[aria-label='Verified Cloudflare permissions']")?.className).toContain("xl:grid-cols-2");
    await act(async () => vi.advanceTimersByTime(1_400));
    expect(onCheckComplete).toHaveBeenLastCalledWith(true);
  });

  it("keeps the billing action disabled until the check completes", async () => {
    await render(<ContinueFooter accessCheckComplete={false} billingConnected={false} busy={false} firstStep onContinue={() => {}} onOpenBilling={() => {}} />);
    expect(button("Grant billing access").disabled).toBe(true);
  });
});

async function render(node: React.ReactNode): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(item => item.textContent?.includes(label));
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
