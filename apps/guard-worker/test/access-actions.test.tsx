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
  it("places billing access context in the billing capability tooltip", async () => {
    await render(<AccessActions accountId="account" families={[]} busy result={null} notice="" error="" token="test"
      billingDialogOpen={false} onCheckComplete={() => {}} onCloseBilling={() => {}} onOpenBilling={() => {}}
      onVerify={() => {}} onVerified={() => {}} />);

    const cards = document.querySelectorAll('[aria-label="Verified Cloudflare permissions"] article');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.querySelector('[role="tooltip"]')).toBeNull();
    expect(cards[1]!.querySelector('[role="tooltip"]')).not.toBeNull();
  });

  it("reports completion after both visible checks resolve", async () => {
    vi.useFakeTimers();
    const onCheckComplete = vi.fn();
    await render(<AccessActions accountId="account" families={[]} busy={false} result={result} notice="" error="" token="test"
      billingDialogOpen={false} onCheckComplete={onCheckComplete} onCloseBilling={() => {}} onOpenBilling={() => {}}
      onVerify={() => {}} onVerified={() => {}} />);

    expect(onCheckComplete).toHaveBeenLastCalledWith(false);
    await act(async () => vi.advanceTimersByTime(1_400));
    expect(onCheckComplete).toHaveBeenLastCalledWith(true);
  });

  it("keeps the billing action disabled until the check completes", async () => {
    await render(<ContinueFooter accessCheckComplete={false} billingConnected={false} busy={false} firstStep onContinue={() => {}} onOpenBilling={() => {}} />);
    expect(document.querySelector<HTMLButtonElement>("[data-billing-access-action]")?.disabled).toBe(true);
  });

  it("places the unknown-plan requirement with the billing capability", async () => {
    vi.useFakeTimers();
    await render(<AccessActions accountId="account" families={[]} planTier="unknown" busy={false} result={result} notice="" error="" token="test"
      billingDialogOpen={false} onCloseBilling={() => {}} onOpenBilling={() => {}}
      onVerify={() => {}} onVerified={() => {}} />);
    await act(async () => vi.advanceTimersByTime(1_400));

    const requirement = document.querySelector("[data-plan-tier-requirement]");
    expect(requirement?.closest("[data-access-capability]")?.getAttribute("data-access-capability")).toBe("billing");
  });
});

async function render(node: React.ReactNode): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
}
