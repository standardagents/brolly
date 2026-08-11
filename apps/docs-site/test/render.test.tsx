import { describe, expect, it } from "vitest";
import { render } from "../src/render.js";
import worker from "../src/worker.js";

describe("universal Brolly docs site", () => {
  it("prerenders the marketing and installation content without client JavaScript", () => {
    const html = render();
    expect(html).toContain("Cloudflare moves fast");
    expect(html).toContain("Deploy to Cloudflare");
    expect(html).toContain("@standardagents/brolly-runtime");
    expect(html).toContain("Runs in your Cloudflare account");
    expect(html).toContain("A user who authorizes a different account is rejected");
    expect(html).toContain("Open Brolly and sign in");
    expect(html).toContain("Review what Brolly found");
    expect(html).toContain("Choose your protection");
    expect(html).not.toContain("256-bit credential key");
    expect(html).toContain("The bill should not be your first alert");
    expect(html).toContain("Watch every Worker. Limit every object.");
    expect(html).toContain("per individual Durable Object");
    expect(html).toContain("Auto-quarantine runaways");
    expect(html).toContain("Move away to resume");
    expect(html).toContain("Woke up to a $8,846 Cloudflare bill");
    expect(html).toContain("/x-posts/avatars/justin-schroeder-8846.jpg");
    expect(html).not.toContain("/x-posts/dark/");
    expect(html).not.toContain("/x-posts/light/");
    expect(html.match(/class="story-card"/g)).toHaveLength(14);
    expect(html.match(/<article>/g)?.length).toBeGreaterThanOrEqual(14);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("/api/auth/login");
    expect(html).not.toContain("<script");
  });

  it("exposes an isolated health response without reading instance bindings", async () => {
    const assets = { fetch: async () => new Response("asset") } as unknown as Fetcher;
    const response = await worker.fetch(new Request("https://brolly.standardagents.ai/health"), { ASSETS: assets });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "brolly-docs", rendering: "static-ssr" });
  });
});
