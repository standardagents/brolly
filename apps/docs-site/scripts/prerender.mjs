import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverDirectory = resolve(root, "dist/server");
const clientDirectory = resolve(root, "dist/client");
const siteDirectory = resolve(root, "dist/site");
const { render } = await import(pathToFileURL(resolve(serverDirectory, "render.js")));
// The client build's index.html carries the hashed script and stylesheet
// tags; injecting the server-rendered markup into it keeps the static-first
// page while letting the same bundle hydrate for the animated hero.
const template = readFileSync(resolve(clientDirectory, "index.html"), "utf8");

rmSync(siteDirectory, { recursive: true, force: true });
mkdirSync(siteDirectory, { recursive: true });
writeFileSync(resolve(siteDirectory, "index.html"), template.replace("<!--app-html-->", render()));
cpSync(resolve(clientDirectory, "assets"), resolve(siteDirectory, "assets"), { recursive: true });
cpSync(resolve(root, "public"), siteDirectory, { recursive: true, dereference: true });
rmSync(serverDirectory, { recursive: true, force: true });
rmSync(clientDirectory, { recursive: true, force: true });
