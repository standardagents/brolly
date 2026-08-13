import { Brand, CloudflareLogo } from "../components/ui";

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
        {!credentialStorageReady && <p className="form-error">Automatic credential-key setup did not complete. Redeploy Brolly, or add <code>BROLLY_CREDENTIAL_KEY</code> as a Worker secret, before signing in.</p>}
        {oauthConfigured && credentialStorageReady
          ? <a className="button primary full mb-2.5 min-h-[46px]" href="/api/auth/login"><CloudflareLogo /> Login with Cloudflare</a>
          : <button className="button primary full mb-2.5 min-h-[46px]" type="button" disabled><CloudflareLogo /> Login with Cloudflare</button>}
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
