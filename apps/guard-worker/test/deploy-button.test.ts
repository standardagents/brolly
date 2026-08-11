import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Deploy to Cloudflare inputs", () => {
  it("asks only for D1 and the credential-encryption key", async () => {
    const [wrangler, manifest, secrets] = await Promise.all([
      readFile("wrangler.jsonc", "utf8").then(value => JSON.parse(value) as Record<string, unknown>),
      readFile("package.json", "utf8").then(value => JSON.parse(value) as { cloudflare: { bindings: Record<string, unknown> } }),
      readFile(".dev.vars.example", "utf8"),
    ]);

    expect(wrangler).not.toHaveProperty("vars");
    expect(Object.keys(manifest.cloudflare.bindings)).toEqual(["DB", "BROLLY_CREDENTIAL_KEY"]);
    expect(secrets.match(/^[A-Z][A-Z0-9_]*=/gm)).toEqual(["BROLLY_CREDENTIAL_KEY="]);
    expect(secrets).not.toContain("BROLLY_ADMIN_TOKEN");
    expect(secrets).not.toContain("CLOUDFLARE_BILLING_TOKEN");
  });
});
