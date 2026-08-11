import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("Tailwind color-mode styling", () => {
  it("routes every dashboard stylesheet through one Tailwind 4 entry", () => {
    const entry = source("../src/client/styles/index.css");
    expect(entry).toContain('@import "tailwindcss"');
    for (const stylesheet of ["base.css", "shell.css", "pages.css", "wizard.css", "themes.css"]) {
      expect(entry).toContain(`@import "./${stylesheet}"`);
    }
    expect(source("../src/client/main.tsx").match(/import .*\.css/g)).toEqual([
      'import "./styles/index.css',
    ]);
  });

  it("provides system light and dark themes for the dashboard", () => {
    const themes = source("../src/client/styles/themes.css");
    expect(themes).toContain("@media (prefers-color-scheme: dark)");
    expect(themes).toContain("@media (prefers-color-scheme: light)");
    expect(themes).toContain("color-scheme: dark");
    expect(source("../index.html")).toContain('media="(prefers-color-scheme: light)"');
    expect(source("../index.html")).toContain('media="(prefers-color-scheme: dark)"');
  });

  it("builds the public site with Tailwind and system color modes", () => {
    const docsStyles = source("../../docs-site/src/styles.css");
    expect(docsStyles).toContain('@import "tailwindcss"');
    expect(docsStyles).toContain("@media (prefers-color-scheme: light)");
    const docsHtml = source("../../docs-site/index.html");
    expect(docsHtml).toContain('media="(prefers-color-scheme: light)"');
    expect(docsHtml).toContain('media="(prefers-color-scheme: dark)"');
  });
});
