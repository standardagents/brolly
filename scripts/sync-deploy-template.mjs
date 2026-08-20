import { copyFileSync, cpSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { templateRelease } from "./template-release.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guardRoot = path.join(repositoryRoot, "apps/guard-worker");
const templateRoot = path.join(repositoryRoot, "deploy");
const builtWorker = path.join(guardRoot, "dist/brolly_guard/index.js");
const builtAssets = path.join(guardRoot, "dist/client");

for (const requiredPath of [builtWorker, builtAssets]) {
  statSync(requiredPath);
}

for (const generatedPath of ["worker.js", "assets", "migrations", "scripts/deploy-guard.mjs", "scripts/update-from-upstream.mjs", "scripts/verify-template.mjs", "brolly-release.json", "LICENSE"]) {
  rmSync(path.join(templateRoot, generatedPath), { recursive: true, force: true });
}

mkdirSync(path.join(templateRoot, "scripts"), { recursive: true });
copyFileSync(builtWorker, path.join(templateRoot, "worker.js"));
cpSync(builtAssets, path.join(templateRoot, "assets"), { recursive: true });
cpSync(path.join(guardRoot, "migrations"), path.join(templateRoot, "migrations"), { recursive: true });
copyFileSync(path.join(repositoryRoot, "scripts/deploy-guard.mjs"), path.join(templateRoot, "scripts/deploy-guard.mjs"));
copyFileSync(path.join(repositoryRoot, "scripts/update-from-upstream.mjs"), path.join(templateRoot, "scripts/update-from-upstream.mjs"));
copyFileSync(path.join(repositoryRoot, "scripts/verify-deploy-template.mjs"), path.join(templateRoot, "scripts/verify-template.mjs"));
copyFileSync(path.join(repositoryRoot, "LICENSE"), path.join(templateRoot, "LICENSE"));

const release = templateRelease(repositoryRoot);
const publishedAt = execFileSync("git", ["show", "-s", "--format=%cI", release], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const date = new Date(publishedAt);
const displayVersion = `${date.getUTCFullYear()}.${String(date.getUTCMonth() + 1).padStart(2, "0")}.${String(date.getUTCDate()).padStart(2, "0")}-${release.slice(0, 7)}`;
writeFileSync(path.join(templateRoot, "brolly-release.json"), `${JSON.stringify({
  schemaVersion: 1,
  release,
  displayVersion,
  publishedAt: new Date(publishedAt).toISOString(),
  notesUrl: `https://github.com/standardagents/brolly/commit/${release}`,
  workflowFile: "brolly-update.yml",
  configVersion: 1,
}, null, 2)}\n`);

console.log("Updated the isolated Deploy to Cloudflare template in deploy/.");
