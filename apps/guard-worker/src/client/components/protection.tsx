import { useState, type ReactNode } from "react";
import { Highlight, type CodeLang } from "./highlight";
import { Button, Eyebrow, Icon, InfoTip, Panel, PanelHead, Pill, ProductIcon, StepNumber, type Tone } from "./ui";
import type { OnboardingData } from "../types";

/** Quiet highlighted code block used by the install guide. */
function Code({ lang = "shell", children }: { lang?: CodeLang; children: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-field border border-code-line bg-code-bg px-3.5 py-3 text-[12px] leading-[1.55] text-code-ink">
      <code className="font-mono break-normal"><Highlight code={children} lang={lang} /></code>
    </pre>
  );
}

/** Warning-toned footnote used under the explainer and the install guide. */
function QuarantineNote({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`rounded-field border border-warn-line bg-warn-soft px-[13px] py-[11px] text-[12.5px] leading-[1.5] text-warn-ink ${className}`}>
      {children}
    </div>
  );
}

/**
 * Shared, exact language about what shutdown levers exist. Brolly cannot
 * externally terminate one live Durable Object by opaque ID without runtime
 * cooperation, and this copy must never imply otherwise.
 */
export function ControlCapabilities() {
  return (
    <Panel id="shutdown-options" className="pb-4">
      <PanelHead
        eyebrow="Shutdown playbook"
        title="What Brolly can stop"
        titleExtra={
          <InfoTip label="How shutdown controls work">
            <h4>Detection is not enforcement</h4>
            <p>A budget crossing creates an incident. A stop is available when the asset is classified, the relevant control is supported, and an alert-level entry enables it.</p>
            <p>Every Cloudflare-side change saves rollback state first and is written to the audit log. Brolly never deletes stored customer data.</p>
          </InfoTip>
        }
        sub="The blast radius depends on which lever exists for that Cloudflare resource."
      />
      <div className="grid grid-cols-2 gap-2.5 px-5 pt-1 pb-1.5 max-xl:grid-cols-[minmax(0,1fr)]">
        <CapabilityCard
          icon={<ProductIcon family="durable_objects" />}
          title="One Durable Object"
          pill="Precise · needs circuit breaker"
          tone="good"
        >
          The deployed breaker names one exact 64-character object ID. Its constructor throws before application handlers run, while stored data and other IDs remain available. A Worker-version rollout may restart other live objects in that script.
        </CapabilityCard>
        <CapabilityCard
          icon={<ProductIcon family="workers" />}
          title="One Worker script"
          pill="Broad impact"
          tone="warn"
        >
          An installed breaker can reject every instrumented entry point in the Worker. Without the package, Brolly remains alert-only; it will not remove routes, domains, triggers, or the Worker.
        </CapabilityCard>
        <CapabilityCard
          icon={<ProductIcon family="queues" />}
          title="Queue delivery"
          pill="Reversible pause"
          tone="blue"
        >
          Brolly can pause the queue consumer. Messages remain queued, but processing stops until rollback restores the consumer. Producers may continue adding backlog and storage/retention rules still apply.
        </CapabilityCard>
        <CapabilityCard
          icon={<span className="grid size-[34px] flex-none place-items-center rounded-[7px] bg-danger-bg text-danger"><Icon name="alert" /></span>}
          title={'Account-wide "kill every object"'}
          pill="Not exposed by Cloudflare"
          tone="danger"
          muted
        >
          Cloudflare has no generic account API to terminate every Durable Object instance. Brolly deliberately has no broad route-deletion fallback: account-wide containment must be performed directly in Cloudflare with its outage impact reviewed.
        </CapabilityCard>
      </div>
    </Panel>
  );
}

function CapabilityCard({ icon, title, pill, tone, muted = false, children }: {
  icon: ReactNode;
  title: ReactNode;
  pill: string;
  tone: Tone;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <article className={`flex min-w-0 gap-3 rounded-field border border-line p-3.5 ${muted ? "bg-panel-soft" : ""}`}>
      {icon}
      <div className="min-w-0 flex-1">
        <strong className="block text-[13.5px]">{title}</strong>
        <Pill tone={tone} className="mt-1 mb-1.5">{pill}</Pill>
        <p className="m-0 text-[12.5px] leading-[1.5] text-muted">{children}</p>
      </div>
    </article>
  );
}

function ImpactCard({ accent, title, children }: { accent: string; title: ReactNode; children: ReactNode }) {
  return (
    <div className={`rounded-field border border-line-soft border-l-[3px] bg-panel px-3 py-2.5 ${accent}`}>
      <strong className="mb-[3px] block text-[12.5px]">{title}</strong>
      <p className="m-0 text-[12px] leading-[1.5] text-muted">{children}</p>
    </div>
  );
}

/** Exact service-impact framing for an exact-object quarantine. */
export function ObjectStopImpact({ compact = false }: { compact?: boolean }) {
  return (
    <section>
      <h3 className="mb-2 text-[13.5px]">Service impact while quarantined</h3>
      <div className={`grid gap-2 ${compact ? "grid-cols-1" : "grid-cols-2 max-md:grid-cols-1"}`}>
        <ImpactCard accent="border-l-[#e0a53a]" title="Deployment enforcement">
          Cloudflare rolls out a new Worker version. Existing synchronous code cannot be preempted at an arbitrary instruction, but subsequent object construction ejects before application code.
        </ImpactCard>
        <ImpactCard accent="border-l-danger" title="Blocked until resume">
          Worker ingress can return HTTP 503 before waking the object; the constructor guard also blocks direct calls, RPC, alarms, and WebSocket events.
        </ImpactCard>
        <ImpactCard accent="border-l-[#24a468]" title="Preserved">
          The object's SQLite rows, messages, queued records, and history are not deleted. Other object IDs keep serving normally.
        </ImpactCard>
        <ImpactCard accent="border-l-[#4d7cc2]" title="Recovery">
          Resume removes this ID from the secret and deploys the next generation. Recovery is manual by default so a stopped spike cannot flap back on automatically.
        </ImpactCard>
      </div>
    </section>
  );
}

function ControlFlowStep({ step, title, children }: { step: number; title: ReactNode; children: ReactNode }) {
  return (
    <li className="flex gap-[11px]">
      <StepNumber size={24}>{step}</StepNumber>
      <div>
        <strong className="text-[13px]">{title}</strong>
        <p className="mt-0.5 text-[12.5px] leading-[1.5] text-muted">{children}</p>
      </div>
    </li>
  );
}

export function ProtectionExplainer() {
  return (
    <section className="mt-[22px] overflow-hidden rounded-panel border border-line">
      <header className="flex gap-[11px] bg-dark-surface px-4 py-3.5 text-white">
        <Icon name="shield" className="mt-px size-[21px]" />
        <div>
          <strong className="text-[14px]">What "stop this object" actually means</strong>
          <p className="mt-0.5 text-[12.5px] text-[#aab2bc]">An exact-object stop is a circuit breaker carried in your Worker deployment; Cloudflare offers no external pause switch.</p>
        </div>
      </header>
      <div className="grid gap-4 p-4">
        <section>
          <h3 className="mb-2.5 text-[13.5px]">How Brolly reaches one object from outside</h3>
          <ol className="m-0 grid list-none gap-2 p-0">
            <ControlFlowStep step={1} title="Detect and identify">A bounded scan attributes the emergency to one 64-character Durable Object ID.</ControlFlowStep>
            <ControlFlowStep step={2} title="Deploy a breaker generation">Brolly updates the owning Worker's reserved BROLLY_FUSE secret. Cloudflare creates and deploys a new Worker version.</ControlFlowStep>
            <ControlFlowStep step={3} title="Compare locally">The Worker ingress guard and object constructor compare the requested or current 64-character object ID against the secret entirely in memory.</ControlFlowStep>
            <ControlFlowStep step={4} title="Eject before application code">Only the matching object throws before fetch, RPC, alarm, or WebSocket handlers run. No Brolly, KV, D1, HTTP, or object-storage lookup occurs.</ControlFlowStep>
          </ol>
        </section>
        <ObjectStopImpact />
        <section className="rounded-field border border-line bg-panel-soft px-3.5 py-3">
          <strong className="text-[13px]">What the alert-level board controls</strong>
          <p className="mt-[3px] text-[12.5px] text-muted">Channel and action entries accumulate from left to right. A quarantine entry can prepare or run a reversible control after every safety requirement passes.</p>
        </section>
      </div>
      <QuarantineNote className="mx-4 mb-4">
        <strong>This requires one package and one constructor line in the owning runtime.</strong> Cloudflare deploys the breaker at Worker-script scope, so other live objects in that script may be restarted during rollout even though only the selected ID is denied. Nothing is deleted.
      </QuarantineNote>
    </section>
  );
}

function InstallStep({ step, title, children }: { step: number; title: ReactNode; children: ReactNode }) {
  return (
    <li className="flex min-w-0 gap-3">
      <StepNumber>{step}</StepNumber>
      <div className="min-w-0 flex-1">
        <strong className="text-[13.5px]">{title}</strong>
        {children}
      </div>
    </li>
  );
}

/** Copy-paste runtime integration guide, kept in lockstep with docs/runtime-integration.md. */
export function RuntimeInstallGuide() {
  return (
    <div>
      <ol className="m-0 grid list-none grid-cols-[minmax(0,1fr)] gap-3.5 p-0">
        <InstallStep step={1} title="Install the package in the protected Worker">
          <Code>pnpm add @standardagents/brolly-runtime</Code>
        </InstallStep>
        <InstallStep step={2} title="Require and initialize the deployment secret">
          <Code>{`// wrangler.jsonc
"secrets": { "required": ["BROLLY_FUSE"] }

printf '%s' '{"version":1,"generation":0,"objects":{}}' \\
  | pnpm wrangler secret put BROLLY_FUSE`}</Code>
          <p className="mt-2 text-[12.5px] leading-[1.55] text-muted">Secrets survive ordinary code deployments. Brolly replaces this value only when applying or clearing a quarantine. Its Cloudflare account grant must include <strong>Workers Scripts Write</strong>; without it, the action fails and Brolly records the error instead of claiming a stop.</p>
        </InstallStep>
        <InstallStep step={3} title="Add one line after super() in every protected Durable Object">
          <Code lang="ts">{`constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env)
  brollyDurableObject(ctx, env)
}`}</Code>
        </InstallStep>
        <InstallStep step={4} title="Guard Worker ingress before work starts">
          <Code lang="ts">{`brollyWorker(env)
const id = env.ROOMS.idFromName(name)
brollyWorker(env, { durableObjectId: id.toString() })
return env.ROOMS.get(id).fetch(request)`}</Code>
          <p className="mt-2 text-[12.5px] leading-[1.55] text-muted">The first call enforces a Worker-wide stop. The second avoids waking an exact quarantined object. The constructor line remains the final backstop.</p>
        </InstallStep>
        <InstallStep step={5} title="Map each namespace to its owning Worker">
          <Code>brolly classify durable_objects NAMESPACE_ID standard --worker-script=my-worker</Code>
          <p className="mt-2 text-[12.5px] leading-[1.55] text-muted">The budget wizard's install step saves the same mapping. Individual object IDs inherit it from their namespace. Complete this before adding an auto quarantine entry; clearing remains an explicit Resume action.</p>
        </InstallStep>
      </ol>
      <QuarantineNote className="mt-3">
        <strong>Runtime cost:</strong> the checks only parse an environment binding and compare IDs. They do not call Brolly, Cloudflare APIs, KV, D1, or Durable Object storage.
      </QuarantineNote>
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
6. Declare BROLLY_FUSE as a required Worker secret. Never hardcode a BROLLY_FUSE value or put one in source control.
7. Add or update focused tests for the protected entry points and run the relevant checks.

Safety boundaries:
- Make code and local configuration changes only. Do not deploy, set secrets, change routes, or mutate anything in Cloudflare.
- The runtime checks must remain synchronous and local: no HTTP, service binding, KV, D1, Durable Object storage, or other external operation.
- Preserve existing behavior whenever the secret is absent, malformed, or does not target this Worker/object.

When finished, report the files changed, every protected Worker entry point and Durable Object class, any unprotected gaps, the checks you ran, and the exact manual command I should run to initialize BROLLY_FUSE. Remind me to deploy, return to Brolly's Configuration page, and refresh the affected Worker before enabling automatic quarantine. Do not claim quarantine is configured until that verification passes.`;
}

/** A safe code-agent handoff for the optional circuit breaker installation. */
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
    <section className="grid grid-cols-[340px_minmax(0,1fr)] gap-8 max-lg:grid-cols-1 max-lg:gap-5" aria-labelledby="agent-handoff-title">
      <div className="min-w-0">
        <Eyebrow tone="orange">Recommended</Eyebrow>
        <h3 id="agent-handoff-title" className="m-0 text-[17px] tracking-[-.015em]">Hand this to your coding agent</h3>
        <p className="mt-2 text-[13px] leading-[1.6] text-muted">The prompt installs the breaker in your repository and adds tests.</p>
        <p className="mt-2 flex items-start gap-2 text-[13px] leading-[1.6] text-muted">
          <Icon name="shield" className="mt-[3px] size-[15px] flex-none text-good" />
          <span>It cannot change Cloudflare. You review the diff.</span>
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-1.5" aria-label="Compatible coding agents">
          <AgentChip kind="claude" label="Claude Code" />
          <AgentChip kind="codex" label="Codex" />
          <AgentChip kind="cursor" label="Cursor" />
          <AgentChip kind="terminal" label="Other agent" />
        </div>
      </div>
      <div className="min-w-0 self-start overflow-hidden rounded-panel border border-code-line bg-code-bg">
        <div className="flex min-h-12 items-center justify-between gap-3 border-b border-code-line py-[7px] pr-2 pl-3.5 text-muted max-md:flex-col max-md:items-stretch max-md:p-2.5">
          <span className="inline-flex items-center gap-2 text-[11.5px] font-[720] tracking-[.02em]">
            <i className="block size-2 rounded-full bg-orange shadow-[0_0_0_3px_#f6821f26]" aria-hidden="true" />
            Circuit breaker install task
            <span className="rounded-full border border-code-line px-2 py-0.5 text-[10px] font-[750] uppercase tracking-[.06em] text-faint">Markdown</span>
          </span>
          <Button variant="secondary" className="min-h-[34px] max-md:w-full" onClick={() => void copyPrompt()}>
            <Icon name={copied ? "check" : "clipboard"} />
            {copied ? "Copied" : "Copy agent prompt"}
          </Button>
        </div>
        <div
          className={`relative overflow-hidden ${
            expanded
              ? "max-h-none"
              : "max-h-[176px] after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-[62px] after:bg-[linear-gradient(transparent,var(--code-bg))] after:content-['']"
          }`}
        >
          <pre tabIndex={0} role="region" aria-label="Coding agent prompt" className="m-0 max-h-[420px] overflow-auto rounded-none border-0 p-4 text-[11.5px] leading-[1.6] whitespace-pre-wrap text-code-ink max-md:max-h-[300px]"><code className="font-mono break-normal"><Highlight code={prompt} lang="md" /></code></pre>
        </div>
        <button
          type="button"
          className="min-h-[38px] w-full cursor-pointer border-0 border-t border-code-line bg-transparent text-[12px] font-bold text-muted hover:bg-code-line/50 hover:text-ink"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Collapse prompt" : "Show full prompt"}
        </button>
      </div>
      <span className="sr-only" aria-live="polite">{copied ? "Circuit breaker install prompt copied" : ""}</span>
    </section>
  );
}

const AGENT_GLYPH_BG: Record<string, string> = {
  claude: "bg-[#d97757]",
  codex: "bg-[#202123]",
  cursor: "bg-[#6b63dc]",
  terminal: "bg-[#58616d]",
};

function AgentChip({ kind, label }: { kind: "claude" | "codex" | "cursor" | "terminal"; label: string }) {
  const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <span className="inline-flex items-center gap-[5px] rounded-full border border-line bg-panel py-1 pr-2 pl-[5px] text-[10.5px] font-bold whitespace-nowrap text-muted">
      <span className={`grid size-5 place-items-center rounded-full text-white ${AGENT_GLYPH_BG[kind]}`} aria-hidden="true">
        {kind === "claude" && <svg viewBox="0 0 24 24" className="size-3" {...stroke}><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" /></svg>}
        {kind === "codex" && <svg viewBox="0 0 24 24" className="size-3" {...stroke}><path d="m12 3 7.8 4.5v9L12 21l-7.8-4.5v-9L12 3Z" /><circle cx="12" cy="12" r="3.3" /></svg>}
        {kind === "cursor" && <svg viewBox="0 0 24 24" className="size-3" fill="currentColor" stroke="none"><path d="m6 3 12 10-6.2.8L9 20 6 3Z" /></svg>}
        {kind === "terminal" && <svg viewBox="0 0 24 24" className="size-3" {...stroke}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>}
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
      <p>A one-minute scheduler claims bounded work. Active Worker and Durable Object usage refreshes every five minutes, inventory refreshes hourly, and Billing Read reconciliation runs hourly when configured.</p>
      <h4>Cost and safety</h4>
      <p>Durable Objects and Workers use keyset pages of up to 10,000 resources. Collection does not wake Durable Objects or read customer-object SQLite rows.</p>
      <p>Brolly's own Worker invocation, CPU, and D1 operations remain billable under your plan. Each pass has hard limits of 300 GraphQL dataset queries, 50 REST requests, 100,000 D1 rows read, 50,000 D1 rows written, and 45 seconds. Incomplete work retains its cursor and coverage state.</p>
    </InfoTip>
  );
}
