import { describe, expect, it, vi } from "vitest";
import {
  confirmManualDocsDeployment,
  deployDocs,
  formatManualDeployWarning,
  parseDeployOptions,
  promptInTerminal,
  readManualDeploymentSnapshot,
  verifyCiDocsDeployment,
} from "./deploy-docs.mjs";

const HEAD = "d1870791c375af1b6258ad65bb03b0b45d8862b1";

function createGit(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    "branch --show-current": "main\n",
    "status --porcelain=v1 --untracked-files=all": "",
    "rev-parse HEAD": `${HEAD}\n`,
    ...overrides,
  };
  return vi.fn((args: string[]) => values[args.join(" ")] ?? "");
}

describe("Brolly docs deployment guard", () => {
  it("parses the interactive manual and protected CI paths", () => {
    expect(parseDeployOptions([])).toEqual({ ci: false, built: false });
    expect(parseDeployOptions(["--ci", "--built"])).toEqual({ ci: true, built: true });
    expect(() => parseDeployOptions(["--force"])).toThrow("Unknown deployment option");
  });

  it("describes the exact checkout selected for a manual deployment", () => {
    const snapshot = readManualDeploymentSnapshot({
      git: createGit({
        "branch --show-current": "feature/homepage\n",
        "status --porcelain=v1 --untracked-files=all": " M apps/docs-site/src/App.tsx\n?? draft.png\n",
      }),
    });
    expect(snapshot).toEqual({
      branch: "feature/homepage",
      head: HEAD,
      shortHead: HEAD.slice(0, 12),
      workingTree: "dirty (2 changed paths)",
    });
    const warning = formatManualDeployWarning(snapshot, "before-deploy");
    expect(warning).toContain("The standard production path is a push from main");
    expect(warning).toContain("Source branch: feature/homepage");
    expect(warning).toContain("Working tree: dirty (2 changed paths)");
  });

  it("requires the phase-specific confirmation words", async () => {
    const snapshot = readManualDeploymentSnapshot({ git: createGit() });
    await expect(confirmManualDocsDeployment({ snapshot, phase: "before-build", prompt: async () => "continue", warn: vi.fn() })).resolves.toBeUndefined();
    await expect(confirmManualDocsDeployment({ snapshot, phase: "before-deploy", prompt: async () => "deploy", warn: vi.fn() })).resolves.toBeUndefined();
    await expect(confirmManualDocsDeployment({ snapshot, phase: "before-build", prompt: async () => "yes", warn: vi.fn() })).rejects.toThrow("cancelled before the build");
    await expect(confirmManualDocsDeployment({ snapshot, phase: "before-deploy", prompt: async () => "yes", warn: vi.fn() })).rejects.toThrow("cancelled before the upload");
  });

  it("requires a terminal for the manual prompt", async () => {
    await expect(promptInTerminal("Deploy?", {
      input: { isTTY: false } as NodeJS.ReadStream,
      output: { isTTY: true } as NodeJS.WriteStream,
    })).rejects.toThrow("requires an interactive terminal");
  });

  it("allows CI only for the checked-out canonical main workflow commit", () => {
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "standardagents/brolly",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: HEAD,
    };
    expect(verifyCiDocsDeployment({ env, git: createGit() })).toEqual({ head: HEAD });
  });

  it.each([
    [{}, "requires GitHub Actions"],
    [{ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "someone/brolly" }, "requires repository standardagents/brolly"],
    [{ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "standardagents/brolly", GITHUB_REF: "refs/heads/feature" }, "requires refs/heads/main"],
    [{ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "standardagents/brolly", GITHUB_REF: "refs/heads/main", GITHUB_SHA: "a".repeat(40) }, "must match checked-out HEAD"],
  ])("blocks an invalid CI environment", (env, message) => {
    expect(() => verifyCiDocsDeployment({ env, git: createGit() })).toThrow(message);
  });

  it("asks once before building and again before deployment", async () => {
    const run = vi.fn(() => "");
    const prompt = vi.fn()
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("deploy");
    await deployDocs({ git: createGit(), run, prompt, warn: vi.fn() });
    expect(run.mock.calls.map(call => call[1])).toEqual([
      ["build"],
      ["exec", "wrangler", "deploy", "--config", "wrangler.production.jsonc"],
    ]);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[0]?.[0]).toContain('Type "continue"');
    expect(prompt.mock.calls[1]?.[0]).toContain('Type "deploy"');
  });

  it("stops after the build when the final confirmation is declined", async () => {
    const run = vi.fn(() => "");
    const prompt = vi.fn()
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("stop");
    await expect(deployDocs({ git: createGit(), run, prompt, warn: vi.fn() })).rejects.toThrow("cancelled before the upload");
    expect(run.mock.calls.map(call => call[1])).toEqual([["build"]]);
  });

  it("keeps the CI path build-only and environment-gated", async () => {
    const run = vi.fn(() => "");
    await deployDocs({
      args: ["--ci", "--built"],
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "standardagents/brolly",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: HEAD,
      },
      git: createGit(),
      run,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toEqual(["exec", "wrangler", "deploy", "--config", "wrangler.ci.jsonc"]);
  });
});
