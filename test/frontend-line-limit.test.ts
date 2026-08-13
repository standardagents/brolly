import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Enforces the frontend file-size rule from AGENTS.md: files over 1,000 lines
 * are a code smell and must be split. This runs in `pnpm test` locally and in
 * CI, so the limit cannot be skipped silently.
 *
 * An oversized file must be rewritten. Do not raise LIMIT, baseline existing
 * violations, or add exemptions here.
 */
const LIMIT = 1000;
const TREES = ["apps/docs-site/src", "apps/guard-worker/src/client"];
const EXTENSIONS = new Set([".ts", ".tsx", ".css"]);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(entry => {
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) return sourceFiles(absolute);
    return EXTENSIONS.has(path.extname(entry)) ? [absolute] : [];
  });
}

describe("frontend file-size limit", () => {
  it(`keeps every docs-site and dashboard-client source file at or under ${LIMIT} lines`, () => {
    const oversized = TREES.flatMap(tree => sourceFiles(path.join(root, tree)))
      .map(file => ({ file: path.relative(root, file), lines: readFileSync(file, "utf8").split("\n").length }))
      .filter(entry => entry.lines > LIMIT);
    expect(oversized, `Split these files (AGENTS.md frontend standards): ${oversized.map(entry => `${entry.file} (${entry.lines})`).join(", ")}`).toEqual([]);
  });
});
