import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settings = readFileSync("apps/guard-worker/src/client/pages/SettingsPage.tsx", "utf8");
const worker = readFileSync("apps/guard-worker/src/index.ts", "utf8");
const demo = readFileSync("apps/guard-worker/vite.demo.config.ts", "utf8");

describe("post-onboarding Billing Read settings", () => {
  it("shows status and supports creating, adding, and replacing an account-scoped token", () => {
    expect(settings).toContain("Daily billing access");
    expect(settings).toContain("Create billing token");
    expect(settings).toContain("Create replacement token");
    expect(settings).toContain("Verify and replace");
    expect(settings).toContain("billingTokenTemplateUrl(accountId)");
    expect(settings).toContain('api<BillingAccessStatus>("/api/billing-access"');
    expect(settings).toContain('api("/api/billing-access", token, { method: "PUT"');
    expect(demo).toContain('url.pathname === "/api/billing-access" && get');
  });

  it("exposes only billing credential metadata, never the stored token", () => {
    expect(worker).toContain('billingAccessRoute && request.method === "GET"');
    expect(worker).toContain("billingAccessConfiguration(env)");
  });
});
