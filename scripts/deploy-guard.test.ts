import { describe, expect, it, vi } from "vitest";
import { CREDENTIAL_SECRET, createCredentialKey, deployGuard, parseSecretList } from "./deploy-guard.mjs";

describe("Brolly guard deployment", () => {
  it("generates a 256-bit base64url credential key", () => {
    const key = createCredentialKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(key, "base64url")).toHaveLength(32);
  });

  it("preserves an existing credential key", async () => {
    const calls: Array<{ args: string[]; options?: { input?: string; output?: string } }> = [];
    const runWrangler = vi.fn(async (args: string[], options?: { input?: string; output?: string }) => {
      calls.push({ args, options });
      return { stdout: args[0] === "secret" ? JSON.stringify([{ name: CREDENTIAL_SECRET, type: "secret_text" }]) : "" };
    });
    const createKey = vi.fn(() => "x".repeat(43));

    await expect(deployGuard({ config: "/tmp/config.json", runWrangler, createKey, log: vi.fn() })).resolves.toEqual({ created: false });

    expect(calls.map(call => call.args.slice(0, 2))).toEqual([["deploy", "--config"], ["secret", "list"]]);
    expect(createKey).not.toHaveBeenCalled();
  });

  it("creates a 256-bit key only after a successful missing-secret check", async () => {
    const calls: Array<{ args: string[]; options?: { input?: string; output?: string } }> = [];
    const key = "a".repeat(43);
    const runWrangler = vi.fn(async (args: string[], options?: { input?: string; output?: string }) => {
      calls.push({ args, options });
      return { stdout: args[0] === "secret" && args[1] === "list" ? "[]" : "" };
    });

    await expect(deployGuard({ config: "/tmp/config.json", runWrangler, createKey: () => key, log: vi.fn() })).resolves.toEqual({ created: true });

    expect(calls).toHaveLength(3);
    expect(calls[2]?.args).toEqual(["secret", "put", CREDENTIAL_SECRET, "--config", "/tmp/config.json"]);
    expect(calls[2]?.args).not.toContain(key);
    expect(calls[2]?.options?.input).toBe(`${key}\n`);
  });

  it("fails closed when the secret listing fails", async () => {
    const runWrangler = vi.fn(async (args: string[]) => {
      if (args[0] === "secret") throw new Error("Cloudflare unavailable");
      return { stdout: "" };
    });
    const createKey = vi.fn(() => "a".repeat(43));

    await expect(deployGuard({ runWrangler, createKey, log: vi.fn() })).rejects.toThrow("Cloudflare unavailable");
    expect(createKey).not.toHaveBeenCalled();
    expect(runWrangler).toHaveBeenCalledTimes(2);
  });

  it("does not generate a key when Cloudflare returns a malformed list", async () => {
    const runWrangler = vi.fn(async (args: string[]) => ({ stdout: args[0] === "secret" ? "not json" : "" }));
    const createKey = vi.fn(() => "a".repeat(43));

    await expect(deployGuard({ runWrangler, createKey, log: vi.fn() })).rejects.toThrow("unreadable Worker secret list");
    expect(createKey).not.toHaveBeenCalled();
    expect(runWrangler).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed or invalid secret-list responses", () => {
    expect(() => parseSecretList("not json")).toThrow("unreadable Worker secret list");
    expect(() => parseSecretList("{}")).toThrow("invalid Worker secret list");
    expect(() => parseSecretList('[{"type":"secret_text"}]')).toThrow("invalid Worker secret list");
  });
});
