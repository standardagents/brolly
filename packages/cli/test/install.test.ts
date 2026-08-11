import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWorkerConfig, encryptCredentials } from "../src/install.js";
import { CLI_OAUTH_REDIRECT_URI, createPkcePair } from "../src/oauth.js";

describe("Brolly installer cryptography", () => {
  it("creates an RFC 7636 PKCE verifier/challenge pair", () => {
    const pair = createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).not.toBe(pair.verifier);
  });

  it("uses the redirect URI registered on Brolly's publisher OAuth client", () => {
    expect(CLI_OAUTH_REDIRECT_URI).toBe("http://127.0.0.1:8976/callback");
  });

  it("routes the shared OAuth callback through the Worker before static assets", () => {
    const config = createWorkerConfig({
      accountId: "account", clientId: "client", databaseId: "database",
      workerPath: "/worker.js", assetsPath: "/assets",
    }) as { assets: { run_worker_first: string[] } };
    expect(config.assets.run_worker_first).toContain("/oauth/callback");
  });

  it("writes AES-GCM envelopes readable by the Worker", async () => {
    const keyBytes = Buffer.alloc(32, 7);
    const envelope = JSON.parse(encryptCredentials({ accessToken: "secret", expiresAt: 123 }, keyBytes)) as { iv: string; ciphertext: string };
    const key = await webcrypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    const plaintext = await webcrypto.subtle.decrypt(
      { name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64url") },
      key,
      Buffer.from(envelope.ciphertext, "base64url"),
    );
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({ accessToken: "secret", expiresAt: 123 });
  });
});
