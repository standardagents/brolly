# Worker and Durable Object runtime integration

Brolly can detect usage without changing application code. Precise shutdown is
different: Cloudflare does not expose an account API that pauses one Durable
Object, so a protected Worker must install `@standardagents/brolly-runtime`.

The integration is deliberately synchronous and performs zero hot-path I/O.
Brolly carries the quarantine set in a reserved Worker secret. Cloudflare
creates and immediately deploys a Worker version when Brolly changes that
secret; the installed guards only parse `env.BROLLY_FUSE` and compare IDs
locally.

## 1. Install the package

Run this in every Worker project that Brolly should be able to stop:

```bash
pnpm add @standardagents/brolly-runtime
```

Declare the secret as required in `wrangler.jsonc`:

```jsonc
{
  "secrets": {
    "required": ["BROLLY_FUSE"]
  }
}
```

Initialize the secret once:

```bash
printf '%s' '{"version":1,"generation":0,"objects":{}}' \
  | pnpm wrangler secret put BROLLY_FUSE
```

Cloudflare secrets omitted from later ordinary deployments are preserved.
Brolly becomes the source of truth for subsequent fuse generations.

Brolly's Cloudflare account authorization must include **Workers Scripts
Write**. This is included by the installer's default Workers Platform write
grant. If that permission is removed, a quarantine action fails visibly and is
audited; Brolly does not report the resource as stopped.

## 2. Add one constructor line to each Durable Object

```ts
import { DurableObject } from "cloudflare:workers";
import { brollyDurableObject } from "@standardagents/brolly-runtime";

export class ChatRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    brollyDurableObject(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    return new Response("running");
  }
}
```

Normally `brollyDurableObject(ctx, env)` returns immediately. If the current
64-character `ctx.id` or its entire Worker is explicitly quarantined, it throws
`BrollyQuarantinedError` before fetch, RPC, alarm, or WebSocket application
handlers run. Invalid or absent configuration is not treated as an explicit
shutdown.

`ctx` is required because every object in the Worker receives the same `env`;
`ctx.id` is the only local identity of the current object.

## 3. Guard Worker ingress

The constructor is the final backstop. The caller-side check prevents a known
quarantined object from being awakened repeatedly:

```ts
import {
  BrollyQuarantinedError,
  brollyWorker,
} from "@standardagents/brolly-runtime";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      brollyWorker(env);

      const name = new URL(request.url).pathname;
      const id = env.CHAT_ROOMS.idFromName(name);
      brollyWorker(env, { durableObjectId: id.toString() });
      return await env.CHAT_ROOMS.get(id).fetch(request);
    } catch (error) {
      if (error instanceof BrollyQuarantinedError) {
        return Response.json(
          { error: "Temporarily unavailable", incidentId: error.quarantine.incidentId },
          { status: 503, headers: { "Retry-After": "300", "X-Brolly-Quarantined": "true" } },
        );
      }
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
```

Also call `brollyWorker(env)` first in `scheduled`, `queue`, and `email`
handlers. If another uninstrumented Worker calls the object directly, the
constructor line still blocks its application code.

## 4. Associate telemetry with its owning Worker

Brolly needs the Worker script name because Cloudflare deploys secrets at
Worker-script scope. During first-run setup, use **Connect the resources Brolly
discovered** to:

1. Confirm the Worker ingress guard is installed on each protected script.
2. Enter the owning Worker script for each Durable Object namespace.
3. Confirm the constructor guard is installed for that namespace's classes.

Unchecked or unmapped resources continue to generate alerts, but Brolly will
not claim that it can quarantine them. The owning Worker comes only from
Cloudflare namespace inventory; neither the UI nor CLI can override it. The
namespace tier and verified integration are inherited by subsequently observed
object IDs. Do this before enabling automatic mode.

## Verify the installation in Brolly

Open the separate **Configuration** page after deploying the application
Worker. It lists every discovered Worker script and Durable Object namespace;
configuration is intentionally per-resource rather than account-wide.

Select **Refresh** on one Worker, or **Refresh all statuses**, to run these
passive checks:

1. Brolly can read the Worker through the Cloudflare API.
2. A `secret_text` binding named `BROLLY_FUSE` exists.
3. Cloudflare reports an active Worker deployment and version.
4. The deployed bundle contains the `BROLLY_QUARANTINED` runtime marker.

The namespace inventory returned by Cloudflare includes its Worker script and
class. Brolly compares that authoritative owner with the saved installation
declaration and highlights mismatches. A namespace is shown as configured only
when its constructor installation was confirmed and its own Worker—not merely
some Worker in the account—has current successful evidence.

The page uses four explicit states:

- **Configured** — declaration, secret, deployed runtime marker, and active
  deployment evidence are all present.
- **Partial** — some installation pieces are present, but precise protection is
  incomplete.
- **Not configured** — the resource is monitored but remains alert-only.
- **Needs attention** — a live check failed or the declared owner conflicts
  with Cloudflare inventory.

This refresh is deliberately non-destructive. It does not invoke a Worker,
wake a Durable Object, read object storage, deploy a fuse, or prove that a
constructor rejection path was exercised. The UI says exactly which evidence
is operator-confirmed versus remotely observed.

## What enforcement does

At an eligible emergency threshold:

1. Brolly creates or reuses an idempotent control action.
2. In approval mode it waits for an operator. In automatic mode it proceeds
   only for `standard` or `disposable` assets marked as fuse-integrated.
3. Brolly adds the exact object ID, or the entire Worker, to its current
   `BROLLY_FUSE` manifest.
4. Brolly updates the owning Worker's secret through Cloudflare's API, which
   creates and deploys a new Worker version.
5. The Worker and constructor guards enforce the new generation locally.

If the package-installed confirmation or Worker mapping is absent, automatic
mode sends the incident notification without mutating Cloudflare. It does not
guess a script name or deploy an unverified fuse.

The manifest is capped below Cloudflare's 5 KB per-binding limit. It contains
only active emergency quarantines, not Brolly's policy database.

Automatic execution additionally requires two consecutive fresh emergency
observations from a raw usage meter and a successful configuration refresh in
the last 24 hours. It never acts from projected dollars or delayed billing
data. Changes for the same Worker are coalesced and bounded; independent
per-pass, per-Worker, and per-account circuit breakers stop deployment storms.

## Recovery

Recovery is manual by default. Selecting **Resume** removes only that action's
Worker or object target, increments the generation, and deploys the secret
again. Other active quarantines in the same Worker remain present. Brolly does
not auto-resume merely because usage fell after shutdown; that would cause a
runaway resource to flap on and off.

Quarantine never deletes Durable Object storage. Cloudflare deployments operate
at Worker-script scope, so unrelated live objects in that Worker may restart
during rollout even though only the selected ID is denied. Existing synchronous
JavaScript cannot be interrupted at an arbitrary instruction; the fuse protects
subsequent construction and events.

Cloudflare may retry a failed Durable Object alarm. A constructor quarantine
therefore prevents the application work but can still produce the platform's
bounded alarm retry attempts. Put the caller-side `brollyWorker` check on every
entry point you control, and treat alarm-heavy objects as a separate service
impact during incident review.

## Runtime cost and failure behavior

The guards do not call Brolly, Cloudflare's API, Service Bindings, KV, D1, or
Durable Object storage. The external operation occurs once in Brolly's control
plane when applying or clearing the secret. Malformed fuse data is ignored
rather than turning a configuration mistake into an account outage; Brolly's
deployment action records Cloudflare failures and alerts the operator.

The previous signed callback endpoint is not reachable from Brolly's action API.
It was retired because arbitrary external callback targets are not an acceptable
control-plane trust boundary. New and existing actions require the deployment
fuse and Cloudflare's authoritative Worker mapping.
