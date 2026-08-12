import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("apps/guard-worker/src/client/onboarding/BudgetWizard.tsx", "utf8");

describe("progressive monitoring-access onboarding", () => {
  it("starts with one bounded check and reveals results and remediation afterward", () => {
    expect(source).toContain("Check monitoring access");
    expect(source).toContain("A safe, bounded monitoring check");
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
