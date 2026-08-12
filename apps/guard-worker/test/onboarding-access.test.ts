import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("apps/guard-worker/src/client/onboarding/BudgetWizard.tsx", "utf8");

describe("progressive monitoring-access onboarding", () => {
  it("requires one access check and reveals results and remediation afterward", () => {
    expect(source).toContain("Check monitoring access");
    expect(source).toContain("Check Brolly&apos;s access");
    expect(source).toContain("step === 0 && (!estimates || estimateBusy)");
    expect(source).not.toContain("Skip access check");
    expect(source).not.toContain("Step 1 of 6 · Optional");
    expect(source).toContain("result && <UsageAccessResults");
    expect(source).toContain("analyticsNeedsReconnect &&");
    expect(source).toContain("billingNeedsToken || billingSuccess");
  });

  it("provides a copyable least-privilege Billing Read recipe", () => {
    expect(source).toContain("Least-privilege token recipe");
    expect(source).toContain("Account → Billing → Read");
    expect(source).toContain("Zone permissions: none");
    expect(source).toContain("Copy recipe");
    expect(source).toContain("Verify and save token");
    expect(source).toContain("Billing access failed.");
  });
});
