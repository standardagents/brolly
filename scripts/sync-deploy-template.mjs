import { copyFileSync, cpSync, mkdirSync, rmSync, statSync } from "node:fs";
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

for (const generatedPath of ["worker.js", "assets", "migrations", "scripts/deploy-guard.mjs", "scripts/verify-template.mjs", "LICENSE"]) {
  rmSync(path.join(templateRoot, generatedPath), { recursive: true, force: true });
}

mkdirSync(path.join(templateRoot, "scripts"), { recursive: true });
copyFileSync(builtWorker, path.join(templateRoot, "worker.js"));
cpSync(builtAssets, path.join(templateRoot, "assets"), { recursive: true });
cpSync(path.join(guardRoot, "migrations"), path.join(templateRoot, "migrations"), { recursive: true });
copyFileSync(path.join(repositoryRoot, "scripts/deploy-guard.mjs"), path.join(templateRoot, "scripts/deploy-guard.mjs"));
copyFileSync(path.join(repositoryRoot, "scripts/verify-deploy-template.mjs"), path.join(templateRoot, "scripts/verify-template.mjs"));
copyFileSync(path.join(repositoryRoot, "LICENSE"), path.join(templateRoot, "LICENSE"));

console.log("Updated the isolated Deploy to Cloudflare template in deploy/.");
