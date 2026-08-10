import { useState, type FormEvent } from "react";
import { Brand } from "../components/ui";

export function LoginPage({ onLogin, error }: { onLogin: (token: string) => Promise<void>; error: string }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    try {
      await onLogin(value.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <Brand large />
        <p className="eyebrow">Cloudflare cost control</p>
        <h1>See the spike.<br />Stop the spend.</h1>
        <p className="auth-copy">Sign in with the admin token created when this Brolly guard was installed.</p>
        <form onSubmit={submit}>
          <label htmlFor="admin-token">Brolly admin token</label>
          <input
            id="admin-token"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={value}
            onChange={event => setValue(event.target.value)}
            placeholder="Paste token"
          />
          {error && <p className="form-error">{error}</p>}
          <button className="button primary full" disabled={busy || !value.trim()}>{busy ? "Checking…" : "Open Brolly"}</button>
        </form>
        <p className="fine-print">The token stays in this browser. Brolly never sends it to a third party. <a className="link-button inline" href="/docs">Learn how Brolly works.</a></p>
      </section>
      <div className="auth-art" aria-hidden="true">
        <div className="radar-ring one" />
        <div className="radar-ring two" />
        <div className="auth-cloud">☁</div>
      </div>
    </main>
  );
}

export function LoadingScreen() {
  return (
    <main className="loading-screen">
      <Brand large />
      <div className="loader"><span /><span /><span /></div>
      <p>Opening the umbrella…</p>
    </main>
  );
}
