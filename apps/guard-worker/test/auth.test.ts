import { describe, expect, it } from "vitest";
import { authRoute, authenticate, configuredEnv } from "../src/auth.js";
import type { Env } from "../src/env.js";

function database(first: (sql: string, values: unknown[]) => unknown = () => null) {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        values: [] as unknown[],
        bind(...values: unknown[]) { this.values = values; return this; },
        async first() { return first(sql, this.values); },
        async run() { writes.push({ sql, values: this.values }); return { meta: { changes: 1 } }; },
      };
      return statement;
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      return Promise.all(statements.map(statement => statement.run()));
    },
  } as unknown as D1Database;
  return { db, writes };
}

function environment(db: D1Database): Env {
  return {
    DB: db,
    BROLLY_ACCOUNT_ID: "REPLACE_DURING_OAUTH_ONBOARDING",
    BROLLY_OAUTH_CLIENT_ID: "public-client-id",
    BROLLY_OAUTH_REDIRECT_URI: "https://oauth.brolly.example/oauth/callback",
    BROLLY_CREDENTIAL_KEY: "a".repeat(43),
  };
}

describe("Cloudflare OAuth authentication", () => {
  it("starts a one-time PKCE login with the Brolly permission set", async () => {
    const { db, writes } = database();
    const response = await authRoute(new Request("https://guard.example/api/auth/login"), environment(db));
    expect(response?.status).toBe(302);
    const authorization = new URL(response!.headers.get("location")!);
    expect(authorization.origin).toBe("https://dash.cloudflare.com");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("redirect_uri")).toBe("https://oauth.brolly.example/oauth/callback");
    const scopes = authorization.searchParams.get("scope")!.split(" ");
    expect(scopes).toContain("workers-scripts.write");
    expect(scopes).toContain("workers-kv-storage.read");
    expect(scopes).not.toContain("workers-kv-storage.metadata_read");
    expect(scopes).not.toContain("openid");
    expect(scopes).not.toContain("offline_access");
    expect(response!.headers.get("set-cookie")).toContain("brolly_oauth_state=");
    expect(response!.headers.get("set-cookie")).toContain("HttpOnly");
    expect(writes.some(write => write.sql.includes("INSERT INTO oauth_states"))).toBe(true);
  });

  it("clears cached access results when Cloudflare is reauthorized", async () => {
    const source = await import("node:fs/promises").then(fs => fs.readFile("apps/guard-worker/src/auth.ts", "utf8"));
    expect(source).toContain("DELETE FROM settings WHERE key='onboarding_budget_estimates'");
  });

  it("uses the publisher OAuth client without deploy-time OAuth fields", async () => {
    const { db } = database();
    const env = environment(db);
    delete env.BROLLY_OAUTH_CLIENT_ID;
    delete env.BROLLY_OAUTH_REDIRECT_URI;
    const response = await authRoute(new Request("https://guard.example/api/auth/login"), env);
    const authorization = new URL(response!.headers.get("location")!);
    expect(authorization.searchParams.get("client_id")).toBe("5690968d2377c6200202668946420dec");
    expect(authorization.searchParams.get("redirect_uri")).toBe("https://brolly-login.standardagents.ai/oauth/callback");
  });

  it("uses an HttpOnly session and rejects cross-origin mutations", async () => {
    const now = Date.now();
    const { db } = database(sql => sql.includes("FROM auth_sessions") ? {
      user_id: "user-1", email: "operator@example.com", display_name: "Operator", account_id: "account-1", expires_at: now + 60_000,
    } : null);
    const env = environment(db);
    const sameOrigin = new Request("https://guard.example/api/run", { method: "POST", headers: { cookie: "brolly_session=session", origin: "https://guard.example" } });
    await expect(authenticate(sameOrigin, env)).resolves.toMatchObject({ kind: "session", accountId: "account-1" });
    const crossOrigin = new Request("https://guard.example/api/run", { method: "POST", headers: { cookie: "brolly_session=session", origin: "https://attacker.example" } });
    await expect(authenticate(crossOrigin, env)).resolves.toBeNull();
    const logout = await authRoute(new Request("https://guard.example/api/auth/logout", { method: "POST", headers: { cookie: "brolly_session=session", origin: "https://attacker.example" } }), env);
    expect(logout?.status).toBe(403);
  });

  it("hydrates the account selected during OAuth instead of trusting the deploy placeholder", async () => {
    const { db } = database(sql => sql.includes("key='account_id'") ? { value: "account-from-oauth" } : null);
    await expect(configuredEnv(environment(db))).resolves.toMatchObject({ BROLLY_ACCOUNT_ID: "account-from-oauth" });
  });

  it("proves a live one-time state to the separate shared relay", async () => {
    const expiresAt = Date.now() + 60_000;
    const { db } = database(sql => sql.includes("FROM oauth_states") ? { expires_at: expiresAt } : null);
    const state = `random.${Buffer.from("https://guard.example").toString("base64url")}`;
    const response = await authRoute(new Request(`https://guard.example/api/auth/relay/verify?state=${state}`), environment(db));
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ callbackUrl: "https://guard.example/api/auth/callback" });

    const wrongOrigin = await authRoute(new Request(`https://other.example/api/auth/relay/verify?state=${state}`), environment(db));
    expect(wrongOrigin?.status).toBe(400);
    expect(await authRoute(new Request(`https://guard.example/oauth/callback?state=${state}`), environment(db))).toBeNull();
  });
});
