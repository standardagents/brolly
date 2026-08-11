#!/usr/bin/env node

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import process from "node:process";

const PACKAGE_PATH = "packages/runtime/package.json";
const VALID_BUMPS = new Set(["patch", "minor", "major"]);
const args = process.argv.slice(2);
const bump = args.find((argument) => VALID_BUMPS.has(argument));
const distTag = flag("--tag") ?? "latest";
const dryRun = args.includes("--dry-run");
const yes = args.includes("--yes");

function flag(name) {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function run(command, options = {}) {
  return execSync(command, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  }).trim();
}

function runMaybe(command, options = {}) {
  if (dryRun) {
    console.log(`[dry-run] ${command}`);
    return "";
  }
  return run(command, options);
}

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function currentVersion() {
  return JSON.parse(readFileSync(PACKAGE_PATH, "utf8")).version;
}

function writeVersion(version) {
  const source = readFileSync(PACKAGE_PATH, "utf8");
  const next = source.replace(/("version"\s*:\s*")[^"]+("\s*,)/, `$1${version}$2`);
  if (source === next) throw new Error(`Could not update version in ${PACKAGE_PATH}`);
  if (dryRun) console.log(`[dry-run] ${PACKAGE_PATH} version -> ${version}`);
  else writeFileSync(PACKAGE_PATH, next);
}

function bumpVersion(version, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(version);
  if (!match) throw new Error(`Unsupported current version: ${version}`);
  let [, major, minor, patch] = match.map(Number);
  if (kind === "major") [major, minor, patch] = [major + 1, 0, 0];
  else if (kind === "minor") [minor, patch] = [minor + 1, 0];
  else patch += 1;
  return `${major}.${minor}.${patch}`;
}

function ensureClean() {
  if (run("git status --porcelain")) throw new Error("Working tree is not clean. Commit or stash changes first.");
}

function ensureTagAvailable(tag) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], { stdio: "ignore" });
    throw new Error(`Tag ${tag} already exists locally.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists locally")) throw error;
  }
  if (run(`git ls-remote --tags origin ${quote(`refs/tags/${tag}`)}`)) {
    throw new Error(`Tag ${tag} already exists on origin.`);
  }
}

async function confirm(summary) {
  if (yes) return true;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await input.question(`${summary}\nContinue? [y/N] `);
  input.close();
  return /^y(?:es)?$/i.test(answer.trim());
}

async function main() {
  if (!bump) throw new Error("Usage: pnpm release:runtime <patch|minor|major> [--tag=dev] [--dry-run] [--yes]");
  if (distTag !== "latest" && !/^[a-z][a-z0-9-]*$/.test(distTag)) throw new Error(`Invalid dist-tag: ${distTag}`);
  ensureClean();

  const branch = run("git branch --show-current");
  if (!branch) throw new Error("Cannot release from detached HEAD.");
  if (distTag === "latest" && branch !== "main") throw new Error("Stable runtime releases must start from main.");

  const from = currentVersion();
  const base = bumpVersion(from, bump);
  const version = distTag === "latest" ? base : `${base}-${distTag}.${run("git rev-parse --short=7 HEAD")}`;
  const tag = `v${version}`;
  ensureTagAvailable(tag);

  const approved = await confirm([
    `@standardagents/brolly-runtime ${from} -> ${version}`,
    `Git tag: ${tag}`,
    `npm dist-tag: ${distTag}`,
    dryRun ? "Mode: dry run" : "Mode: commit, tag, and push",
  ].join("\n"));
  if (!approved) return;

  console.log("Verifying runtime package...");
  run("pnpm verify:runtime-release", { inherit: true });

  if (distTag === "latest") {
    writeVersion(version);
    runMaybe(`git add ${quote(PACKAGE_PATH)}`, { inherit: true });
    runMaybe(`git commit -m ${quote(`chore(runtime): release ${tag}`)}`, { inherit: true });
    runMaybe(`git tag -a ${quote(tag)} -m ${quote(tag)}`, { inherit: true });
    runMaybe(`git push origin ${quote(branch)} --follow-tags`, { inherit: true });
  } else {
    const temporaryBranch = `release/runtime-${version}`;
    let switched = false;
    try {
      runMaybe(`git switch -c ${quote(temporaryBranch)}`);
      switched = !dryRun;
      writeVersion(version);
      runMaybe(`git add ${quote(PACKAGE_PATH)}`, { inherit: true });
      runMaybe(`git commit -m ${quote(`chore(runtime): release ${tag}`)}`, { inherit: true });
      runMaybe(`git tag -a ${quote(tag)} -m ${quote(tag)}`, { inherit: true });
      runMaybe(`git push origin ${quote(tag)}`, { inherit: true });
    } finally {
      if (switched) {
        run(`git switch ${quote(branch)}`);
        run(`git branch -D ${quote(temporaryBranch)}`);
      }
    }
  }

  console.log(`Release tag ${tag} created. Monitor https://github.com/standardagents/brolly/actions`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
