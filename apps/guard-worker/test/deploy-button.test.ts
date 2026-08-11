import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Deploy to Cloudflare inputs", () => {
  it("asks only for the automatically provisioned D1 database", async () => {
    const [wrangler, manifest, guardManifest, localSecrets] = await Promise.all([
      readFile("wrangler.jsonc", "utf8").then(value => JSON.parse(value) as Record<string, unknown>),
      readFile("package.json", "utf8").then(value => JSON.parse(value) as { cloudflare: { bindings: Record<string, unknown> } }),
      readFile("apps/guard-worker/package.json", "utf8").then(value => JSON.parse(value) as { scripts: Record<string, string> }),
      readFile("dev.vars.example", "utf8"),
    ]);

    expect(wrangler).not.toHaveProperty("vars");
    expect(Object.keys(manifest.cloudflare.bindings)).toEqual(["DB"]);
    await expect(stat(".dev.vars.example")).rejects.toMatchObject({ code: "ENOENT" });
    expect(localSecrets.match(/^[A-Z][A-Z0-9_]*=/gm)).toEqual(["BROLLY_CREDENTIAL_KEY="]);
    expect(localSecrets).toContain("Local development only");
    expect(guardManifest.scripts["deploy:built"]).toBe("node ../../scripts/deploy-guard.mjs");
  });
});
