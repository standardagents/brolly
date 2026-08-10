export async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(token && token !== "session" ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({ error: `Request failed (${response.status})` })) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

export interface AuthSession {
  authenticated: boolean;
  oauthConfigured: boolean;
  credentialStorageReady: boolean;
  actor: { name: string; kind: "session" | "break_glass" } | null;
  account: { id: string; name: string } | null;
}

export async function authSession(): Promise<AuthSession> {
  const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
  return response.json<AuthSession>();
}

export async function logoutSession(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
}
