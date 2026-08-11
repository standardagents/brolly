import { readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  "worker.js",
  "assets/index.html",
  "assets/assets/index.css",
  "migrations/0001_initial.sql",
  "migrations/0002_auth_and_actuator_safety.sql",
  "wrangler.jsonc",
];

for (const file of requiredFiles) {
  if (!statSync(path.join(templateRoot, file)).isFile()) throw new Error(`Missing required Brolly release artifact: ${file}`);
}

const wrangler = JSON.parse(readFileSync(path.join(templateRoot, "wrangler.jsonc"), "utf8"));
if (wrangler.main !== "worker.js" || wrangler.no_bundle !== true || wrangler.find_additional_modules !== false) {
  throw new Error("Brolly's prebuilt Worker upload boundary is invalid");
}
if (!wrangler.d1_databases?.some(database => database.binding === "DB")) {
  throw new Error("Brolly's required D1 binding is missing");
}

const JavaScriptFiles = [
  "worker.js",
  ...readdirSync(path.join(templateRoot, "assets/assets"))
    .filter(file => file.endsWith(".js"))
    .map(file => `assets/assets/${file}`),
];
if (JavaScriptFiles.length < 2) throw new Error("Brolly's dashboard JavaScript bundle is missing");

for (const file of JavaScriptFiles) {
  const absolutePath = path.join(templateRoot, file);
  const check = spawnSync(process.execPath, ["--check", absolutePath], { encoding: "utf8" });
  if (check.status !== 0) throw new Error(`Invalid JavaScript release artifact ${file}: ${check.stderr.trim()}`);
  const source = readFileSync(absolutePath, "utf8");
  if (source.includes("/Users/") || /[A-Z]:\\\\Users\\\\/i.test(source) || source.includes("jsxDEV")) {
    throw new Error(`Development-only source metadata leaked into ${file}`);
  }
}

console.log(`Verified Brolly's prebuilt Worker, dashboard, D1 migrations, and upload boundary (${JavaScriptFiles.length} JavaScript artifacts).`);
