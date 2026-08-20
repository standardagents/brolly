import { execFileSync } from "node:child_process";

/**
 * Paths whose committed content determines the deploy template's bytes: the
 * guard app and the workspace packages its bundle inlines, the scripts copied
 * into the template, and the dependency lockfile.
 */
const TEMPLATE_INPUTS = [
  "apps/guard-worker",
  ":(exclude)apps/guard-worker/test",
  "packages",
  "scripts/deploy-guard.mjs",
  "scripts/update-from-upstream.mjs",
  "scripts/verify-deploy-template.mjs",
  "scripts/sync-deploy-template.mjs",
  "scripts/template-release.mjs",
  "LICENSE",
  "wrangler.jsonc",
  "pnpm-lock.yaml",
];

/**
 * The release a template build represents: the last commit that touched a
 * template input. Deriving it from history instead of the build-time HEAD
 * keeps `pnpm build:deploy-template` reproducible, so a docs-only commit or a
 * CI rebuild produces byte-identical output and the committed template stays
 * canonical.
 */
export function templateRelease(repositoryRoot) {
  const release = execFileSync("git", ["log", "-1", "--format=%H", "--", ...TEMPLATE_INPUTS], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(release)) throw new Error("Could not determine the template release commit");
  return release;
}
