import { describe, expect, it } from "vitest";
import { render } from "../src/render.js";
import worker from "../src/worker.js";

describe("universal Brolly docs site", () => {
  it("prerenders the marketing and installation content without client JavaScript", () => {
    const html = render();
    expect(html).toContain("Cloudflare moves fast");
    expect(html).toContain("Deploy to Cloudflare");
    expect(html).toContain("@standardagents/brolly-runtime");
    expect(html).toContain("It binds the account—not the individual person");
    expect(html).toContain("A user who authorizes a different account is rejected");
    expect(html).toContain("That is the entire deployment form");
    expect(html).toContain("openssl rand -base64 32");
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
