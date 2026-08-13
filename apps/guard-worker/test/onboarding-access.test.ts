import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { billingTokenTemplateUrl } from "../src/client/onboarding/BudgetWizard";

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

  it("opens Cloudflare's prefilled, account-specific Billing Read token form", () => {
    const url = new URL(billingTokenTemplateUrl("account-123"));
    expect(url.origin).toBe("https://dash.cloudflare.com");
    expect(url.pathname).toBe("/profile/api-tokens");
    expect(url.searchParams.get("to")).toBeNull();
    expect(JSON.parse(url.searchParams.get("permissionGroupKeys")!)).toEqual([{ key: "billing", type: "read" }]);
    expect(url.searchParams.get("accountId")).toBe("account-123");
    expect(url.searchParams.get("zoneId")).toBe("all");
    expect(url.searchParams.get("name")).toBe("Brolly Billing Read");
    expect(source).toContain("Create the prefilled token in Cloudflare");
    expect(source).toContain("Billing → Read");
    expect(source).toContain("user API token");
    expect(source).toContain("cfut_");
    expect(source).toContain("cfat_");
    expect(source).not.toContain("Copy recipe");
    expect(source).toContain("Create billing token");
    expect(source).toContain("Continue to summary");
    expect(source).toContain("Verify and save");
    expect(source).toContain("Billing access failed.");
    expect(source).toContain("Add Billing Read below");
    expect(source).toContain('workerSetupNeeded ? "Setup needed"');
    expect(source).not.toContain("Ready for limits");
    expect(source).toContain("Add exact account totals below");
    expect(source).toContain("To finish setup, add Billing Read below");
    expect(source).toContain("permission denied|access denied|forbidden|unauthorized|authentication|missing required");
    expect(source).not.toContain("/permission|denied|forbidden|auth|missing|403/i");
    expect(source).toContain("Reconnect Cloudflare");
    expect(source).toContain("No action needed.");
  });
});
