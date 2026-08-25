import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const CREDENTIAL_VARIABLE = "BROLLY_CREDENTIAL_KEY";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const devVarsPath = path.join(repositoryRoot, ".dev.vars");
const wranglerConfigPath = path.join(repositoryRoot, "wrangler.jsonc");
const persistencePath = path.join(repositoryRoot, ".wrangler/state/account-dev");

export function createCredentialKey() {
  return randomBytes(32).toString("base64url");
}

export function credentialKeyIsValid(value) {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, value.includes("+") || value.includes("/") || value.endsWith("=") ? "base64" : "base64url").length === 32;
  } catch {
    return false;
  }
}

export function upsertCredentialKey(contents, createKey = createCredentialKey) {
  const line = /^([ \t]*BROLLY_CREDENTIAL_KEY[ \t]*=[ \t]*)([^\r\n]*)$/m.exec(contents);
  if (line) {
    const configured = unquote(line[2].trim());
    if (configured) {
      if (!credentialKeyIsValid(configured)) {
        throw new Error(`${CREDENTIAL_VARIABLE} in .dev.vars must be a 256-bit base64 or base64url value`);
      }
      return { contents, generated: false };
    }
    const key = createKey();
    return { contents: contents.replace(line[0], `${line[1]}${key}`), generated: true };
  }

  const key = createKey();
  const separator = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
  return { contents: `${contents}${separator}${CREDENTIAL_VARIABLE}=${key}\n`, generated: true };
}

export async function ensureLocalCredentialKey({
  filename = devVarsPath,
  read = readFile,
  write = writeFile,
  createKey = createCredentialKey,
} = {}) {
  let contents = "";
  try {
    contents = await read(filename, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    contents = "# Local development only. Never commit this file.\n";
  }
  const next = upsertCredentialKey(contents, createKey);
  if (next.generated) await write(filename, next.contents, { mode: 0o600 });
  await chmod(filename, 0o600);
  return next.generated;
}

export function resolveDevHost({ env = process.env, run = runCaptured } = {}) {
  if (env.BROLLY_DEV_HOST?.trim()) return env.BROLLY_DEV_HOST.trim();
  try {
    const addresses = run("tailscale", ["ip", "-4"]).split(/\s+/).filter(Boolean);
    const address = addresses.find(value => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value));
    if (address) return address;
  } catch {
    // Tailscale is optional outside MacBookServer.
  }
  return "0.0.0.0";
}

export function findAvailablePort(host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to resolve the local development port"));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

export async function runAccountDevelopment({ env = process.env, log = console.log, warn = console.warn } = {}) {
  log("\nBrolly real-account local development");
  log("Cloudflare inventory and telemetry are real. Worker state, credentials, and history stay in local D1.");
  warn("Notifications and approved or automatic controls can affect external systems exactly as they do in production.\n");

  const generated = await ensureLocalCredentialKey();
  log(generated ? "Created a local credential-encryption key in .dev.vars." : "Using the existing local credential-encryption key.");

  for (const packageName of ["@standardagents/brolly-core", "@standardagents/brolly-notifiers", "@standardagents/brolly-runtime"]) {
    runInherited(packageManagerCommand(), ["--filter", packageName, "build"], { cwd: repositoryRoot, env });
  }
  runInherited(packageManagerCommand(), [
    "exec", "wrangler", "d1", "migrations", "apply", "DB", "--local",
    "--persist-to", persistencePath, "--config", wranglerConfigPath,
  ], { cwd: repositoryRoot, env: { ...env, CI: "true" } });

  const host = resolveDevHost({ env });
  const port = await findAvailablePort(host);
  const localFetchHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const localOrigin = `http://${localFetchHost}:${port}`;
  const magicDnsOrigin = host === "100.79.199.1" ? `http://macbookserver.tail13bd39.ts.net:${port}` : localOrigin;
  log(`\nLocal dashboard: ${magicDnsOrigin}`);
  log("Cloudflare sign-in: use the HTTPS trycloudflare.com URL that Vite prints below, and stay on that origin through onboarding.\n");

  const vite = spawn(packageManagerCommand(), ["--filter", "@standardagents/brolly-guard", "dev"], {
    cwd: repositoryRoot,
    env: { ...env, BROLLY_ACCOUNT_DEV: "1", BROLLY_DEV_HOST: host, BROLLY_DEV_PORT: String(port) },
    stdio: "inherit",
  });
  vite.on("error", error => {
    console.error(`Unable to start Brolly account development: ${error.message}`);
  });

  let scheduler;
  try {
    await waitForWorker(`${localOrigin}/health`, vite);
    if (env.BROLLY_ACCOUNT_DEV_NO_CRON !== "1") scheduler = scheduleMinuteCron(localOrigin, { log, warn });
    const code = await childExit(vite);
    if (code !== 0 && code !== null) process.exitCode = code;
  } finally {
    scheduler?.stop();
  }
}

export function scheduleMinuteCron(origin, { fetchImpl = fetch, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = console.log, warn = console.warn } = {}) {
  let timer;
  let stopped = false;
  let failing = false;
  const run = async () => {
    if (stopped) return;
    try {
      const url = new URL("/cdn-cgi/handler/scheduled", origin);
      url.searchParams.set("cron", "* * * * *");
      url.searchParams.set("format", "json");
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`scheduled handler returned ${response.status}`);
      if (failing) log("Local minute scheduler recovered.");
      failing = false;
    } catch (error) {
      if (!failing) warn(`Local minute scheduler paused: ${error instanceof Error ? error.message : error}`);
      failing = true;
    } finally {
      if (!stopped) timer = setTimer(run, 60_000);
    }
  };
  const untilNextMinute = Math.max(250, 60_000 - now() % 60_000);
  timer = setTimer(run, untilNextMinute);
  log("Local minute scheduler is active.");
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
    },
  };
}

function unquote(value) {
  const match = /^(["'])(.*)\1$/.exec(value);
  return match ? match[2] : value;
}

function packageManagerCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function runInherited(command, args, { cwd, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
}

function runCaptured(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return result.stdout;
}

async function waitForWorker(url, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Vite stopped before the local Worker became ready (exit ${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  child.kill("SIGTERM");
  throw new Error(`Timed out waiting for the local Worker at ${url}`);
}

function childExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runAccountDevelopment().catch(error => {
    console.error(`\nBrolly account development stopped: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
