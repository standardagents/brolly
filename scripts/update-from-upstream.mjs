import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const installationRoot = process.cwd();
const upstreamRoot = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || upstreamRoot === installationRoot) throw new Error("Pass the checked-out Brolly deploy-template directory");

const manifestPath = path.join(upstreamRoot, "brolly-release.json");
if (!existsSync(manifestPath)) throw new Error("The upstream checkout is missing brolly-release.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.schemaVersion !== 1 || manifest.configVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.release ?? "")) {
  throw new Error("The upstream Brolly release is incompatible with this updater");
}

const managedPaths = [
  "LICENSE",
  "README.md",
  "assets",
  "brolly-release.json",
  "migrations",
  "package-lock.json",
  "package.json",
  "scripts/deploy-guard.mjs",
  "scripts/update-from-upstream.mjs",
  "scripts/verify-template.mjs",
  "worker.js",
];

for (const relativePath of managedPaths) {
  const source = path.join(upstreamRoot, relativePath);
  if (!existsSync(source)) throw new Error(`The upstream Brolly release is missing ${relativePath}`);
}

for (const relativePath of managedPaths) {
  const source = path.join(upstreamRoot, relativePath);
  const target = path.join(installationRoot, relativePath);
  rmSync(target, { force: true, recursive: true });
  mkdirSync(path.dirname(target), { recursive: true });
  if (relativePath === "assets" || relativePath === "migrations") cpSync(source, target, { recursive: true });
  else copyFileSync(source, target);
}

console.log(`Prepared Brolly ${manifest.displayVersion} (${manifest.release.slice(0, 12)}).`);
console.log("Preserved wrangler.jsonc, the provisioned D1 binding, Worker variables, and secrets.");
