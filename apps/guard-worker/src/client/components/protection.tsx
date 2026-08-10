import { Icon, InfoTip, ProductIcon } from "./ui";
import type { Policy } from "../types";

/**
 * Shared, exact language about what shutdown levers exist. Brolly cannot
 * externally terminate one live Durable Object by opaque ID without runtime
 * cooperation, and this copy must never imply otherwise.
 */
export function ControlCapabilities() {
  return (
    <section id="shutdown-options" className="panel-section controls-explainer">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Shutdown playbook</p>
          <h2 className="heading-with-info">
            What Brolly can stop
            <InfoTip label="How shutdown controls work">
              <h4>Detection is not enforcement</h4>
              <p>A budget crossing creates an incident. A stop is only available when the asset is classified, the relevant control is supported, and the selected policy mode permits it.</p>
              <p>Every Cloudflare-side change saves rollback state first and is written to the audit log. Brolly never deletes stored customer data.</p>
            </InfoTip>
          </h2>
          <p>The blast radius depends on which lever exists for that Cloudflare resource.</p>
        </div>
      </div>
      <div className="control-capability-grid">
        <article>
          <ProductIcon family="durable_objects" />
          <div>
            <strong>One Durable Object</strong>
            <span className="capability-pill precise">Precise · needs runtime fuse</span>
            <p>The deployment fuse names one exact 64-character object ID. Its constructor throws before application handlers run, while stored data and other IDs remain available. A Worker-version rollout may restart other live objects in that script.</p>
          </div>
        </article>
        <article>
          <ProductIcon family="workers" />
          <div>
            <strong>One Worker script</strong>
            <span className="capability-pill broad">Broad impact</span>
            <p>An installed Worker guard can reject every entry point through the same fuse. Without the package, Brolly can only remove supported routes, domains, and triggers after saving rollback state.</p>
          </div>
        </article>
        <article>
          <ProductIcon family="queues" />
          <div>
            <strong>Queue delivery</strong>
            <span className="capability-pill reversible">Reversible pause</span>
            <p>Brolly can pause the queue consumer. Messages remain queued, but processing stops until rollback restores the consumer. Producers may continue adding backlog and storage/retention rules still apply.</p>
          </div>
        </article>
        <article className="unavailable">
          <span className="capability-icon"><Icon name="alert" /></span>
          <div>
            <strong>Account-wide "kill every object"</strong>
            <span className="capability-pill unavailable">Not exposed by Cloudflare</span>
            <p>Cloudflare has no generic account API to terminate every Durable Object instance, and Brolly must not imply otherwise. The broadest fallback is disabling known Worker ingress/triggers, which can cause a major outage and may not stop alarms already scheduled inside objects.</p>
          </div>
        </article>
      </div>
    </section>
  );
}

/** Exact service-impact framing for an exact-object quarantine. */
export function ObjectStopImpact({ compact = false }: { compact?: boolean }) {
  return (
    <section className={`stop-impact ${compact ? "compact" : ""}`}>
      <h3>Service impact while quarantined</h3>
      <div className="impact-grid">
        <div className="impact-card interrupted">
          <strong>Deployment enforcement</strong>
          <p>Cloudflare rolls out a new Worker version. Existing synchronous code cannot be preempted at an arbitrary instruction, but subsequent object construction ejects before application code.</p>
        </div>
        <div className="impact-card blocked">
          <strong>Blocked until resume</strong>
          <p>Worker ingress can return HTTP 503 before waking the object; the constructor guard also blocks direct calls, RPC, alarms, and WebSocket events.</p>
        </div>
        <div className="impact-card preserved">
          <strong>Preserved</strong>
          <p>The object's SQLite rows, messages, queued records, and history are not deleted. Other object IDs keep serving normally.</p>
        </div>
        <div className="impact-card recovery">
          <strong>Recovery</strong>
          <p>Resume removes this ID from the secret and deploys the next generation. Recovery is manual by default so a stopped spike cannot flap back on automatically.</p>
        </div>
      </div>
    </section>
  );
}

export function ProtectionExplainer({ mode }: { mode: Policy["mode"] }) {
  const finalStep = mode === "observe"
    ? "Observe mode records the incident and alerts you, but never sends a quarantine command."
    : mode === "approval"
      ? "Approval mode waits for you to inspect the incident and explicitly approve quarantine. Nothing is stopped automatically."
      : "Automatic mode may quarantine a standard or disposable object immediately after every safety requirement passes.";

  return (
    <section className="protection-explainer">
      <header>
        <Icon name="shield" />
        <div>
          <strong>What "stop this object" actually means</strong>
          <p>An exact-object stop is a deployment-carried application fuse—not a Cloudflare pause switch.</p>
        </div>
      </header>
      <div className="protection-body">
        <section className="explainer-section">
          <h3>How Brolly reaches one object from outside</h3>
          <ol className="control-flow">
            <li><span>1</span><div><strong>Detect and identify</strong><p>A bounded scan attributes the emergency to one 64-character Durable Object ID.</p></div></li>
            <li><span>2</span><div><strong>Deploy a fuse generation</strong><p>Brolly updates the owning Worker's reserved BROLLY_FUSE secret. Cloudflare creates and deploys a new Worker version.</p></div></li>
            <li><span>3</span><div><strong>Compare locally</strong><p>The Worker ingress guard and object constructor compare the requested or current 64-character object ID against the secret entirely in memory.</p></div></li>
            <li><span>4</span><div><strong>Eject before application code</strong><p>Only the matching object throws before fetch, RPC, alarm, or WebSocket handlers run. No Brolly, KV, D1, HTTP, or object-storage lookup occurs.</p></div></li>
          </ol>
        </section>
        <ObjectStopImpact />
        <section className="mode-explanation">
          <strong>What your selected mode does</strong>
          <p>{finalStep} Warning and critical incidents only alert; only an emergency is eligible for quarantine.</p>
        </section>
      </div>
      <div className="quarantine-note">
        <strong>This requires one package and one constructor line in the owning runtime.</strong> Cloudflare deploys the fuse at Worker-script scope, so other live objects in that script may be restarted during rollout even though only the selected ID is denied. Nothing is deleted.
      </div>
    </section>
  );
}

/** Copy-paste runtime integration guide, kept in lockstep with docs/runtime-integration.md. */
export function RuntimeInstallGuide() {
  return (
    <div className="runtime-install-guide">
      <ol>
        <li>
          <span>1</span>
          <div>
            <strong>Install the package in the protected Worker</strong>
            <pre><code>pnpm add @standardagents/brolly-runtime</code></pre>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>Require and initialize the deployment secret</strong>
            <pre><code>{`// wrangler.jsonc
"secrets": { "required": ["BROLLY_FUSE"] }

printf '%s' '{"version":1,"generation":0,"objects":{}}' \\
  | pnpm wrangler secret put BROLLY_FUSE`}</code></pre>
            <p>Secrets survive ordinary code deployments. Brolly replaces this value only when applying or clearing a quarantine. Its Cloudflare account grant must include <strong>Workers Scripts Write</strong>; without it, the action fails and Brolly records the error instead of claiming a stop.</p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>Add one line after super() in every protected Durable Object</strong>
            <pre><code>{`constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env)
  brollyDurableObject(ctx, env)
}`}</code></pre>
          </div>
        </li>
        <li>
          <span>4</span>
          <div>
            <strong>Guard Worker ingress before work starts</strong>
            <pre><code>{`brollyWorker(env)
const id = env.ROOMS.idFromName(name)
brollyWorker(env, { durableObjectId: id.toString() })
return env.ROOMS.get(id).fetch(request)`}</code></pre>
            <p>The first call enforces a Worker-wide stop. The second avoids waking an exact quarantined object. The constructor line remains the final backstop.</p>
          </div>
        </li>
        <li>
          <span>5</span>
          <div>
            <strong>Map each namespace to its owning Worker</strong>
            <pre><code>brolly classify durable_objects NAMESPACE_ID standard --worker-script=my-worker</code></pre>
            <p>The budget wizard's install step saves the same mapping. Individual object IDs inherit it from their namespace. Do this before enabling automatic mode; clearing remains an explicit Resume action.</p>
          </div>
        </li>
      </ol>
      <div className="quarantine-note">
        <strong>Runtime cost:</strong> the checks only parse an environment binding and compare IDs. They do not call Brolly, Cloudflare APIs, KV, D1, or Durable Object storage.
      </div>
    </div>
  );
}

export function ScanInfoTip() {
  return (
    <InfoTip label="What does an account scan do?" align="right">
      <h4>What Brolly scans</h4>
      <p>It inventories Workers, Durable Object namespaces, Queues, D1, R2, KV, Vectorize, Hyperdrive, Pages, AI Gateway, and zones, then asks Cloudflare Analytics for aggregate five-minute Durable Object and Worker usage.</p>
      <h4>Cadence</h4>
      <p>The same bounded monitor runs automatically every minute. Every 15 minutes it adds one rolling-24-hour Durable Objects query. Once daily it reconciles the Billing API when a Billing Read token is configured.</p>
      <h4>Cost and safety</h4>
      <p>A typical one-page account uses about 13 Cloudflare API requests per pass, plus one every 15 minutes and one for the daily billing read. It does <strong>not</strong> wake every Durable Object or read customer-object SQLite rows.</p>
      <p>Brolly's own Worker invocation, CPU, and D1 operations remain billable under your plan. Each pass hard-stops at 150 Cloudflare API calls, 25,000 Brolly D1 row operations, 20,000 samples, or 45 seconds. These are workload caps, not a guaranteed dollar cap.</p>
    </InfoTip>
  );
}
