import { describe, expect, it } from "vitest";
import { billingTokenTemplateUrl } from "../src/client/lib/billing";

describe("billing token template", () => {
  it("opens Cloudflare's prefilled, account-specific Billing Read token form", () => {
    const url = new URL(billingTokenTemplateUrl("account-123"));
    expect(url.origin).toBe("https://dash.cloudflare.com");
    expect(url.pathname).toBe("/profile/api-tokens");
    expect(url.searchParams.get("to")).toBeNull();
    expect(JSON.parse(url.searchParams.get("permissionGroupKeys")!)).toEqual([{ key: "billing", type: "read" }]);
    expect(url.searchParams.get("accountId")).toBe("account-123");
    expect(url.searchParams.get("zoneId")).toBe("all");
    expect(url.searchParams.get("name")).toBe("Brolly Billing Read");
  });
});
