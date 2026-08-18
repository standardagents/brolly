export function emailSendingTokenTemplateUrl(accountId: string): string {
  const url = new URL("https://dash.cloudflare.com/profile/api-tokens");
  url.searchParams.set("permissionGroupKeys", JSON.stringify([{ key: "email_sending", type: "edit" }]));
  url.searchParams.set("accountId", accountId);
  url.searchParams.set("zoneId", "all");
  url.searchParams.set("name", "Brolly Email Sending");
  return url.toString();
}

export function emailServiceOnboardingUrl(accountId: string): string {
  return `https://dash.cloudflare.com/${encodeURIComponent(accountId)}/email/sending`;
}
