import { afterEach, describe, expect, it, vi } from "vitest";
import { RunBudget } from "@standardagents/brolly-core";
import { CloudflareClient } from "../src/cloudflare.js";
import type { Env } from "../src/env.js";

const baseEnv = { BROLLY_ACCOUNT_ID: "account-1", CLOUDFLARE_OAUTH_TOKEN: "oauth-token" } as Env;

afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare account subscriptions", () => {
  it("uses the operational token when it can read subscriptions", async () => {
    let authorization = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ success: true, result: [{ rate_plan: { id: "workers_paid" }, state: "Paid" }] });
    }));

    await expect(new CloudflareClient(baseEnv, new RunBudget()).subscriptions()).resolves.toEqual([
      { rate_plan: { id: "workers_paid" }, state: "Paid" },
    ]);
    expect(authorization).toBe("Bearer oauth-token");
  });

  it("falls back to Billing Read after an operational 403", async () => {
    const paths: string[] = [];
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      paths.push(new URL(url).pathname);
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      if (paths.length === 1) return Response.json({ success: false, errors: [{ message: "Billing Read required" }] }, { status: 403 });
      return Response.json({ success: true, result: [] });
    }));

    const env = { ...baseEnv, CLOUDFLARE_BILLING_TOKEN: "billing-token" } as Env;
    await expect(new CloudflareClient(env, new RunBudget()).subscriptions()).resolves.toEqual([]);
    expect(paths).toEqual([
      "/client/v4/accounts/account-1/subscriptions",
      "/client/v4/accounts/account-1/subscriptions",
    ]);
    expect(authorizations).toEqual(["Bearer oauth-token", "Bearer billing-token"]);
  });
});
