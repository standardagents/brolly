import { Brand } from "../components/ui";

export function LoginPage({ error, oauthConfigured, credentialStorageReady }: { error: string; oauthConfigured: boolean; credentialStorageReady: boolean }) {
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <Brand large />
        <p className="eyebrow">Cloudflare cost control</p>
        <h1>See the spike.<br />Stop the spend.</h1>
        <p className="auth-copy">Use Cloudflare to prove who you are and choose the one account this Brolly installation should protect.</p>
        {error && <p className="form-error">{error}</p>}
        {!oauthConfigured && <p className="form-error">This Brolly release is missing its publisher OAuth client. The installer does not need to create one.</p>}
        {!credentialStorageReady && <p className="form-error">Credential encryption is missing. Add <code>BROLLY_CREDENTIAL_KEY</code> as a Worker secret before signing in.</p>}
        {oauthConfigured && credentialStorageReady
          ? <a className="button primary full" href="/api/auth/login">Continue with Cloudflare</a>
          : <button className="button primary full" type="button" disabled>Continue with Cloudflare</button>}
        <p className="fine-print">Cloudflare shows the exact account and permissions before you approve access. Brolly stores an encrypted, revocable OAuth grant in your own D1 database. <a className="link-button inline" href="/docs">Learn how Brolly works.</a></p>
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
