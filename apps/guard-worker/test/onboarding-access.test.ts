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

  it("keeps sign-out available before onboarding is complete", () => {
    expect(source).toContain("onLogout: () => void");
    expect(source).toContain("title=\"Sign out of Brolly\"");
    expect(source).toContain("<Icon name=\"logout\" /> Sign out");
  });

  it("provides a simple, account-specific Billing Read token handoff", () => {
    expect(source).toContain("Copy Brolly&apos;s token settings");
    expect(source).toContain("Account → Billing → Read");
    expect(source).toContain("Zone permissions: none");
    expect(source).toContain("Copy recipe");
    expect(source).toContain("Open this account&apos;s API Tokens page");
    expect(source).toContain("dash.cloudflare.com/${encodeURIComponent(accountId)}/api-tokens");
    expect(source).toContain("Create Custom Token");
    expect(source).toContain("Continue to summary");
    expect(source).toContain("Verify and save");
    expect(source).toContain("Billing access failed.");
    expect(source).toContain("Add Billing Read below");
    expect(source).toContain("Ready for limits");
    expect(source).toContain("Add exact account totals below");
    expect(source).toContain("complete coverage Cloudflare currently makes available");
    expect(source).toContain("permission denied|access denied|forbidden|unauthorized|authentication|missing required");
    expect(source).not.toContain("/permission|denied|forbidden|auth|missing|403/i");
    expect(source).toContain("Reconnect Cloudflare");
    expect(source).toContain("No action needed.");
  });
});
