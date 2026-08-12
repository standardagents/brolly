import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("Deploy to Cloudflare inputs", () => {
  it("ships a complete isolated template with explicit production and preview deploy commands", async () => {
    const [wrangler, manifest, localSecrets, siteSource, readme, workflow, sourceDeployHelper, templateDeployHelper, updaterWorkflow, release] = await Promise.all([
      readFile("deploy/wrangler.jsonc", "utf8").then(value => JSON.parse(value) as { main: string; no_bundle: boolean; find_additional_modules: boolean; d1_databases: Array<{ binding: string; database_id: string }> }),
      readFile("deploy/package.json", "utf8").then(value => JSON.parse(value) as { cloudflare: { bindings: Record<string, unknown> }; scripts: Record<string, string> }),
      readFile("dev.vars.example", "utf8"),
      readFile("apps/docs-site/src/App.tsx", "utf8"),
      readFile("README.md", "utf8"),
      readFile(".github/workflows/deploy-docs.yml", "utf8"),
      readFile("scripts/deploy-guard.mjs", "utf8"),
      readFile("deploy/scripts/deploy-guard.mjs", "utf8"),
      readFile("deploy/.github/workflows/brolly-update.yml", "utf8"),
      readFile("deploy/brolly-release.json", "utf8").then(value => JSON.parse(value) as { release: string; workflowFile: string; configVersion: number }),
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
    expect(await readFile("deploy/scripts/update-from-upstream.mjs", "utf8")).toBe(await readFile("scripts/update-from-upstream.mjs", "utf8"));
    expect(updaterWorkflow).toContain("workflow_dispatch:");
    expect(updaterWorkflow).toContain("contents: write");
    expect(updaterWorkflow).toContain("pull-requests: write");
    expect(updaterWorkflow).toContain("node scripts/update-from-upstream.mjs");
    expect(updaterWorkflow).toContain("git add .github/workflows/brolly-update.yml");
    expect(release.release).toMatch(/^[a-f0-9]{40}$/);
    expect(release.workflowFile).toBe("brolly-update.yml");
    expect(release.configVersion).toBe(1);
    for (const path of ["deploy/worker.js", "deploy/assets/index.html", "deploy/migrations/0001_initial.sql", "deploy/scripts/verify-template.mjs", "deploy/scripts/update-from-upstream.mjs", "deploy/.github/workflows/brolly-update.yml"]) {
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

  it("updates application artifacts without replacing installation-owned Cloudflare configuration", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "brolly-update-test-"));
    const installation = join(temporaryRoot, "installation");
    try {
      await cp("deploy", installation, { recursive: true });
      const sentinel = `{ "d1_databases": [{ "binding": "DB", "database_id": "private-installation-id" }] }\n`;
      await writeFile(join(installation, "wrangler.jsonc"), sentinel);
      await writeFile(join(installation, "operator-note.txt"), "keep me\n");
      await run(process.execPath, ["scripts/update-from-upstream.mjs", resolve("deploy")], { cwd: installation });
      expect(await readFile(join(installation, "wrangler.jsonc"), "utf8")).toBe(sentinel);
      expect(await readFile(join(installation, "operator-note.txt"), "utf8")).toBe("keep me\n");
      expect(await readFile(join(installation, "worker.js"), "utf8")).toBe(await readFile("deploy/worker.js", "utf8"));
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
