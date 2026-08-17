import { Brand, CloudflareLogo, Eyebrow, Notice } from "../components/ui";

/**
 * Primary sign-in control. It is an anchor when OAuth can start and a disabled
 * button otherwise, so both states carry the primary geometry inline. The
 * shared Button is not used: its icon rule would shrink the 24px Cloudflare mark.
 */
function SignInAction({ href }: { href?: string }) {
  const className = "mb-2.5 inline-flex min-h-[46px] w-full cursor-pointer items-center justify-center gap-[7px] rounded-field border border-orange bg-orange px-3.5 text-[13.5px] font-[620] text-white transition-[background-color,border-color,box-shadow] duration-[130ms] not-disabled:hover:border-orange-hover not-disabled:hover:bg-orange-hover disabled:cursor-not-allowed disabled:opacity-50";
  if (href) return <a className={className} href={href}><CloudflareLogo /> Login with Cloudflare</a>;
  return <button className={className} type="button" disabled><CloudflareLogo /> Login with Cloudflare</button>;
}

export function LoginPage({ error, oauthConfigured, credentialStorageReady }: { error: string; oauthConfigured: boolean; credentialStorageReady: boolean }) {
  return (
    <main className="grid min-h-screen grid-cols-[minmax(420px,620px)_1fr] bg-bg text-ink max-md:grid-cols-[1fr]">
      <section className="flex flex-col justify-center p-[clamp(44px,8vw,100px)] max-md:px-6 max-md:py-[38px]">
        <Brand large />
        <Eyebrow tone="orange" className="mt-14 max-md:mt-11">Cloudflare cost control</Eyebrow>
        <h1 className="m-0 mb-[22px] text-[clamp(42px,5.2vw,68px)] leading-[.98] tracking-[-.05em]">See the spike.<br />Stop the spend.</h1>
        <p className="mb-[30px] max-w-[470px] text-[16px] leading-[1.6] text-muted">Use Cloudflare to prove who you are and choose the one account this Brolly installation should protect.</p>
        {error && <Notice tone="error" className="mb-3.5">{error}</Notice>}
        {!oauthConfigured && <Notice tone="error" className="mb-3.5">This Brolly release is missing its publisher OAuth client. The installer does not need to create one.</Notice>}
        {!credentialStorageReady && <Notice tone="error" className="mb-3.5">Automatic credential-key setup did not complete. Redeploy Brolly, or add <code className="font-mono text-[.92em] break-all">BROLLY_CREDENTIAL_KEY</code> as a Worker secret, before signing in.</Notice>}
        <SignInAction href={oauthConfigured && credentialStorageReady ? "/api/auth/login" : undefined} />
      </section>
      <div
        className="relative grid place-items-center overflow-hidden bg-[radial-gradient(circle_at_55%_45%,#ffd9ba_0,#fff2e7_34%,#f2f4f6_72%)] max-md:hidden dark:bg-[radial-gradient(circle_at_55%_45%,#55341e_0,#1a1d22_32%,#0d0f12_70%)]"
        aria-hidden="true"
      >
        <div className="absolute size-[40vw] rounded-full border border-[#f6821f55] dark:border-[#f6821f45]" />
        <div className="absolute size-[62vw] rounded-full border border-[#f6821f55] dark:border-[#f6821f45]" />
        <div className="text-[clamp(120px,18vw,280px)] text-orange drop-shadow-[0_28px_60px_#7b3d151f] dark:drop-shadow-[0_28px_60px_#0008]">☁</div>
      </div>
    </main>
  );
}

export function LoadingScreen() {
  return (
    <main className="grid h-screen place-content-center justify-items-center gap-5 bg-bg text-ink">
      <Brand large />
      <div className="flex gap-1.5">
        <span className="size-2 animate-loader-dot rounded-full bg-orange" />
        <span className="size-2 animate-loader-dot rounded-full bg-orange [animation-delay:.15s]" />
        <span className="size-2 animate-loader-dot rounded-full bg-orange [animation-delay:.3s]" />
      </div>
      <p>Opening the umbrella…</p>
    </main>
  );
}
