import type { ReactNode } from "react";
import billingStories from "../../../docs/cloudflare-x-post-images/posts.json";

const DEPLOY_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/standardagents/brolly";
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

export function App() {
  return (
    <div className="site">
      <a className="skip" href="#main">Skip to content</a>
      <header className="header">
        <a className="brand" href="#top" aria-label="Brolly home"><Umbrella /><strong>Brolly</strong></a>
        <nav aria-label="Primary navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#install">Install</a>
          <a href="#runtime">Runtime fuse</a>
          <a href={GITHUB_URL}>GitHub</a>
          <a className="nav-cta" href={DEPLOY_URL}>Deploy Brolly <Arrow /></a>
        </nav>
      </header>

      <main id="main">
        <section className="hero" id="top">
          <div className="grid" aria-hidden="true" />
          <div className="hero-copy">
            <p className="kicker"><i /> Cloudflare cost control, self-hosted</p>
            <h1>Cloudflare moves fast. <em>Your bill can too.</em></h1>
            <p className="lede">Brolly catches runaway Workers, Durable Objects, storage, and AI usage before it becomes an invoice—then gives your team audited, reversible controls to contain it.</p>
            <div className="hero-actions">
              <a className="primary" href={DEPLOY_URL}><Cloud /> Deploy to Cloudflare</a>
              <a className="secondary" href="#how-it-works">See how it works <Arrow /></a>
            </div>
            <p className="hero-note">One account per installation. Your policies, credentials, incidents, and audit history stay in your Cloudflare account.</p>
          </div>
          <div className="hero-visual" aria-label="Example Brolly emergency incident">
            <div className="glow" />
            <div className="console">
              <div className="console-head"><span><i /> Cloudflare account · Brolly</span><b>Monitoring</b></div>
              <div className="spend"><span><small>Projected spend today</small><strong>$8,241.37</strong></span><b>↑ 2,480%</b></div>
              <div className="incident"><span className="incident-mark">!</span><span><small>Emergency · Durable Objects</small><strong>Rows read exceeded the emergency limit</strong><em>807.6M rows in 5 minutes</em></span></div>
              <div className="response"><span><small>Exact object fuse</small><strong>Ready</strong></span><b>Approve &amp; stop</b></div>
              <div className="audit"><Check /> Reversible action prepared · data preserved</div>
            </div>
            <div className="scan"><Radar /><span><strong>1 minute</strong> bounded monitor cadence</span></div>
          </div>
        </section>

        <section className="coverage" aria-label="Cloudflare product coverage">
          <p>Every billable Cloudflare service. One safety net.</p>
          <div>{SERVICES.map(([icon, label]) => <span key={icon}><img src={`/cloudflare-icons/${icon}.svg`} alt="" /><b>{label}</b></span>)}</div>
        </section>

        <section className="stories" id="stories" aria-labelledby="stories-title">
          <div className="stories-copy">
            <p className="eyebrow">Not hypothetical</p>
            <h2 id="stories-title">The bill should not be your first alert.</h2>
            <p>Runaway loops and unbounded usage have turned small mistakes into five-figure Cloudflare invoices. Brolly gives every account an early warning and a circuit breaker.</p>
          </div>
          <div className="story-marquee">
            <div className="story-track">
              <StoryGroup />
              <StoryGroup duplicate />
            </div>
          </div>
          <p className="stories-note">Hover to pause · Move away to resume · Select a card to view the source on X</p>
        </section>

        <section className="section" id="how-it-works">
          <p className="eyebrow">Per-resource protection</p>
          <h2>Watch every Worker. Limit every object.</h2>
          <p className="section-lede">Brolly monitors usage per Worker, per Durable Object namespace, and per individual Durable Object—then applies the most specific limit without taking healthy neighbors offline.</p>
          <div className="steps">
            <Card number="01" icon={<Radar />} title="Monitor individually">See usage and incidents for each Worker, Durable Object namespace, and exact object ID—not just one account-wide total.</Card>
            <Card number="02" icon={<Alert />} title="Set explicit limits">Give every target warning, critical, and emergency thresholds. Exact-object limits override namespace, Worker, product, and account defaults.</Card>
            <Card number="03" icon={<Shield />} title="Auto-quarantine runaways">Automatic mode can quarantine a fuse-ready Worker or Durable Object after two fresh emergency breaches, while unrelated resources keep serving.</Card>
            <Card number="04" icon={<Refresh />} title="Recover without data loss">Resume clears the quarantine through an audited deployment. Brolly preserves the resource, storage, messages, and history throughout.</Card>
          </div>
        </section>

        <div className="docs-layout">
          <aside>
            <strong>On this page</strong>
            <a href="#install">Install</a>
            <a href="#limits">Limits</a>
            <a href="#runtime">Runtime fuse</a>
            <a href="#notifications">Notifications</a>
            <a href="#safety">Safety model</a>
          </aside>
          <div className="docs">
            <section id="install">
              <p className="eyebrow">Install</p>
              <h2>Deploy Brolly into one Cloudflare account</h2>
              <p>Install Brolly in the Cloudflare account you want to protect. When deployment finishes, open your private dashboard and sign in with Cloudflare.</p>
              <div className="callout orange"><span><Cloud /><span><strong>Runs in your Cloudflare account</strong><small>Your limits, incidents, and controls stay in your own deployment.</small></span></span><a href={DEPLOY_URL}>Deploy to Cloudflare</a></div>
              <ol className="numbered">
                <li><b>1</b><span><strong>Deploy to Cloudflare.</strong><p>Choose your Cloudflare account and a name for the Brolly Worker, then click Deploy.</p></span></li>
                <li><b>2</b><span><strong>Open Brolly and sign in.</strong><p>Visit the private Brolly URL created for you and authorize the Cloudflare account you want it to protect.</p></span></li>
                <li><b>3</b><span><strong>Review what Brolly found.</strong><p>See your Workers, Durable Object namespaces, individual objects, current usage, and any monitoring gaps.</p></span></li>
                <li><b>4</b><span><strong>Choose your protection.</strong><p>Set per-resource limits, select observe, approval, or automatic mode, and connect Discord, Slack, or SMS alerts.</p></span></li>
              </ol>
              <div className="callout orange"><span><Check /><span><strong>You are ready to protect the account</strong><small>Start in observe mode, confirm the readings and limits, then enable approval or automatic quarantine when you are comfortable.</small></span></span></div>
              <div className="callout"><Info /><p><strong>Who can sign in later?</strong> A Cloudflare member who can authorize Brolly's requested scopes for the bound account may sign in. A user who authorizes a different account is rejected. Changing accounts requires deliberately resetting the installation's D1 binding or deploying a new instance; the latest successful authorization supplies the revocable Cloudflare grant Brolly uses for monitoring and controls.</p></div>
              <div className="callout"><Info /><p><strong>Billing reconciliation is optional.</strong> Fast telemetry works with OAuth. A separate Billing Read token enables authoritative invoice comparison because Cloudflare does not expose that permission through its OAuth scope catalog.</p></div>
            </section>

            <section id="limits">
              <p className="eyebrow">Limits and modes</p>
              <h2>Start broad. Narrow the blast radius.</h2>
              <p>Define warning, critical, and emergency limits at the account, product, Worker, Durable Object namespace, and exact-object levels. More specific policies override broad defaults.</p>
              <div className="mode-table" role="table" aria-label="Brolly protection modes">
                <div role="row"><b role="cell" className="mode observe">Observe</b><span role="cell">Detect and notify. Never prepare or execute a stop.</span></div>
                <div role="row"><b role="cell" className="mode approval">Approval</b><span role="cell">Prepare a reversible action; a person explicitly executes it.</span></div>
                <div role="row"><b role="cell" className="mode automatic">Automatic</b><span role="cell">Act after two fresh raw-usage emergencies on verified, eligible targets.</span></div>
              </div>
            </section>

            <section id="runtime">
              <p className="eyebrow">Precise shutdown</p>
              <h2>A zero-I/O deployment fuse</h2>
              <p>Monitoring works without application changes. Exact Worker and Durable Object quarantine uses the tiny <code>@standardagents/brolly-runtime</code> package. Its hot path only parses a deployment binding and compares IDs—no HTTP, KV, D1, or Durable Object storage operation.</p>
              <Code label="Install">pnpm add @standardagents/brolly-runtime</Code>
              <h3>One line in a Durable Object constructor</h3>
              <Code label="TypeScript">{`constructor(ctx: DurableObjectState, env: Env) {\n  super(ctx, env)\n  brollyDurableObject(ctx, env)\n}`}</Code>
              <h3>Stop ingress before waking the object</h3>
              <Code label="TypeScript">{`brollyWorker(env)\nconst id = env.ROOMS.idFromName(name)\nbrollyWorker(env, { durableObjectId: id.toString() })\nreturn env.ROOMS.get(id).fetch(request)`}</Code>
              <div className="impact">
                <article><Check /><strong>Preserved</strong><p>Object SQLite rows, messages, queues, and history remain intact.</p></article>
                <article><Shield /><strong>Isolated</strong><p>Only the named target ejects; unrelated object IDs continue serving.</p></article>
                <article><Refresh /><strong>Reversible</strong><p>Resume removes the fuse target through a new audited deployment.</p></article>
              </div>
            </section>

            <section id="notifications">
              <p className="eyebrow">Notifications</p>
              <h2>Wake the people who can respond</h2>
              <p>Configure Discord, Slack, or Twilio SMS with independent minimum severity, pause controls, deduplication, and delivery-rate limits.</p>
              <div className="channels">
                <Channel image="discord" title="Discord">Structured incident webhooks</Channel>
                <Channel image="slack" title="Slack">Incoming webhook summaries</Channel>
                <Channel image="twilio" title="Twilio SMS">High-urgency text alerts</Channel>
              </div>
            </section>

            <section id="safety">
              <p className="eyebrow">Safety model</p>
              <h2>The monitor must not become the runaway workload</h2>
              <p>Every pass has hard limits: 150 Cloudflare API calls, 25,000 Brolly D1 row operations, 20,000 samples, and 45 seconds. Brolly never wakes every object or reads customer-object SQLite to monitor it.</p>
              <ul className="checks">
                <li><Check /><span><strong>Unknown telemetry is a coverage incident</strong>, never a zero or healthy reading.</span></li>
                <li><Check /><span><strong>Brolly and its notification path are protected</strong> from automatic shutdown.</span></li>
                <li><Check /><span><strong>Projected dollars never authorize a stop</strong>; automatic action requires fresh raw usage.</span></li>
                <li><Check /><span><strong>Controls preserve resources and data</strong> and record rollback state before execution.</span></li>
              </ul>
              <div className="final-cta"><span><p className="eyebrow">Put up the umbrella</p><h2>See the spike before the invoice.</h2><p>Deploy one self-hosted Brolly per Cloudflare account.</p></span><a className="primary" href={DEPLOY_URL}><Cloud /> Deploy to Cloudflare</a></div>
            </section>
          </div>
        </div>
      </main>

      <footer><a className="brand" href="#top"><Umbrella /><strong>Brolly</strong></a><span>Cloudflare cost guardrails and reversible emergency controls.</span><nav><a href={GITHUB_URL}>GitHub</a><a href="https://www.npmjs.com/package/@standardagents/brolly-runtime">Runtime package</a><a href={DEPLOY_URL}>Deploy</a></nav></footer>
    </div>
  );
}

function StoryGroup({ duplicate = false }: { duplicate?: boolean }) {
  return (
    <div className="story-group" aria-hidden={duplicate || undefined}>
      {billingStories.map(story => {
        const postLength = story.text.length;
        const textSize = postLength > 300 ? "compact" : postLength < 100 ? "large" : "";
        return (
          <a
            className="story-card"
            href={story.url}
            target="_blank"
            rel="noreferrer"
            tabIndex={duplicate ? -1 : undefined}
            aria-label={`${story.name}: ${story.badge} Cloudflare usage incident. View source on X.`}
            key={story.slug}
          >
            <article>
              <header className="story-card-head">
                <img className="story-avatar" src={story.avatarFile} alt="" width="48" height="48" loading="lazy" decoding="async" />
                <span className="story-identity"><strong>{story.name}</strong><small>{story.handle}</small></span>
                <span className="story-x" aria-hidden="true">𝕏</span>
              </header>
              <div className="story-meta"><span>{story.category}</span><strong>{story.badge}</strong></div>
              <div className={`story-post ${textSize}`}>
                {story.text.trim().split(/\n\n+/).map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}
              </div>
              <footer className="story-footer"><time>{story.date}</time><span>View post on X <b aria-hidden="true">↗</b></span></footer>
            </article>
          </a>
        );
      })}
    </div>
  );
}

function Card({ number, icon, title, children }: { number: string; icon: ReactNode; title: string; children: ReactNode }) {
  return <article><span>{number}</span>{icon}<h3>{title}</h3><p>{children}</p></article>;
}

function Code({ label, children }: { label: string; children: ReactNode }) {
  return <div className="code"><div><i /><i /><i /><span>{label}</span></div><pre><code>{children}</code></pre></div>;
}

function Channel({ image, title, children }: { image: string; title: string; children: ReactNode }) {
  return <article><img src={`/brand-icons/${image}.svg`} alt="" /><span><strong>{title}</strong><small>{children}</small></span></article>;
}

function Icon({ children }: { children: ReactNode }) {
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}
function Arrow() { return <Icon><path d="m9 5 7 7-7 7" /></Icon>; }
function Check() { return <Icon><path d="m5 12 4 4L19 6" /></Icon>; }
function Alert() { return <Icon><path d="M12 3 2.8 19h18.4L12 3Z" /><path d="M12 9v4M12 17h.01" /></Icon>; }
function Radar() { return <Icon><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="m12 12 6-6" /></Icon>; }
function Shield() { return <Icon><path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-5" /></Icon>; }
function Refresh() { return <Icon><path d="M20 11a8 8 0 1 0-2 6" /><path d="M20 4v7h-7" /></Icon>; }
function Info() { return <Icon><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></Icon>; }
function Cloud() { return <Icon><path d="M7 18h10a4 4 0 0 0 .4-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18Z" /></Icon>; }
function Umbrella() { return <span className="brand-mark"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M4 20a16 16 0 0 1 32 0c-3.5-2.5-7.2-2.5-10.8 0-3.4-2.5-7-2.5-10.4 0C11.2 17.5 7.6 17.5 4 20Z" fill="currentColor" /><path d="M20 7v23.5c0 3.6 5.5 3.6 5.5 0" fill="none" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" /></svg></span>; }
