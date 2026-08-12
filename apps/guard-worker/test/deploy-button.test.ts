import { readFile, readdir, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Deploy to Cloudflare inputs", () => {
  it("ships a complete isolated template with explicit production and preview deploy commands", async () => {
    const [wrangler, manifest, localSecrets, siteSource, readme, workflow, sourceDeployHelper, templateDeployHelper] = await Promise.all([
      readFile("deploy/wrangler.jsonc", "utf8").then(value => JSON.parse(value) as { main: string; no_bundle: boolean; find_additional_modules: boolean; d1_databases: Array<{ binding: string; database_id: string }> }),
      readFile("deploy/package.json", "utf8").then(value => JSON.parse(value) as { cloudflare: { bindings: Record<string, unknown> }; scripts: Record<string, string> }),
      readFile("dev.vars.example", "utf8"),
      readFile("apps/docs-site/src/App.tsx", "utf8"),
      readFile("README.md", "utf8"),
      readFile(".github/workflows/deploy-docs.yml", "utf8"),
      readFile("scripts/deploy-guard.mjs", "utf8"),
      readFile("deploy/scripts/deploy-guard.mjs", "utf8"),
    ]);

    expect(wrangler.main).toBe("worker.js");
    expect(wrangler.no_bundle).toBe(true);
    expect(wrangler.find_additional_modules).toBe(false);
    expect(wrangler.d1_databases).toEqual([expect.objectContaining({ binding: "DB", database_id: "REPLACE_DURING_INSTALL" })]);
    expect(Object.keys(manifest.cloudflare.bindings)).toEqual(["DB"]);
    expect(manifest.scripts.build).toBe("node scripts/verify-template.mjs");
    expect(manifest.scripts.deploy).toContain("db:migrate:remote");
    expect(manifest.scripts.deploy).toContain("deploy-guard.mjs wrangler.jsonc");
    expect(manifest.scripts.preview).toContain("wrangler versions upload");
    expect(siteSource).toContain("https://github.com/standardagents/brolly/tree/deploy-template");
    expect(readme).toContain("https://github.com/standardagents/brolly/tree/deploy-template");
    expect(siteSource).not.toContain("tree/main/deploy");
    expect(readme).not.toContain("tree/main/deploy");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("npm --prefix deploy run build");
    expect(workflow).toContain("git add deploy");
    expect(workflow).toContain("git subtree split --prefix=deploy --branch deploy-template");
    expect(workflow).toContain("git push --force origin deploy-template");
    expect(templateDeployHelper).toBe(sourceDeployHelper);
    expect(await readFile("deploy/scripts/verify-template.mjs", "utf8")).toBe(await readFile("scripts/verify-deploy-template.mjs", "utf8"));
    for (const path of ["deploy/worker.js", "deploy/assets/index.html", "deploy/migrations/0001_initial.sql", "deploy/scripts/verify-template.mjs"]) {
      expect((await stat(path)).isFile()).toBe(true);
    }
    const clientBundles = (await readdir("deploy/assets/assets"))
      .filter(path => path.endsWith(".js"))
      .map(path => readFile(`deploy/assets/assets/${path}`, "utf8"));
    const publishedJavaScript = [await readFile("deploy/worker.js", "utf8"), ...(await Promise.all(clientBundles))].join("\n");
    expect(publishedJavaScript).not.toContain("/Users/");
    expect(publishedJavaScript).not.toMatch(/[A-Z]:\\\\Users\\\\/i);
    expect(publishedJavaScript).not.toContain("jsxDEV");
    await expect(stat(".dev.vars.example")).rejects.toMatchObject({ code: "ENOENT" });
    expect(localSecrets.match(/^[A-Z][A-Z0-9_]*=/gm)).toEqual(["BROLLY_CREDENTIAL_KEY="]);
    expect(localSecrets).toContain("Local development only");
  });
});
