import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

export interface OAuthResult { accessToken: string; refreshToken?: string; expiresIn?: number }

export const CLI_OAUTH_REDIRECT_URI = "http://127.0.0.1:8976/callback";

export async function authorizeCloudflare(clientId: string, scopes: string[], open: (url: string) => Promise<void>): Promise<OAuthResult> {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(24));
  const { server, redirectUri, code } = await callbackServer(state);
  const authorization = new URL("https://dash.cloudflare.com/oauth2/auth");
  authorization.search = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri,
    scope: scopes.join(" "), state, code_challenge: challenge, code_challenge_method: "S256",
  }).toString();
  await open(authorization.toString());
  try {
    const authorizationCode = await code;
    const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: authorizationCode, redirect_uri: redirectUri, code_verifier: verifier }),
    });
    if (!response.ok) throw new Error(`Cloudflare OAuth exchange failed (${response.status}): ${await response.text()}`);
    const payload = await response.json() as { access_token: string; refresh_token?: string; expires_in?: number };
    return { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresIn: payload.expires_in };
  } finally {
    server.close();
  }
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

function callbackServer(expectedState: string): Promise<{ server: ReturnType<typeof createServer>; redirectUri: string; code: Promise<string> }> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.pathname !== "/callback") { response.writeHead(404).end(); return; }
      if (url.searchParams.get("state") !== expectedState) { response.writeHead(400).end("Invalid OAuth state"); rejectCode(new Error("Cloudflare OAuth state mismatch")); return; }
      const value = url.searchParams.get("code");
      if (!value) { response.writeHead(400).end("Missing authorization code"); rejectCode(new Error(url.searchParams.get("error_description") ?? "Cloudflare OAuth was denied")); return; }
      response.writeHead(200, { "content-type": "text/html" }).end("<h1>Brolly is connected</h1><p>You can close this tab and return to your terminal.</p>");
      resolveCode(value);
    });
    server.once("error", reject);
    server.listen(8976, "127.0.0.1", () => {
      resolve({ server, redirectUri: CLI_OAUTH_REDIRECT_URI, code });
    });
  });
}

function base64url(value: Buffer): string { return value.toString("base64url"); }
