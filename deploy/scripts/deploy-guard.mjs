import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const CREDENTIAL_SECRET = "BROLLY_CREDENTIAL_KEY";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfig = path.join(repositoryRoot, "apps/guard-worker/dist/brolly_guard/wrangler.json");

/**
 * Deploy first so Wrangler preserves any existing Worker secrets, then create
 * the credential key only when a successful secret listing proves it is absent.
 * An unavailable or malformed listing fails closed and can never rotate a key.
 */
export async function deployGuard({
  config = defaultConfig,
  runWrangler = runWranglerCommand,
  createKey = createCredentialKey,
  log = console.log,
} = {}) {
  await runWrangler(["deploy", "--config", config], { output: "inherit" });

  const listed = await runWrangler(["secret", "list", "--format", "json", "--config", config]);
  const secrets = parseSecretList(listed.stdout);
  if (secrets.some(secret => secret.name === CREDENTIAL_SECRET)) {
    log("Brolly credential encryption secret already exists; preserving it.");
    return { created: false };
  }

  const key = createKey();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) {
    throw new Error("Generated Brolly credential key was not a 256-bit base64url value");
  }

  await runWrangler(["secret", "put", CREDENTIAL_SECRET, "--config", config], {
    input: `${key}\n`,
    output: "inherit",
  });
  log("Created Brolly's credential encryption secret. Future deployments will preserve it.");
  return { created: true };
}

export function createCredentialKey() {
  return randomBytes(32).toString("base64url");
}

export function parseSecretList(stdout) {
  let value;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Cloudflare returned an unreadable Worker secret list; refusing to create or rotate credentials");
  }
  if (!Array.isArray(value) || value.some(secret => !secret || typeof secret.name !== "string")) {
    throw new Error("Cloudflare returned an invalid Worker secret list; refusing to create or rotate credentials");
  }
  return value;
}

async function runWranglerCommand(args, { input, output = "capture" } = {}) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["exec", "--", "wrangler", ...args], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: [input === undefined ? "ignore" : "pipe", output === "inherit" ? "inherit" : "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(`wrangler ${args.slice(0, 2).join(" ")} failed with exit code ${code ?? "unknown"}`));
    });
    if (input !== undefined) {
      child.stdin.on("error", error => {
        if (error.code !== "EPIPE") reject(error);
      });
      child.stdin.end(input);
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const requestedConfig = process.argv[2];
  const options = requestedConfig ? { config: path.resolve(process.cwd(), requestedConfig) } : undefined;
  deployGuard(options).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
