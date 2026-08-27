import { describe, expect, it } from "vitest";
import { authRoute, authenticate, configuredEnv, hasRenewableAccess, refreshInitialIngestionForOAuthScopes } from "../src/auth.js";
import type { Env } from "../src/env.js";
import { createTestD1 } from "./d1.js";

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
    expect(scopes).toContain("account-analytics.read");
    expect(scopes).toContain("analytics.read");
    expect(scopes).toContain("workers-scripts.write");
    expect(scopes).toContain("workers-kv-storage.read");
    expect(scopes).not.toContain("workers-kv-storage.metadata_read");
    expect(scopes).not.toContain("openid");
    expect(scopes).toContain("offline_access");
    expect(response!.headers.get("set-cookie")).toContain("brolly_oauth_state=");
    expect(response!.headers.get("set-cookie")).toContain("HttpOnly");
    expect(writes.some(write => write.sql.includes("INSERT INTO oauth_states"))).toBe(true);
  });

  it("requires a refresh token for unattended monitoring", () => {
    expect(hasRenewableAccess({ refresh_token: "renewable" })).toBe(true);
    expect(hasRenewableAccess({})).toBe(false);
    expect(hasRenewableAccess({ refresh_token: "  " })).toBe(false);
  });

  it("replans permission gaps once after the OAuth scope set changes", async () => {
    const testD1 = createTestD1();
    const now = Date.now();
    try {
      await testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('old-job','account-1','initial_v2',?1,?2,'complete_with_gaps',?2,?2)`,
      ).bind(now - 86_400_000, now).run();
      await testD1.db.prepare(
        `INSERT INTO backfill_slices(id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at)
         VALUES('old-slice','old-job','graphql:zones','{}',?1,?2,'failed','missing',?2)`,
      ).bind(now - 86_400_000, now).run();

      await refreshInitialIngestionForOAuthScopes(testD1.db, "account-1", now);
      expect(await testD1.db.prepare(`SELECT kind,status FROM backfill_jobs WHERE id='old-job'`).first()).toMatchObject({
        kind: "initial_v2_superseded", status: "superseded",
      });
      expect(await testD1.db.prepare(`SELECT status FROM backfill_slices WHERE id='old-slice'`).first()).toMatchObject({ status: "superseded" });

      await testD1.db.prepare(
        `INSERT INTO backfill_jobs(id,account_id,kind,requested_start_at,requested_end_at,status,created_at,updated_at)
         VALUES('new-job','account-1','initial_v2',?1,?2,'pending',?2,?2)`,
      ).bind(now - 86_400_000, now).run();
      await refreshInitialIngestionForOAuthScopes(testD1.db, "account-1", now + 1);
      expect(await testD1.db.prepare(`SELECT kind,status FROM backfill_jobs WHERE id='new-job'`).first()).toMatchObject({
        kind: "initial_v2", status: "pending",
      });
    } finally {
      testD1.close();
    }
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
