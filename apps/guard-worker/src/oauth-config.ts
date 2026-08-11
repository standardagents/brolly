import type { Env } from "./env.js";

export const BROLLY_PUBLIC_OAUTH_CLIENT_ID = "5690968d2377c6200202668946420dec";
export const BROLLY_PUBLIC_OAUTH_REDIRECT_URI = "https://brolly-login.formkit.workers.dev/oauth/callback";

export function oauthClientId(env: Env): string {
  const configured = env.BROLLY_OAUTH_CLIENT_ID?.trim();
  return configured && !configured.startsWith("REPLACE_") ? configured : BROLLY_PUBLIC_OAUTH_CLIENT_ID;
}

export function oauthRedirectUri(env: Env): string {
  const configured = env.BROLLY_OAUTH_REDIRECT_URI?.trim();
  return configured && !configured.startsWith("REPLACE_") ? configured : BROLLY_PUBLIC_OAUTH_REDIRECT_URI;
}
