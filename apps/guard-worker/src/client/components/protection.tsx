import { useState } from "react";
import { Icon, InfoTip, ProductIcon } from "./ui";
import type { OnboardingData, Policy } from "../types";

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
            <p>An installed Worker guard can reject every instrumented entry point through the same fuse. Without the package, Brolly remains alert-only; it will not remove routes, domains, triggers, or the Worker.</p>
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
            <p>Cloudflare has no generic account API to terminate every Durable Object instance. Brolly deliberately has no broad route-deletion fallback: account-wide containment must be performed directly in Cloudflare with its outage impact reviewed.</p>
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

export function runtimeAgentPrompt(assets: OnboardingData["scopedAssets"]): string {
  const workers = assets.filter(asset => asset.family === "workers").map(asset => asset.name);
  const namespaces = assets.filter(asset => asset.family === "durable_objects").map(asset => {
    const owner = asset.tags.cloudflareWorkerScript;
    return owner ? `${asset.name} (owning Worker: ${owner})` : `${asset.name} (confirm its owning Worker)`;
  });
  const scope = [
    workers.length ? `Discovered Worker scripts: ${workers.join(", ")}.` : "Discover every Worker entry point in this repository.",
    namespaces.length ? `Discovered Durable Object namespaces: ${namespaces.join(", ")}.` : "Discover every Durable Object class and namespace in this repository.",
  ].join("\n");

  return `Add Brolly's reversible runtime quarantine protection to this Cloudflare Worker project.

${scope}

Requirements:
1. Inspect the repository first. Use its existing package manager, Worker entry points, Durable Object classes, Wrangler configuration, tests, and formatting conventions.
2. Install @standardagents/brolly-runtime.
3. In every protected Durable Object constructor, import brollyDurableObject and call brollyDurableObject(ctx, env) immediately after super(ctx, env).
4. Call brollyWorker(env) before application work in fetch, scheduled, queue, and email entry points. Before waking a known Durable Object, also call brollyWorker(env, { durableObjectId: id.toString() }).
5. At HTTP ingress, catch BrollyQuarantinedError and return a clear 503 response with Retry-After and X-Brolly-Quarantined headers. Do not swallow unrelated errors.
6. Declare BROLLY_FUSE as a required Worker secret. Never hardcode a fuse value or put one in source control.
7. Add or update focused tests for the protected entry points and run the relevant checks.

Safety boundaries:
- Make code and local configuration changes only. Do not deploy, set secrets, change routes, or mutate anything in Cloudflare.
- The runtime checks must remain synchronous and local: no HTTP, service binding, KV, D1, Durable Object storage, or other external operation.
- Preserve existing behavior whenever the fuse is absent, malformed, or does not target this Worker/object.

When finished, report the files changed, every protected Worker entry point and Durable Object class, any unprotected gaps, the checks you ran, and the exact manual command I should run to initialize BROLLY_FUSE. Remind me to deploy, return to Brolly's Configuration page, and refresh the affected Worker before enabling automatic quarantine. Do not claim quarantine is configured until that verification passes.`;
}

/** A safe code-agent handoff for the optional runtime fuse installation. */
export function RuntimeAgentHandoff({ assets }: { assets: OnboardingData["scopedAssets"] }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const prompt = runtimeAgentPrompt(assets);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = prompt;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  }

  return (
    <section className="agent-handoff" aria-labelledby="agent-handoff-title">
      <header>
        <div>
          <p className="eyebrow orange">Recommended</p>
          <h3 id="agent-handoff-title">Hand this to your coding agent</h3>
          <p>The prompt finds your Worker entry points and Durable Object classes, installs the two local guards, adds tests, and stops before making any Cloudflare changes.</p>
        </div>
        <div className="agent-roster" aria-label="Compatible coding agents">
          <AgentChip kind="claude" label="Claude Code" />
          <AgentChip kind="codex" label="Codex" />
          <AgentChip kind="cursor" label="Cursor" />
          <AgentChip kind="terminal" label="Other agent" />
        </div>
      </header>
      <div className="agent-prompt">
        <div className="agent-prompt-bar">
          <span><i aria-hidden="true" />Brolly runtime install task</span>
          <button type="button" className="button primary copy-agent-prompt" onClick={() => void copyPrompt()}>
            <Icon name={copied ? "check" : "clipboard"} />
            {copied ? "Copied" : "Copy agent prompt"}
          </button>
        </div>
        <div className={`agent-prompt-preview ${expanded ? "expanded" : ""}`}>
          <pre tabIndex={0} role="region" aria-label="Coding agent prompt"><code>{prompt}</code></pre>
        </div>
        <button type="button" className="agent-prompt-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Collapse prompt" : "Show full prompt"}
        </button>
      </div>
      <div className="agent-handoff-safety">
        <Icon name="shield" />
        <p><strong>Safe handoff:</strong> the agent edits and tests your repository, but the prompt forbids deployment or Cloudflare mutations. You review the diff and initialize the secret yourself.</p>
      </div>
      <span className="visually-hidden" aria-live="polite">{copied ? "Brolly runtime installation prompt copied" : ""}</span>
    </section>
  );
}

function AgentChip({ kind, label }: { kind: "claude" | "codex" | "cursor" | "terminal"; label: string }) {
  return (
    <span className="agent-chip">
      <span className={`agent-glyph ${kind}`} aria-hidden="true">
        {kind === "claude" && <svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" /></svg>}
        {kind === "codex" && <svg viewBox="0 0 24 24"><path d="m12 3 7.8 4.5v9L12 21l-7.8-4.5v-9L12 3Z" /><circle cx="12" cy="12" r="3.3" /></svg>}
        {kind === "cursor" && <svg viewBox="0 0 24 24"><path d="m6 3 12 10-6.2.8L9 20 6 3Z" /></svg>}
        {kind === "terminal" && <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>}
      </span>
      {label}
    </span>
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
