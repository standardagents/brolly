import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsSiteRoot = path.join(repositoryRoot, "apps/docs-site");
const canonicalRepository = "standardagents/brolly";

export const MANUAL_DEPLOY_HELP = `The standard production path is a push from main. GitHub Actions typechecks, builds, and deploys that commit.

The emergency manual path is interactive and requires confirmation before the build and immediately before the production upload:
  pnpm deploy:docs`;

export function parseDeployOptions(args) {
  const options = { ci: false, built: false };
  for (const argument of args) {
    if (argument === "--") continue;
    if (argument === "--ci") {
      options.ci = true;
      continue;
    }
    if (argument === "--built") {
      options.built = true;
      continue;
    }
    throw new Error(`Unknown deployment option: ${argument}`);
  }
  return options;
}

export function readManualDeploymentSnapshot({ git = runGit } = {}) {
  const branch = git(["branch", "--show-current"]).trim() || "detached HEAD";
  const head = git(["rev-parse", "HEAD"]).trim();
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]).trim();
  const changeCount = status ? status.split("\n").length : 0;
  return {
    branch,
    head,
    shortHead: head.slice(0, 12),
    workingTree: changeCount ? `dirty (${changeCount} changed path${changeCount === 1 ? "" : "s"})` : "clean",
  };
}

export function formatManualDeployWarning(snapshot, phase) {
  const action = phase === "before-build" ? "build this checkout for production" : "upload this build to production";
  return `\nWARNING: manual Brolly docs production deployment\n\nThe standard production path is a push from main through GitHub Actions.\nThis emergency command is about to ${action}.\n\nSource branch: ${snapshot.branch}\nSource commit: ${snapshot.shortHead}\nWorking tree: ${snapshot.workingTree}\nProduction site: https://brolly.standardagents.ai\n`;
}

export async function confirmManualDocsDeployment({ snapshot, phase, prompt = promptInTerminal, warn = console.warn }) {
  warn(formatManualDeployWarning(snapshot, phase));
  const expected = phase === "before-build" ? "continue" : "deploy";
  const question = phase === "before-build"
    ? 'Type "continue" to create the production build: '
    : 'Type "deploy" to upload this build to production: ';
  const response = await prompt(question);
  if (response.trim() !== expected) {
    throw new Error(`manual production deployment cancelled ${phase === "before-build" ? "before the build" : "before the upload"}`);
  }
}

export async function promptInTerminal(question, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("manual production deployment requires an interactive terminal");
  }
  const interface_ = createInterface({ input, output });
  try {
    return await interface_.question(question);
  } finally {
    interface_.close();
  }
}

export function verifyCiDocsDeployment({ env = process.env, git = runGit } = {}) {
  if (env.GITHUB_ACTIONS !== "true") {
    throw new Error("the CI deployment path requires GitHub Actions");
  }
  if (env.GITHUB_REPOSITORY !== canonicalRepository) {
    throw new Error(`the CI deployment path requires repository ${canonicalRepository}`);
  }
  if (env.GITHUB_REF !== "refs/heads/main") {
    throw new Error(`the CI deployment path requires refs/heads/main; current ref is ${env.GITHUB_REF || "missing"}`);
  }

  const head = git(["rev-parse", "HEAD"]).trim();
  if (env.GITHUB_SHA !== head) {
    throw new Error(`GITHUB_SHA ${env.GITHUB_SHA || "missing"} must match checked-out HEAD ${head}`);
  }

  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]).trim();
  if (status) {
    throw new Error("the CI deployment path requires a clean working tree");
  }

  return { head };
}

export async function deployDocs({ args = process.argv.slice(2), env = process.env, git = runGit, run = runCommand, prompt = promptInTerminal, warn = console.warn } = {}) {
  const options = parseDeployOptions(args);
  if (options.ci) {
    if (!options.built) throw new Error("the CI deployment path requires a completed build");
    const { head } = verifyCiDocsDeployment({ env, git });
    console.log(`Deploying Brolly docs commit ${head} through the protected CI path.`);
    run(packageManagerCommand(), ["exec", "wrangler", "deploy", "--config", "wrangler.ci.jsonc"], { cwd: docsSiteRoot });
    return;
  }

  if (options.built) throw new Error("the manual deployment path always creates a fresh build");
  const initial = readManualDeploymentSnapshot({ git });
  await confirmManualDocsDeployment({ snapshot: initial, phase: "before-build", prompt, warn });
  console.log(`Building Brolly docs from ${initial.branch} at ${initial.shortHead}.`);
  run(packageManagerCommand(), ["build"], { cwd: docsSiteRoot });
  const final = readManualDeploymentSnapshot({ git });
  await confirmManualDocsDeployment({ snapshot: final, phase: "before-deploy", prompt, warn });
  console.log(`Deploying Brolly docs from ${final.branch} at ${final.shortHead}.`);
  run(packageManagerCommand(), ["exec", "wrangler", "deploy", "--config", "wrangler.production.jsonc"], { cwd: docsSiteRoot });
}

function packageManagerCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function runGit(args) {
  return runCommand("git", args, { cwd: repositoryRoot, capture: true });
}

function runCommand(command, args, { cwd, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? result.stderr.trim() : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}${detail ? `: ${detail}` : ""}`);
  }
  return capture ? result.stdout : "";
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  deployDocs().catch(error => {
    console.error(`\nBrolly docs deployment blocked: ${error instanceof Error ? error.message : error}\n`);
    if (!process.argv.includes("--ci")) console.error(`${MANUAL_DEPLOY_HELP}\n`);
    process.exitCode = 1;
  });
}
