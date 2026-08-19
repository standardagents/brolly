import { Fragment, useEffect, useRef, type ReactNode } from "react";
import billingStories from "../../../docs/cloudflare-x-post-images/posts.json";

const DEPLOY_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/standardagents/brolly/tree/deploy-template";
const GITHUB_URL = "https://github.com/standardagents/brolly";
const SERVICES = [
  ["durable-objects", "Durable Objects"],
  ["workers", "Workers"],
  ["d1", "D1"],
  ["r2", "R2"],
  ["kv", "KV"],
  ["queues", "Queues"],
  ["workers-ai", "Workers AI"],
  ["ai-gateway", "AI Gateway"],
] as const;

const EDGE = "px-[max(24px,calc((100vw-1240px)/2))]";
const BUTTON = "min-h-[46px] inline-flex items-center justify-center gap-2 rounded-lg px-5 font-[750] transition-[transform,background-color,border-color] duration-150 ease-[ease] hover:-translate-y-px max-[680px]:w-full";
const PRIMARY = `${BUTTON} border border-[#ff963f] bg-orange text-white shadow-[0_12px_36px_#f6821f29] hover:bg-[#ff8c2d]`;
const SECONDARY = `${BUTTON} border border-[#343a42] bg-[#15181d] text-[#e6e9ed] hover:border-[#5c6570] light:border-[#c9cfd6] light:bg-white light:text-[#272b30] light:hover:border-[#969fa9]`;
const NAV_LINK = "hover:text-white light:hover:text-[#111317] max-[960px]:hidden";
const FOOTER_LINK = "hover:text-white light:hover:text-[#111317]";
const BRAND = "inline-flex items-center gap-[9px] text-xl tracking-[-.035em]";
const SECTION_H2 = "text-[clamp(34px,4vw,50px)] leading-[1.08] tracking-[-.02em]";
const DOCS_H2 = "text-[clamp(31px,4vw,43px)] leading-[1.08] tracking-[-.02em]";
const DOCS_H3 = "mt-[38px] mb-3 text-[17px]";
const DOCS_P = "my-5 text-muted text-base leading-[1.75]";
const ASIDE_LINK = "py-[5px] pl-[11px] border-l border-[#313740] text-[#78828e] text-[12.5px] hover:border-orange hover:text-white light:border-[#cfd5dc] light:text-[#68727e] light:hover:text-[#111317] max-[960px]:py-1.5 max-[960px]:px-2.5 max-[960px]:border max-[960px]:rounded-full";
const CALLOUT = "my-6 flex items-start gap-[11px] rounded-[9px] border border-line bg-[#15191e] px-[18px] py-4 light:bg-white";
const CALLOUT_P = "text-[#a9b2bd] text-[13px] leading-[1.6] light:text-[#5f6874]";
const CALLOUT_STRONG = "text-white light:text-ink";
const CALLOUT_ORANGE = "my-6 flex items-center justify-between gap-[11px] rounded-[9px] border border-[#6c3b1d] bg-[#23170f] px-[18px] py-4 light:border-[#efbf98] light:bg-[#fff6ef] max-[680px]:flex-col max-[680px]:items-start";
const CALLOUT_ORANGE_SMALL = "mt-0.5 text-[#bda996] light:text-[#786657]";
const NUMBERED_LI = "flex gap-3.5 border-t border-[#23282e] py-[17px] light:border-[#e2e5e8]";
const NUMBERED_B = "grid size-[27px] flex-none place-items-center rounded-full bg-orange text-white text-[11px] light:bg-orange light:text-white";
const NUMBERED_P = "text-[13px] leading-[1.6] text-[#8f99a4] light:text-[#626c78]";
const PANEL_CARD = "rounded-lg border border-[#293038] bg-[#14181d] p-4 light:border-[#dce1e5] light:bg-white";
const CHECKS_LI = "flex items-start gap-[11px] border-t border-[#242a30] py-[13px] leading-[1.55] text-[#9da7b2] light:border-[#dfe3e7] light:text-[#5f6874]";
const CHECKS_STRONG = "text-[#edf0f3] light:text-[#181a1d]";
const CODE_INLINE = "text-[#ef9d5b] light:text-[#a94b08]";

function HeroUmbrella() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    // The simulation (three.js included) lives in a lazy chunk so the
    // prerendered page hydrates on a small critical bundle; the hero starts
    // once the browser is idle.
    const start = () => {
      void import("./hero.js").then(({ initHero }) => {
        if (!cancelled) cleanup = initHero(mount);
      });
    };
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(start, { timeout: 1500 });
    else setTimeout(start, 200);
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  // Desktop: full-bleed background layer behind the hero text. Under 900px
  // the canvas becomes its own block below the text, so the umbrella never
  // fights the headline for the same pixels.
  return <div ref={mountRef} className="absolute inset-0 -z-10 overflow-hidden max-[900px]:relative max-[900px]:inset-auto max-[900px]:z-0 max-[900px]:mt-5 max-[900px]:mb-7 max-[900px]:-mx-6 max-[680px]:-mx-4 max-[900px]:h-[58vw] max-[900px]:min-h-[260px] max-[900px]:border-b max-[900px]:border-[#ffffff12] max-[900px]:light:border-[#00000014] max-[900px]:after:pointer-events-none max-[900px]:after:absolute max-[900px]:after:inset-x-0 max-[900px]:after:bottom-0 max-[900px]:after:h-5 max-[900px]:after:content-[''] max-[900px]:after:bg-[linear-gradient(to_top,rgba(0,0,0,0.08),transparent)] max-[900px]:before:content-[''] max-[900px]:before:absolute max-[900px]:before:inset-0 max-[900px]:before:-z-10 max-[900px]:before:opacity-45 max-[900px]:before:bg-[linear-gradient(#ffffff12_1px,transparent_1px),linear-gradient(90deg,#ffffff12_1px,transparent_1px)] max-[900px]:before:bg-[size:54px_54px] max-[900px]:before:[mask-image:linear-gradient(to_bottom,transparent,#000_28%)] max-[900px]:light:before:opacity-[.62] max-[900px]:light:before:bg-[linear-gradient(#1d1f2112_1px,transparent_1px),linear-gradient(90deg,#1d1f2112_1px,transparent_1px)]" aria-hidden="true" />;
}

export function App() {
  return (
    <div className="min-h-screen overflow-hidden bg-bg">
      <a className="fixed left-3 -top-12 z-[100] rounded-md bg-orange px-3.5 py-[9px] font-[750] focus:top-3" href="#main">Skip to content</a>
      <header className={`sticky top-0 z-30 flex h-[68px] items-center justify-between gap-7 ${EDGE} border-b border-[#ffffff12] bg-[#0b0d10e8] backdrop-blur-[14px] light:border-[#dfe3e7] light:bg-[#fffffff0] max-[680px]:h-[62px] max-[680px]:px-[15px]`}>
        <a className={BRAND} href="#top" aria-label="Brolly home"><Umbrella /><strong>Brolly</strong></a>
        <nav className="flex items-center gap-[25px] text-[13px] font-[650] text-[#a9b2bd] light:text-[#5f6874]" aria-label="Primary navigation">
          <a className={NAV_LINK} href="#how-it-works">How it works</a>
          <a className={NAV_LINK} href="#install">Install</a>
          <a className={NAV_LINK} href="#runtime">Runtime fuse</a>
          <a className={NAV_LINK} href={GITHUB_URL}>GitHub</a>
          <a className="inline-flex min-h-9 items-center gap-[7px] rounded-[7px] border border-[#4a5058] bg-[#171a1f] px-3.5 text-white light:border-[#c8ced5] light:bg-white light:text-[#202327]" href={DEPLOY_URL}><CloudflareLogo className="w-[18px] text-orange" /> Deploy Brolly</a>
        </nav>
      </header>

      <main id="main">
        <section className={`relative isolate min-h-[710px] overflow-hidden ${EDGE} pt-[120px] pb-[90px] max-[1200px]:min-h-[580px] max-[960px]:min-h-0 max-[960px]:pt-[76px] max-[680px]:px-4 max-[680px]:pt-[58px] max-[680px]:pb-[60px]`} id="top">
          <div className="absolute inset-0 -z-[9] bg-[linear-gradient(90deg,var(--color-bg)_0%,var(--color-bg)_24%,transparent_62%)] light:bg-[linear-gradient(90deg,#f7f7f8_0%,#f7f7f8_24%,transparent_62%)] max-[900px]:hidden" aria-hidden="true" />
          <div className="absolute -right-[230px] -top-[220px] -z-[8] size-[760px] rounded-full bg-[radial-gradient(circle,#f6821f24_0,#f6821f08_43%,transparent_70%)] light:bg-[radial-gradient(circle,#f6821f20_0,#f6821f09_43%,transparent_70%)]" aria-hidden="true" />
          <div className="absolute inset-0 -z-[11] opacity-45 bg-[linear-gradient(#ffffff12_1px,transparent_1px),linear-gradient(90deg,#ffffff12_1px,transparent_1px)] bg-[size:54px_54px] [mask-image:linear-gradient(to_bottom,#000,transparent_94%)] max-[900px]:hidden light:opacity-[.62] light:bg-[linear-gradient(#1d1f2112_1px,transparent_1px),linear-gradient(90deg,#1d1f2112_1px,transparent_1px)]" aria-hidden="true" />
          <div className="relative z-[1] max-w-[640px] motion-safe:animate-rise">
            <h1 className="font-display max-w-[640px] text-[clamp(48px,5.4vw,78px)] leading-[.98] tracking-[-.02em] max-[680px]:text-[45px]">Protect yourself from runaway Cloudflare spend</h1>
            <p className="mt-[27px] mb-[30px] max-w-[580px] text-[clamp(16px,1.5vw,19px)] leading-[1.65] text-[#b3bcc6] light:text-[#4f5965]">Brolly is a free and open source <strong>monitor</strong> and <strong>circuit breaker</strong> that covers all billable Cloudflare services.</p>
          </div>
          <HeroUmbrella />
          <div className="relative z-[1] max-w-[640px] motion-safe:animate-rise">
            <div className="flex flex-wrap items-center gap-3">
              <a className={PRIMARY} href={DEPLOY_URL}><CloudflareLogo /> Deploy to Cloudflare</a>
              <a className={SECONDARY} href="#how-it-works">See how it works <Arrow /></a>
            </div>
            <p className="mt-[13px] max-w-[570px] text-[11.5px] leading-normal text-[#737d89] light:text-[#747e89]">Installation is per account. Your policies, credentials, incidents, and audit history are private and stay within your assigned Cloudflare account.</p>
          </div>
        </section>

        <section className={`${EDGE} border-y border-[#ffffff10] bg-[#0e1115] py-[22px] light:border-[#e2e5e8] light:bg-[#f1f3f5]`} aria-label="Cloudflare product coverage">
          <p className="mb-3.5 text-center text-[10px] font-[780] uppercase tracking-[.1em] text-[#6f7985] light:text-[#747e89]">Brolly covers every billable Cloudflare service.</p>
          <div className="flex flex-wrap items-center justify-center gap-[clamp(18px,3vw,42px)] max-[680px]:gap-x-[18px] max-[680px]:gap-y-3">{SERVICES.map(([icon, label]) => <span className="inline-flex items-center gap-2 text-xs text-[#9ba5b0] light:text-[#56606b]" key={icon}><img className="size-6 grayscale brightness-[6] light:opacity-[.72] light:brightness-[.7]" src={`/cloudflare-icons/${icon}.svg`} alt="" /><b>{label}</b></span>)}</div>
        </section>

        <section className="overflow-hidden border-b border-[#ffffff0d] bg-bg bg-[radial-gradient(circle_at_50%_0,#f6821f0c,transparent_35%)] pt-24 pb-[92px] light:border-[#e3e6e9] light:bg-white light:bg-[radial-gradient(circle_at_50%_0,#f6821f12,transparent_35%)] max-[680px]:pt-[72px] max-[680px]:pb-[68px]" id="stories" aria-labelledby="stories-title">
          <div className="mx-auto mb-[42px] w-[min(760px,calc(100%-48px))] text-center max-[680px]:mb-7 max-[680px]:w-[calc(100%-32px)] max-[680px]:text-left">
            <h2 className="text-[clamp(36px,4.6vw,58px)] leading-[1.04] tracking-[-.025em]" id="stories-title">See runaway usage while there is time to respond.</h2>
            <p className="mx-auto mt-[19px] max-w-[660px] text-base leading-[1.65] text-muted max-[680px]:text-sm">A single undetected runaway loop can result in a five-figure invoice. Brolly defends your wallet with robust <strong>alerts</strong> and a configurable <strong>circuit breaker</strong>.</p>
          </div>
          <div className="mx-auto grid w-[min(1200px,calc(100%-48px))] grid-cols-1 gap-5 pt-2.5 sm:grid-cols-2 lg:grid-cols-3 max-[680px]:w-[calc(100%-32px)] max-[680px]:gap-4">
            <StoryGroup />
          </div>
        </section>

        <section className="mx-auto max-w-[1240px] px-6 py-[108px] max-[680px]:px-4 max-[680px]:py-[78px]" id="how-it-works">
          <h2 className={SECTION_H2}>A durable Cloudflare usage ledger with granular protection.</h2>
          <p className="mt-[18px] mb-[42px] max-w-[680px] text-[17px] leading-[1.65] text-muted">Brolly retains daily account, product, namespace, Worker, and individual-resource history in your D1 database. Eligible Workers and Durable Objects support audited reversible quarantine.</p>
          <div className="grid grid-cols-4 gap-3 max-[960px]:grid-cols-2 max-[680px]:grid-cols-1">
            <Card number="01" icon={<Radar className="size-11 text-orange" />} title="Explore stored usage">Drill from account totals into products, namespaces, Workers, exact object IDs, metrics, and daily evidence quality.</Card>
            <Card number="02" icon={<Alert className="size-11 text-orange" />} title="Set explicit limits">Create ordered alert levels with per-level thresholds for account-local days or Cloudflare billing cycles.</Card>
            <Card number="03" icon={<Shield className="size-11 text-orange" />} title="Contain exact runaways">Prepare or Auto entries can contain eligible Workers, Durable Objects, and Queues after a qualified breach.</Card>
            <Card number="04" icon={<Refresh className="size-11 text-orange" />} title="Restore quarantined objects">Restore quarantined objects after fixes are applied. Brolly preserves the resource, storage, messages, and history with no data loss.</Card>
          </div>
        </section>

        <div className="mx-auto grid max-w-[1160px] grid-cols-[180px_minmax(0,820px)] justify-center gap-[60px] px-6 pt-[18px] pb-[110px] max-[960px]:grid-cols-1 max-[680px]:gap-[35px] max-[680px]:px-4 max-[680px]:pt-[15px] max-[680px]:pb-[75px]">
          <aside className="sticky top-[92px] flex flex-col gap-1 self-start pt-[54px] max-[960px]:static max-[960px]:flex-row max-[960px]:flex-wrap max-[960px]:gap-[5px] max-[960px]:p-0">
            <strong className="mb-2 text-xs text-[#d9dee4] light:text-[#31363c] max-[960px]:w-full">On this page</strong>
            <a className={ASIDE_LINK} href="#install">Install</a>
            <a className={ASIDE_LINK} href="#limits">Limits</a>
            <a className={ASIDE_LINK} href="#runtime">Runtime fuse</a>
            <a className={ASIDE_LINK} href="#notifications">Notifications</a>
            <a className={ASIDE_LINK} href="#safety">Safety model</a>
          </aside>
          <div className="min-w-0">
            <section className="py-[70px] first:border-t-0 border-t border-line max-[680px]:py-[55px]" id="install">
              <h2 className={DOCS_H2}>Deploy Brolly to your Cloudflare account</h2>
              <p className={DOCS_P}>Install Brolly in the Cloudflare account you want to protect. When deployment finishes, open your private dashboard and sign in with Cloudflare.</p>
              <div className={CALLOUT_ORANGE}><span className="flex items-center gap-[11px]"><CloudflareLogo className="text-orange" /><span className="flex flex-col"><strong>Runs in your Cloudflare account</strong><small className={CALLOUT_ORANGE_SMALL}>Your limits, incidents, and controls stay in your own deployment.</small></span></span><a className={`${PRIMARY} flex-none`} href={DEPLOY_URL}><CloudflareLogo /> Deploy to Cloudflare</a></div>
              <ol className="my-7 list-none p-0">
                <li className={NUMBERED_LI}><b className={NUMBERED_B}>1</b><span><strong className="mb-[3px] block">Deploy to Cloudflare.</strong><p className={NUMBERED_P}>Choose your Cloudflare account and a name for the Brolly Worker, then click Deploy.</p></span></li>
                <li className={NUMBERED_LI}><b className={NUMBERED_B}>2</b><span><strong className="mb-[3px] block">Open Brolly and sign in.</strong><p className={NUMBERED_P}>Visit the private Brolly URL created for you and authorize the Cloudflare account you want it to protect.</p></span></li>
                <li className={NUMBERED_LI}><b className={NUMBERED_B}>3</b><span><strong className="mb-[3px] block">Review what Brolly found.</strong><p className={NUMBERED_P}>See your Workers, Durable Object namespaces, individual objects, current usage, and any monitoring gaps.</p></span></li>
                <li className={NUMBERED_LI}><b className={NUMBERED_B}>4</b><span><strong className="mb-[3px] block">Choose your protection.</strong><p className={NUMBERED_P}>Connect labeled channels, arrange alert levels, set per-level limits, and review action eligibility.</p></span></li>
              </ol>
              <div className={CALLOUT_ORANGE}><span className="flex items-center gap-[11px]"><Check className="text-orange" /><span className="flex flex-col"><strong>You are ready to protect your account</strong><small className={CALLOUT_ORANGE_SMALL}>Review your channel delivery, alert-level entries, limits, and runtime evidence before using Auto actions.</small></span></span></div>
              <div className={CALLOUT}><Info className="mt-0.5 text-[#909aa5]" /><p className={CALLOUT_P}><strong className={CALLOUT_STRONG}>How do updates work?</strong> Save the GitHub repository name in Settings. While you use Brolly, it checks at most hourly and shows a banner for new releases. The button runs a repo-local workflow that opens a pull request for you to review; it never silently deploys. Private repositories work normally, no GitHub token is stored in Brolly, and your D1 binding, variables, and secrets are preserved.</p></div>
              <div className={CALLOUT}><Info className="mt-0.5 text-[#909aa5]" /><p className={CALLOUT_P}><strong className={CALLOUT_STRONG}>Who can sign in later?</strong> A Cloudflare member who can authorize Brolly's requested scopes for the bound account may sign in. A user who authorizes a different account is rejected. Changing accounts requires deliberately resetting the installation's D1 binding or deploying a new instance; the latest successful authorization supplies the revocable Cloudflare grant Brolly uses for monitoring and controls.</p></div>
              <div className={CALLOUT}><Info className="mt-0.5 text-[#909aa5]" /><p className={CALLOUT_P}><strong className={CALLOUT_STRONG}>What passes through Brolly's login service?</strong> Only the one-time Cloudflare authorization result. The separate stateless relay verifies the requesting installation, returns the short-lived code to that exact deployment, and never receives the access or refresh token stored in your D1 database.</p></div>
              <div className={CALLOUT}><Info className="mt-0.5 text-[#909aa5]" /><p className={CALLOUT_P}><strong className={CALLOUT_STRONG}>Billing reconciliation is optional but highly recommended.</strong> Start with one bounded monitoring-access check. Brolly shows the results first, then reveals OAuth reconnection or a prefilled, account-scoped Billing Read user-token form when needed. A verified billing token is encrypted inside your D1. You can add or replace it later in Settings. Risk tolerance uses imported history to seed each daily and billing-cycle chart.</p></div>
            </section>

            <section className="py-[70px] first:border-t-0 border-t border-line max-[680px]:py-[55px]" id="limits">
              <h2 className={DOCS_H2}>Set period limits throughout the resource hierarchy</h2>
              <p className={DOCS_P}>Choose one shared risk tolerance curve for every alert level. Each empty chart starts from the median historical usage for its scope. Daily limits use the account timezone. Cycle limits use reconciled Cloudflare boundaries. Saved chart values remain independent of later tolerance changes.</p>
              <div className="my-[26px] grid gap-2.5 sm:grid-cols-3">
                <article className={PANEL_CARD}><Alert className="text-[#9bc8ff]" /><strong className="mt-3 mb-1 block">Additive levels</strong><p className="text-[12.5px] leading-[1.55] text-[#8b96a1] light:text-[#626c78]">A firing level includes channel and action entries from every level before it.</p></article>
                <article className={PANEL_CARD}><Refresh className="text-[#ecc07a]" /><strong className="mt-3 mb-1 block">Prepared actions</strong><p className="text-[12.5px] leading-[1.55] text-[#8b96a1] light:text-[#626c78]">Prepare entries create an audited action for operator approval.</p></article>
                <article className={PANEL_CARD}><Shield className="text-[#ff9c96]" /><strong className="mt-3 mb-1 block">Auto actions</strong><p className="text-[12.5px] leading-[1.55] text-[#8b96a1] light:text-[#626c78]">Auto entries require fresh evidence, eligible resources, and verified runtime controls.</p></article>
              </div>
            </section>

            <section className="py-[70px] first:border-t-0 border-t border-line max-[680px]:py-[55px]" id="runtime">
              <h2 className={DOCS_H2}>A zero-I/O deployment fuse</h2>
              <p className={DOCS_P}>Monitoring works without application changes. Exact Worker and Durable Object quarantine uses the tiny <code className={CODE_INLINE}>@standardagents/brolly-runtime</code> package. Its hot path only parses a deployment binding and compares IDs. It performs no HTTP, KV, D1, or Durable Object storage operation.</p>
              <div className={CALLOUT_ORANGE}><span className="flex items-center gap-[11px]"><Shield className="text-orange" /><span className="flex flex-col"><strong>Give the install to your coding agent</strong><small className={CALLOUT_ORANGE_SMALL}>Brolly's final setup step builds one resource-aware prompt for Claude Code, Codex, Cursor, or another coding agent. It edits and tests your code, then stops before deployment so you can review and verify the result.</small></span></span></div>
              <Code label="Install">pnpm add @standardagents/brolly-runtime</Code>
              <h3 className={DOCS_H3}>One line in a Durable Object constructor</h3>
              <Code label="TypeScript">{`constructor(ctx: DurableObjectState, env: Env) {\n  super(ctx, env)\n  brollyDurableObject(ctx, env)\n}`}</Code>
              <h3 className={DOCS_H3}>Stop ingress before waking the object</h3>
              <Code label="TypeScript">{`brollyWorker(env)\nconst id = env.ROOMS.idFromName(name)\nbrollyWorker(env, { durableObjectId: id.toString() })\nreturn env.ROOMS.get(id).fetch(request)`}</Code>
              <div className="my-7 grid grid-cols-3 gap-2.5 max-[680px]:grid-cols-1">
                <article className={PANEL_CARD}><Check className="text-[#66d99d]" /><strong className="mt-3 mb-1 block">Preserved</strong><p className="text-[12.5px] leading-[1.55] text-[#8b96a1] light:text-[#626c78]">Object SQLite rows, messages, queues, and history remain intact.</p></article>
                <article className={PANEL_CARD}><Shield className="text-[#66d99d]" /><strong className="mt-3 mb-1 block">Isolated</strong><p className="text-[12.5px] leading-[1.55] text-[#8b96a1] light:text-[#626c78]">Only the named target ejects; unrelated object IDs continue serving.</p></article>
                <article className={PANEL_CARD}><Refresh className="text-[#66d99d]" /><strong className="mt-3 mb-1 block">Reversible</strong><p className="text-[12.5px] leading-[1.55] text-[#8b96a1] light:text-[#626c78]">Resume removes the fuse target through a new audited deployment.</p></article>
              </div>
            </section>

            <section className="py-[70px] first:border-t-0 border-t border-line max-[680px]:py-[55px]" id="notifications">
              <h2 className={DOCS_H2}>Wake the people who can respond</h2>
              <p className={DOCS_P}>Configure Cloudflare Email, Discord, Postmark, Resend, Slack, Twilio SMS, or a generic HTTPS webhook with labeled channels and reusable provider accounts. Cloudflare Email, Resend, and Postmark channels can group multiple recipients under one label. Channels sharing a provider account remain distinct groups. Twilio uses one destination number per channel.</p>
              <div className="my-7 grid grid-cols-3 gap-2.5 max-[680px]:grid-cols-1">
                <Channel image="discord" title="Discord">Structured incident webhooks</Channel>
                <Channel image="slack" title="Slack">Incoming webhook summaries</Channel>
                <Channel image="twilio" title="Email, SMS, and webhooks">Cloudflare Email, Resend, and Postmark support recipient groups. Twilio uses one destination number per channel. Generic HTTPS delivery uses an endpoint.</Channel>
              </div>
            </section>

            <section className="py-[70px] first:border-t-0 border-t border-line max-[680px]:py-[55px]" id="safety">
              <h2 className={DOCS_H2}>The monitor must not become the runaway workload</h2>
              <p className={DOCS_P}>Every pass defaults to hard limits of 300 GraphQL dataset queries, 50 REST requests, 100,000 D1 rows read, 50,000 D1 rows written, and 45 seconds. Operators can configure each ceiling within a fixed product maximum. Durable Object and Worker usage is collected in stable 10,000-row pages without waking objects or reading customer storage.</p>
              <ul className="my-[26px] list-none p-0">
                <li className={CHECKS_LI}><Check className="mt-0.5 text-[#64d59a] light:text-[#158052]" /><span><strong className={CHECKS_STRONG}>Unknown telemetry raises a coverage incident.</strong> Brolly never records it as zero or healthy.</span></li>
                <li className={CHECKS_LI}><Check className="mt-0.5 text-[#64d59a] light:text-[#158052]" /><span><strong className={CHECKS_STRONG}>Brolly and its notification path are protected</strong> from automatic shutdown.</span></li>
                <li className={CHECKS_LI}><Check className="mt-0.5 text-[#64d59a] light:text-[#158052]" /><span><strong className={CHECKS_STRONG}>Projected dollars never authorize a stop</strong>; automatic action requires fresh raw usage.</span></li>
                <li className={CHECKS_LI}><Check className="mt-0.5 text-[#64d59a] light:text-[#158052]" /><span><strong className={CHECKS_STRONG}>Controls preserve resources and data</strong> and record rollback state before execution.</span></li>
              </ul>
              <div className="mt-[38px] flex items-center justify-between gap-[30px] rounded-xl border border-[#6a3a1f] bg-[#1d1510] bg-[radial-gradient(circle_at_85%_20%,#f6821f22,transparent_45%)] p-[38px] light:border-[#efbf98] light:bg-[#fff6ef] light:bg-[radial-gradient(circle_at_85%_20%,#f6821f1b,transparent_45%)] max-[680px]:flex-col max-[680px]:items-start max-[680px]:p-[26px]"><span><h2 className={DOCS_H2}>Put the umbrella up before the next spike.</h2><p className="mt-3 text-[#b8a99d] light:text-[#6d5e52]">Deploy one self-hosted Brolly per Cloudflare account.</p></span><a className={`${PRIMARY} flex-none`} href={DEPLOY_URL}><CloudflareLogo /> Deploy to Cloudflare</a></div>
            </section>
          </div>
        </div>
      </main>

      <footer className={`flex min-h-[106px] items-center gap-[18px] ${EDGE} border-t border-[#24292f] py-6 text-xs text-[#707a85] light:border-[#dfe3e7] light:text-[#68727e] max-[680px]:flex-wrap max-[680px]:items-start`}><a className={`${BRAND} origin-[left_center] scale-[.86] text-white light:text-ink`} href="#top"><Umbrella /><strong>Brolly</strong></a><span className="max-[680px]:w-full">Cloudflare cost monitor and circuit breaker with reversible emergency quarantines.</span><nav className="ml-auto flex gap-5 max-[680px]:ml-0 max-[680px]:w-full max-[680px]:flex-wrap"><a className={FOOTER_LINK} href={GITHUB_URL}>GitHub</a><a className={FOOTER_LINK} href="https://www.npmjs.com/package/@standardagents/brolly-runtime">Runtime package</a><a className={FOOTER_LINK} href={DEPLOY_URL}>Deploy</a></nav></footer>
    </div>
  );
}

const STORY_TILTS = [-1.3, 1.1, -0.7, 1.4, -1, 0.8];

const STORY_HIGHLIGHTS: Record<string, Record<number, Array<{ text: string; kind: "price" | "mention" }>>> = {
  "justin-schroeder-8846": {
    0: [{ text: "$8,846", kind: "price" }],
  },
  "gabe-ragland-16000": {
    0: [{ text: "16k", kind: "price" }],
  },
  "steven-menke-1700": {
    0: [{ text: "$1.7K", kind: "price" }],
  },
  "dan-anderson-22000": {
    0: [
      { text: "@claudeai", kind: "mention" },
      { text: "@Cloudflare", kind: "mention" },
      { text: "$22k", kind: "price" },
    ],
    1: [{ text: "@digitalocean", kind: "mention" }],
  },
  "kill-switch-91316": {
    0: [{ text: "$91,316", kind: "price" }],
  },
  "andras-bacsai-36000": {
    1: [{ text: "$36k", kind: "price" }],
  },
};

function StoryText({ story, paragraphIndex, paragraph }: { story: (typeof billingStories)[number]; paragraphIndex: number; paragraph: string }) {
  const highlights = STORY_HIGHLIGHTS[story.slug]?.[paragraphIndex] ?? [];
  if (highlights.length === 0) return <>{paragraph}</>;

  let cursor = 0;
  const parts: ReactNode[] = [];
  highlights
    .sort((a, b) => paragraph.indexOf(a.text) - paragraph.indexOf(b.text))
    .forEach(({ text, kind }, hi) => {
      const idx = paragraph.indexOf(text, cursor);
      if (idx === -1) return;
      if (idx > cursor) parts.push(<Fragment key={`t${hi}`}>{paragraph.slice(cursor, idx)}</Fragment>);
      parts.push(
        kind === "price"
          ? <strong key={`b${hi}`} className="font-bold text-[#ff9f45] light:text-[#a84a02]">{text}</strong>
          : <span key={`b${hi}`} className="font-semibold text-[#1d9bf0]">{text}</span>,
      );
      cursor = idx + text.length;
    });
  if (cursor < paragraph.length) parts.push(<Fragment key="tail">{paragraph.slice(cursor)}</Fragment>);
  return <>{parts}</>;
}

function StoryGroup() {
  return (
    <>
      {billingStories.map((story, index) => (
        <a
          className="story-card relative flex min-h-[300px] flex-col overflow-hidden rounded-[16px] border border-[#2f3336] bg-[#0f1419] text-[#f7f9f9] shadow-[0_24px_60px_#0005] transition-transform duration-200 ease-[ease] before:absolute before:inset-x-0 before:top-0 before:z-[1] before:h-[3px] before:bg-[#f6821f] before:content-[''] focus-visible:border-[#f6821f99] light:border-[#d7dce1] light:bg-white light:text-[#0f1419] light:shadow-[0_24px_60px_#1b243014]"
          href={story.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`${story.name}: ${story.badge} Cloudflare usage incident. Read source on X.`}
          key={story.slug}
          style={{ transform: `rotate(${STORY_TILTS[index % STORY_TILTS.length]}deg)` }}
        >
          <article className="flex min-h-[inherit] flex-1 flex-col px-6 pt-[22px] pb-[18px]">
            <header className="flex min-h-12 items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-[11px]">
                <img className="block size-[42px] flex-none rounded-full border-2 border-[#2f3336] object-cover [clip-path:circle(50%)] light:border-[#d7dce1]" src={story.avatarFile} alt="" width="48" height="48" loading="lazy" decoding="async" />
                <span className="flex min-w-0 flex-col"><strong className="overflow-hidden text-sm text-ellipsis whitespace-nowrap text-[#f7f9f9] light:text-[#0f1419]">{story.name}</strong><small className="mt-px text-xs text-[#8b98a5] light:text-[#536471]">{story.handle}</small></span>
              </span>
              <strong className="flex-none text-[26px] leading-none font-[830] tracking-[-.03em] tabular-nums text-[#ff4438] light:text-[#d32f26]" aria-label={`Negative ${story.badge}`}>-{story.badge}</strong>
            </header>
            <div className="mt-3 flex-1 text-[15px] font-medium leading-[1.5] tracking-[-.01em]">
              {story.text.trim().split(/\n\n+/).slice(0, 3).map((paragraph, paragraphIndex) => <p className="mb-1.5 whitespace-pre-line last:mb-0" key={paragraphIndex}><StoryText story={story} paragraphIndex={paragraphIndex} paragraph={paragraph.trim()} /></p>)}
            </div>
            <footer className="mt-4 flex min-h-7 items-center justify-between gap-[15px] border-t border-[#2f3336] pt-[11px] text-xs text-[#8b98a5] light:border-[#e5e8eb] light:text-[#536471]"><time className="whitespace-nowrap">{story.date.split(" · ").pop()}</time><span className="whitespace-nowrap font-semibold text-[#1d9bf0]">View post on X</span></footer>
          </article>
        </a>
      ))}
    </>
  );
}

function Card({ number, icon, title, children }: { number: string; icon: ReactNode; title: string; children: ReactNode }) {
  return <article className="relative min-h-[245px] overflow-hidden rounded-[10px] border border-line bg-[linear-gradient(145deg,#171b20,#111419)] p-[22px] light:bg-[linear-gradient(145deg,#fff,#f5f6f8)] max-[680px]:min-h-[205px]"><span aria-hidden="true" className="pointer-events-none absolute -top-8 -right-4 text-[150px] leading-none font-[900] tracking-[-.08em] text-[#ffffff09] select-none light:text-[#1d1f2108]">{number}</span><span className="relative z-[1] block">{icon}</span><h3 className="relative z-[1] mt-[22px] mb-[9px] text-lg">{title}</h3><p className="relative z-[1] text-[13px] leading-[1.6] text-[#929ca7] light:text-[#626c78]">{children}</p></article>;
}

function Code({ label, children }: { label: string; children: ReactNode }) {
  return <div className="mt-[18px] mb-6 overflow-hidden rounded-[9px] border border-[#2c3239] bg-[#0d1013] light:border-[#d7dce1]"><div className="flex h-[35px] items-center gap-1.5 border-b border-[#262b31] px-3"><i className="size-[7px] rounded-full bg-[#323840]" /><i className="size-[7px] rounded-full bg-[#323840]" /><i className="size-[7px] rounded-full bg-[#323840]" /><span className="ml-auto text-[9px] font-[750] uppercase tracking-[.08em] text-[#707a86]">{label}</span></div><pre className="overflow-x-auto p-[18px] text-[13px] leading-[1.6] text-[#dbe1e7]"><code>{children}</code></pre></div>;
}

function Channel({ image, title, children }: { image: string; title: string; children: ReactNode }) {
  return <article className={`${PANEL_CARD} flex items-center gap-[11px]`}><img className="size-[30px] rounded-md bg-white p-1" src={`/brand-icons/${image}.svg`} alt="" /><span className="flex flex-col"><strong>{title}</strong><small className="text-[11px] text-[#84909b] light:text-[#626c78]">{children}</small></span></article>;
}

function Icon({ className, children }: { className?: string; children: ReactNode }) {
  return <svg className={className ? `icon ${className}` : "icon"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}
function Arrow({ className }: { className?: string }) { return <Icon className={className}><path d="m9 5 7 7-7 7" /></Icon>; }
function Check({ className }: { className?: string }) { return <Icon className={className}><path d="m5 12 4 4L19 6" /></Icon>; }
function Alert({ className }: { className?: string }) { return <Icon className={className}><path d="M12 3 2.8 19h18.4L12 3Z" /><path d="M12 9v4M12 17h.01" /></Icon>; }
function Radar({ className }: { className?: string }) { return <Icon className={className}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="m12 12 6-6" /></Icon>; }
function Shield({ className }: { className?: string }) { return <Icon className={className}><path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-5" /></Icon>; }
function Refresh({ className }: { className?: string }) { return <Icon className={className}><path d="M20 11a8 8 0 1 0-2 6" /><path d="M20 4v7h-7" /></Icon>; }
function Info({ className }: { className?: string }) { return <Icon className={className}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></Icon>; }
function CloudflareLogo({ className }: { className?: string }) {
  return (
    <svg className={className ? `cloudflare-logo ${className}` : "cloudflare-logo"} viewBox="12 13.5 25 12" aria-hidden="true">
      <path d="M28.8868 24.7745L29.0095 24.35C29.1558 23.8449 29.1014 23.378 28.8559 23.0349C28.6302 22.7189 28.2539 22.5328 27.797 22.5112L19.1416 22.4009C19.0833 22.3978 19.0351 22.3715 19.0054 22.3283C18.9753 22.2839 18.9683 22.2268 18.9869 22.172C19.0154 22.0867 19.0999 22.0223 19.1879 22.0184L27.9236 21.9077C28.9597 21.8602 30.0816 21.0194 30.4745 19.994L30.9727 18.6924C30.9864 18.657 30.9926 18.6194 30.9923 18.5817C30.9922 18.5612 30.9907 18.5406 30.9862 18.5203C30.4201 15.9761 28.1497 14.0736 25.4348 14.0736C22.9333 14.0736 20.8092 15.6882 20.0474 17.9322C19.5557 17.5633 18.9267 17.3672 18.2506 17.4348C17.0504 17.554 16.086 18.5203 15.9667 19.7204C15.9354 20.0319 15.9609 20.3325 16.0327 20.615C14.0722 20.6721 12.5 22.2782 12.5 24.2524C12.5 24.4311 12.5135 24.6067 12.5386 24.7784C12.5509 24.8618 12.6212 24.9243 12.7053 24.9243L28.6846 24.9262C28.6862 24.9262 28.6876 24.9255 28.6892 24.9254C28.7806 24.9234 28.861 24.8629 28.8868 24.7745Z" />
      <path d="M31.7695 18.7879C31.6892 18.7879 31.6093 18.7902 31.5298 18.7941C31.5167 18.7948 31.5042 18.798 31.4923 18.8022C31.4508 18.8167 31.4177 18.8503 31.4051 18.8941L31.0648 20.0695C30.9185 20.5746 30.9729 21.0412 31.2184 21.3842C31.4441 21.7007 31.8204 21.8863 32.2773 21.9079L34.1224 22.0187C34.1768 22.0213 34.2247 22.0476 34.254 22.09C34.2848 22.1348 34.2918 22.1923 34.2733 22.2471C34.2443 22.3324 34.1602 22.3968 34.0726 22.4007L32.1553 22.5114C31.1145 22.5593 29.9927 23.3998 29.5998 24.4251L29.4612 24.7871C29.436 24.8526 29.483 24.9223 29.5522 24.9258C29.554 24.9258 29.5556 24.9264 29.5573 24.9264H36.1542C36.233 24.9264 36.3032 24.8751 36.3244 24.7994C36.439 24.3919 36.5 23.9624 36.5 23.5183C36.5 20.9057 34.3821 18.7879 31.7695 18.7879Z" />
    </svg>
  );
}
function Umbrella() { return <span className="grid size-[33px] place-items-center rounded-lg bg-orange text-white"><svg className="size-[25px]" viewBox="0 0 40 40" aria-hidden="true"><g transform="matrix(-1 0 0 1 40 0)"><path d="M4 20a16 16 0 0 1 32 0c-3.5-2.5-7.2-2.5-10.8 0-3.4-2.5-7-2.5-10.4 0C11.2 17.5 7.6 17.5 4 20Z" fill="currentColor" /><path d="M20 7v23.5c0 3.6 5.5 3.6 5.5 0" fill="none" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" /></g></svg></span>; }
