import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { render } from "../src/render.js";
import worker from "../src/worker.js";

describe("universal Brolly docs site", () => {
  it("prerenders the marketing and installation content without client JavaScript", () => {
    const html = render();
    expect(html).toContain("Protect yourself from runaway Cloudflare spend");
    expect(html).toContain("Deploy to Cloudflare");
    expect(html.match(/class="cloudflare-logo/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain("@standardagents/brolly-runtime");
    expect(html).toContain("Give the install to your coding agent");
    expect(html).toContain("Runs in your Cloudflare account");
    expect(html).toContain("A user who authorizes a different account is rejected");
    expect(html).toContain("Open Brolly and sign in");
    expect(html).toContain("Review what Brolly found");
    expect(html).toContain("Choose your protection");
    expect(html).not.toContain("256-bit credential key");
    expect(html).toContain("See runaway usage while there is time to respond.");
    expect(html).toContain("A durable Cloudflare usage ledger with granular protection.");
    expect(html).toContain("exact object IDs");
    expect(html).toContain("Choose one shared risk tolerance curve for every alert level");
    expect(html).toContain("Configure Cloudflare Email, Discord, Postmark, Resend, Slack, Twilio SMS");
    expect(html).toContain("300 GraphQL dataset queries");
    // The dollar amount is wrapped in a highlight element mid-sentence.
    expect(html).toContain("Woke up to a");
    expect(html).toContain("$8,846");
    expect(html).toContain("/x-posts/avatars/justin-schroeder-8846.jpg");
    expect(html).not.toContain("/x-posts/dark/");
    expect(html).not.toContain("/x-posts/light/");
    expect(html.match(/class="story-card /g)?.length).toBeGreaterThanOrEqual(6);
    expect(html.match(/<article/g)?.length).toBeGreaterThanOrEqual(6);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("/api/auth/login");
    expect(html).not.toContain("<script");
    // The hero simulation is a lazily loaded client chunk; server rendering
    // must never depend on it or emit its canvas.
    expect(html).not.toContain("<canvas");
  });

  it("exposes an isolated health response without reading instance bindings", async () => {
    const assets = { fetch: async () => new Response("asset") } as unknown as Fetcher;
    const response = await worker.fetch(new Request("https://brolly.standardagents.ai/health"), { ASSETS: assets });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "brolly-docs", rendering: "static-ssr" });
  });

  it("keeps the default Wrangler config away from the production Worker and route", () => {
    const local = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
    const production = JSON.parse(readFileSync(new URL("../wrangler.production.jsonc", import.meta.url), "utf8"));
    expect(local.name).toBe("brolly-docs-local");
    expect(local.routes).toBeUndefined();
    expect(production.name).toBe("brolly-docs");
    expect(production.routes).toEqual([{ pattern: "brolly.standardagents.ai", custom_domain: true }]);
  });
});
