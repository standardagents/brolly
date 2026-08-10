import { useEffect, useState } from "react";
import { Brand, Icon, ProductIcon } from "../components/ui";

const INSTALL_COMMAND = "pnpm dlx @standardagents/brolly install";
const DEPLOY_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/standardagents/brolly";

const DOC_LINKS = [
  ["How it works", "how-it-works"],
  ["Quick start", "quick-start"],
  ["Set limits", "limits"],
  ["Precise shutdown", "runtime"],
  ["Notifications", "notifications"],
  ["Safety model", "safety"],
] as const;

const PRODUCTS = ["durable_objects", "workers", "d1", "r2", "kv", "queues", "workers_ai", "ai_gateway"];

export function DocsPage() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Brolly — Cost guardrails for Cloudflare";
    return () => { document.title = previousTitle; };
  }, []);

  async function copyInstaller(scroll = false) {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
    } catch {
      const input = document.createElement("textarea");
      input.value = INSTALL_COMMAND;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2400);
    if (scroll) document.getElementById("quick-start")?.scrollIntoView({ behavior: "smooth" });
  }

  return (
    <div className="docs-site">
      <a className="docs-skip" href="#docs-main">Skip to documentation</a>

      <header className="docs-header">
        <a href="/docs" aria-label="Brolly documentation"><Brand /></a>
        <nav aria-label="Documentation">
          <a href="#how-it-works">How it works</a>
          <a href="#quick-start">Install</a>
          <a href="https://github.com/standardagents/brolly" target="_blank" rel="noreferrer">GitHub</a>
          <a className="docs-dashboard-link" href="/">Open dashboard <Icon name="arrow" /></a>
        </nav>
      </header>

      <main id="docs-main">
        <section className="docs-hero">
          <div className="docs-grid" aria-hidden="true" />
          <div className="docs-hero-copy">
            <p className="docs-kicker"><span /> Cloudflare cost control, self-hosted</p>
            <h1>Cloudflare moves fast. <em>Your bill can too.</em></h1>
            <p className="docs-lede">
              Brolly catches runaway Workers, Durable Objects, storage, and AI spend before it becomes an invoice—then gives your team audited, reversible controls to contain it.
            </p>
            <div className="docs-hero-actions">
              <a className="docs-deploy-button" href={DEPLOY_URL} target="_blank" rel="noreferrer">
                <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" />
              </a>
              <a className="docs-secondary" href="#how-it-works">See how it works <Icon name="arrow" /></a>
            </div>
            <button type="button" className="docs-command" onClick={() => void copyInstaller()} aria-label="Copy Brolly installer command">
              <span className="docs-prompt">$</span><code>{INSTALL_COMMAND}</code>
              <span className="docs-copy-state">{copied ? "Copied" : "Copy"}</span>
            </button>
            <p className="docs-setup-note">Cloudflare clones Brolly into your GitHub account, provisions its D1 database, and walks you through the Worker configuration before deploying.</p>
          </div>

          <div className="docs-hero-visual" aria-label="Example Brolly incident response">
            <div className="docs-visual-glow" />
            <div className="docs-console-card">
              <div className="docs-console-top">
                <span><i /> Cloudflare account · Brolly guard</span>
                <span className="docs-live">Monitoring</span>
              </div>
              <div className="docs-spend-row">
                <div><small>Projected spend today</small><strong>$8,241.37</strong></div>
                <span className="docs-rise">↑ 2,480%</span>
              </div>
              <div className="docs-incident-card">
                <div className="docs-incident-icon"><Icon name="alert" /></div>
                <div><small>Emergency · Durable Objects</small><strong>Rows read exceeded the emergency limit</strong><span>807.6M rows in 5 minutes</span></div>
              </div>
              <div className="docs-response-row">
                <div><span>Exact object fuse</span><strong>Ready</strong></div>
                <span className="docs-response-action">Approve &amp; stop</span>
              </div>
              <div className="docs-audit-line"><Icon name="check" /> Reversible action prepared · data preserved</div>
            </div>
            <div className="docs-scan-card"><Icon name="radar" /><span><strong>1 minute</strong> bounded monitor cadence</span></div>
          </div>
        </section>

        <section className="docs-proof" aria-label="Brolly coverage">
          <p>Every billable Cloudflare service. One safety net.</p>
          <div>{PRODUCTS.map(product => <span key={product}><ProductIcon family={product} /><b>{productLabel(product)}</b></span>)}</div>
        </section>

        <section id="how-it-works" className="docs-section docs-intro">
          <p className="docs-section-label">How it works</p>
          <h2>Know. Decide. Stop. Recover.</h2>
          <p className="docs-section-lede">Brolly separates measurement from enforcement so a telemetry problem can never masquerade as a healthy account.</p>
          <div className="docs-step-grid">
            <article><span>01</span><Icon name="radar" /><h3>Measure</h3><p>Bounded collectors poll fast telemetry every minute and reconcile authoritative billing daily when a Billing Read token is installed.</p></article>
            <article><span>02</span><Icon name="alert" /><h3>Explain</h3><p>Usage incidents and coverage gaps are distinct. Every alert names the asset, observed window, configured limit, and evidence freshness.</p></article>
            <article><span>03</span><Icon name="shield" /><h3>Contain</h3><p>Operators can prepare, approve, and roll back a control. Automatic mode is opt-in and only acts on classified, fuse-ready resources.</p></article>
            <article><span>04</span><Icon name="refresh" /><h3>Recover</h3><p>Resume restores the saved state. Exact-object quarantine preserves Durable Object storage and leaves other object IDs serving.</p></article>
          </div>
        </section>

        <div className="docs-body-wrap">
          <aside className="docs-toc">
            <strong>On this page</strong>
            {DOC_LINKS.map(([label, id]) => <a key={id} href={`#${id}`}>{label}</a>)}
            <a className="docs-toc-dashboard" href="/">Open Brolly <Icon name="arrow" /></a>
          </aside>

          <div className="docs-content">
            <section id="quick-start" className="docs-doc-section">
              <p className="docs-section-label">Quick start</p>
              <h2>Deploy Brolly into one account</h2>
              <p>Deploy to Cloudflare creates your own copy of Brolly, provisions the required D1 database, collects the account variables and secrets, runs its migrations, and deploys the guard Worker and dashboard.</p>
              <div className="docs-callout orange">
                <div><Icon name="shield" /><span><strong>Deploy on your Cloudflare account</strong><small>Cloudflare will show every resource and secret before it builds.</small></span></div>
                <a href={DEPLOY_URL} target="_blank" rel="noreferrer">Deploy to Cloudflare</a>
              </div>
              <ol className="docs-numbered">
                <li><span>1</span><div><strong>Connect GitHub and choose one Cloudflare account.</strong><p>Cloudflare creates a copy of the public Brolly repository that you own and can update independently.</p></div></li>
                <li><span>2</span><div><strong>Review bindings and secrets.</strong><p>Choose the Worker name, enter your account ID and monitoring token, and generate the admin and encryption secrets described in the setup form.</p></div></li>
                <li><span>3</span><div><strong>Build, migrate, and deploy.</strong><p>Workers Builds provisions D1, applies Brolly’s schema, deploys the Worker, and gives you its URL. First login then walks through every spending limit.</p></div></li>
              </ol>
              <h3>Prefer the terminal?</h3>
              <p>The CLI performs the equivalent OAuth-guided installation and keeps the generated admin token in your local Brolly config.</p>
              <button type="button" className="docs-command docs-command-inline" onClick={() => void copyInstaller()} aria-label="Copy Brolly installer command">
                <span className="docs-prompt">$</span><code>{INSTALL_COMMAND}</code><span className="docs-copy-state">{copied ? "Copied" : "Copy"}</span>
              </button>
              <p className="docs-prerequisite"><strong>CLI prerequisite:</strong> until Brolly ships its shared public OAuth application ID in the package, set <code>BROLLY_OAUTH_CLIENT_ID</code> to your registered Cloudflare PKCE client before running this command.</p>
              <div className="docs-callout neutral"><Icon name="info" /><p><strong>Billing reconciliation is optional.</strong> Cloudflare does not expose Billing Read through the OAuth scope catalog. Add a manually created Billing Read token for authoritative invoice comparison; fast telemetry and coverage alerts work without it.</p></div>
            </section>

            <section id="limits" className="docs-doc-section">
              <p className="docs-section-label">Limits and modes</p>
              <h2>Start broad, then narrow the blast radius</h2>
              <p>Every policy uses ordered warning, critical, and emergency limits. Product defaults protect the whole account; scoped limits override them for individual Worker scripts, Durable Object namespaces, and exact object IDs.</p>
              <div className="docs-table-wrap"><table><thead><tr><th>Mode</th><th>What Brolly does</th><th>Best for</th></tr></thead><tbody>
                <tr><td><span className="docs-mode observe">Observe</span></td><td>Detects and notifies. Never prepares or executes a stop.</td><td>Initial rollout and policy tuning</td></tr>
                <tr><td><span className="docs-mode approval">Approval</span></td><td>Prepares a reversible action; a person explicitly executes it.</td><td>Production default</td></tr>
                <tr><td><span className="docs-mode automatic">Automatic</span></td><td>Acts only at emergency thresholds on classified, supported resources.</td><td>Tested, disposable workloads</td></tr>
              </tbody></table></div>
              <div className="docs-callout warning"><Icon name="alert" /><p><strong>Control-plane and critical assets are alert-only.</strong> Brolly, its D1 database, and notification path cannot be automatically stopped. Unclassified resources are treated as critical.</p></div>
            </section>

            <section id="runtime" className="docs-doc-section">
              <p className="docs-section-label">Precise shutdown</p>
              <h2>Add a zero-I/O deployment fuse</h2>
              <p>Brolly can be installed without changing application code, but exact Worker and Durable Object quarantine requires the tiny runtime package. Its hot-path checks only parse an environment binding and compare IDs—no API, KV, D1, or Durable Object call.</p>
              <h3>Install the runtime and initialize its secret</h3>
              <CodeBlock label="Terminal" code={`pnpm add @standardagents/brolly-runtime\nprintf '%s' '{"version":1,"generation":0,"objects":{}}' \\\n  | pnpm wrangler secret put BROLLY_FUSE`} />
              <h3>Guard a Durable Object constructor</h3>
              <CodeBlock label="TypeScript" code={`constructor(ctx: DurableObjectState, env: Env) {\n  super(ctx, env)\n  brollyDurableObject(ctx, env)\n}`} />
              <h3>Avoid waking a quarantined object</h3>
              <CodeBlock label="TypeScript" code={`brollyWorker(env)\nconst id = env.ROOMS.idFromName(name)\nbrollyWorker(env, { durableObjectId: id.toString() })\nreturn env.ROOMS.get(id).fetch(request)`} />
              <div className="docs-impact-grid">
                <article><Icon name="check" /><strong>Preserved</strong><p>Object SQLite rows, messages, queued records, and history are not deleted.</p></article>
                <article><Icon name="shield" /><strong>Isolated</strong><p>Only the named object ID ejects; other IDs continue serving after rollout.</p></article>
                <article><Icon name="refresh" /><strong>Reversible</strong><p>Resume removes the ID from the deployment fuse and creates an audit record.</p></article>
              </div>
            </section>

            <section id="notifications" className="docs-doc-section">
              <p className="docs-section-label">Notifications</p>
              <h2>Wake the people who can respond</h2>
              <p>Configure Discord, Slack, or Twilio SMS from Settings. Destinations have independent minimum severity, pause controls, deduplication, and delivery-rate limits.</p>
              <div className="docs-notification-row">
                <div><img src="/brand-icons/discord.svg" alt="" /><span><strong>Discord</strong><small>Structured incident webhook</small></span></div>
                <div><img src="/brand-icons/slack.svg" alt="" /><span><strong>Slack</strong><small>Incoming webhook summaries</small></span></div>
                <div><img src="/brand-icons/twilio.svg" alt="" /><span><strong>Twilio SMS</strong><small>High-urgency text alerts</small></span></div>
              </div>
              <div className="docs-callout neutral"><Icon name="shield" /><p>Webhook URLs and Twilio credentials are encrypted before entering D1 and are never returned to the browser.</p></div>
            </section>

            <section id="safety" className="docs-doc-section">
              <p className="docs-section-label">Safety model</p>
              <h2>The monitor must not become the runaway workload</h2>
              <p>Each pass has hard ceilings: 150 Cloudflare API requests, 25,000 D1 rows, 20,000 samples, and 45 seconds. A typical one-page account scan uses about 13 API calls and never wakes every Durable Object or queries customer-object SQLite.</p>
              <ul className="docs-check-list">
                <li><Icon name="check" /><span><strong>No destructive controls.</strong> Brolly never deletes resources or stored customer data.</span></li>
                <li><Icon name="check" /><span><strong>No invented precision.</strong> Namespace- and account-scoped meters stay labeled at their real scope.</span></li>
                <li><Icon name="check" /><span><strong>No silent blind spots.</strong> Permission errors, delayed data, and absent collectors become coverage gaps.</span></li>
                <li><Icon name="check" /><span><strong>No untested automation.</strong> Automatic controls require an emergency threshold, safe classification, and a supported reversible lever.</span></li>
              </ul>
            </section>

            <section className="docs-final-cta">
              <div><p className="docs-section-label">Ready when the weather turns</p><h2>Put an umbrella over your Cloudflare bill.</h2><p>Install in one account, set conservative limits, and keep approval mode on until every shutdown path has been tested.</p></div>
              <a className="docs-deploy-button" href={DEPLOY_URL} target="_blank" rel="noreferrer"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" /></a>
            </section>
          </div>
        </div>
      </main>

      <footer className="docs-footer"><Brand /><span>Self-hosted Cloudflare cost protection.</span><div><a href="https://github.com/standardagents/brolly">GitHub</a><a href="/">Dashboard</a></div></footer>
    </div>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  return <div className="docs-code"><div><span>{label}</span><i /><i /><i /></div><pre><code>{code}</code></pre></div>;
}

function productLabel(product: string) {
  const labels: Record<string, string> = { durable_objects: "Durable Objects", workers: "Workers", workers_ai: "Workers AI", ai_gateway: "AI Gateway", d1: "D1", r2: "R2", kv: "KV", queues: "Queues" };
  return labels[product] ?? product;
}
