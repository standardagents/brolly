import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverDirectory = resolve(root, "dist/server");
const siteDirectory = resolve(root, "dist/site");
const { render } = await import(pathToFileURL(resolve(serverDirectory, "render.js")));
const template = readFileSync(resolve(root, "index.html"), "utf8");

rmSync(siteDirectory, { recursive: true, force: true });
mkdirSync(siteDirectory, { recursive: true });
writeFileSync(resolve(siteDirectory, "index.html"), template.replace("<!--app-html-->", render()));
writeFileSync(resolve(siteDirectory, "styles.css"), readFileSync(resolve(root, "src/styles.css")));
cpSync(resolve(root, "public"), siteDirectory, { recursive: true });
cpSync(resolve(root, "../guard-worker/public/cloudflare-icons"), resolve(siteDirectory, "cloudflare-icons"), { recursive: true });
cpSync(resolve(root, "../guard-worker/public/brand-icons"), resolve(siteDirectory, "brand-icons"), { recursive: true });
rmSync(serverDirectory, { recursive: true, force: true });
