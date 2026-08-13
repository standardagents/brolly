/**
 * Cloudflare's create-token page, prefilled with the account-scoped Billing
 * Read permission Brolly needs. Lives outside BudgetWizard.tsx so that file
 * exports only components — mixed exports break React Fast Refresh and reset
 * wizard state on every edit.
 */
export function billingTokenTemplateUrl(accountId: string): string {
  const url = new URL("https://dash.cloudflare.com/profile/api-tokens");
  url.searchParams.set("permissionGroupKeys", JSON.stringify([{ key: "billing", type: "read" }]));
  url.searchParams.set("accountId", accountId);
  url.searchParams.set("zoneId", "all");
  url.searchParams.set("name", "Brolly Billing Read");
  return url.toString();
}
