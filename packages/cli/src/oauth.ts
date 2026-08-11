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
      if (url.searchParams.get("state") !== expectedState) {
        respondWithResult(response, 400, "Connection rejected", "The Cloudflare login state did not match this Brolly installer. Return to the terminal and try again.", false);
        rejectCode(new Error("Cloudflare OAuth state mismatch"));
        return;
      }
      const value = url.searchParams.get("code");
      if (!value) {
        const message = url.searchParams.get("error_description") ?? "Cloudflare did not return an authorization code.";
        respondWithResult(response, 400, "Cloudflare connection failed", message, false);
        rejectCode(new Error(message));
        return;
      }
      respondWithResult(response, 200, "Cloudflare connected", "Authorization is complete. Brolly is finishing deployment in the terminal that opened this page.", true);
      resolveCode(value);
    });
    server.once("error", reject);
    server.listen(8976, "127.0.0.1", () => {
      resolve({ server, redirectUri: CLI_OAUTH_REDIRECT_URI, code });
    });
  });
}

function respondWithResult(response: import("node:http").ServerResponse, status: number, title: string, detail: string, success: boolean): void {
  const safeTitle = escapeHtml(title);
  const safeDetail = escapeHtml(detail);
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  }).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle} · Brolly</title><style>
    :root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f7f8;color:#1f2937}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 50% 0,#fff4ea 0,transparent 42%),#f7f7f8}.card{width:min(520px,100%);background:#fff;border:1px solid #dedfe3;border-radius:18px;padding:34px;box-shadow:0 20px 60px #11182714}.brand{display:flex;align-items:center;gap:11px;font-size:21px;font-weight:750}.mark{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;background:#f6821f;color:#fff;font-size:22px}.status{display:inline-flex;align-items:center;gap:8px;margin:30px 0 12px;padding:6px 10px;border-radius:999px;background:${success ? "#eaf8f0" : "#fff0ed"};color:${success ? "#087443" : "#b42318"};font-size:12px;font-weight:750;text-transform:uppercase;letter-spacing:.06em}.dot{width:7px;height:7px;border-radius:50%;background:currentColor}h1{margin:0 0 10px;font-size:30px;letter-spacing:-.03em}p{margin:0;color:#667085;font-size:16px;line-height:1.6}.hint{margin-top:28px;padding-top:20px;border-top:1px solid #ececef;font-size:13px;color:#7c8492}
  </style></head><body><main class="card"><div class="brand"><span class="mark" aria-hidden="true">☂</span><span>Brolly</span></div><div class="status"><span class="dot"></span>${success ? "Connected" : "Needs attention"}</div><h1>${safeTitle}</h1><p>${safeDetail}</p><p class="hint">${success ? "You may close this tab. No further action is required in the browser." : "Return to the terminal that launched this page for the error and next step."}</p></main></body></html>`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function base64url(value: Buffer): string { return value.toString("base64url"); }
