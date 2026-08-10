const TOKEN_KEY = "brolly.adminToken";

export function savedToken(): string { return localStorage.getItem(TOKEN_KEY) ?? ""; }
export function rememberToken(token: string): void { localStorage.setItem(TOKEN_KEY, token); }
export function forgetToken(): void { localStorage.removeItem(TOKEN_KEY); }

export async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({ error: `Request failed (${response.status})` })) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}
