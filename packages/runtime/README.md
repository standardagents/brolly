# `@standardagents/brolly-runtime`

Zero-hot-path-I/O shutdown fuses for Cloudflare Workers and Durable Objects.

## Install

```bash
pnpm add @standardagents/brolly-runtime
```

Declare Brolly's deployment-carried secret in `wrangler.jsonc`:

```jsonc
{
  "secrets": {
    "required": ["BROLLY_FUSE"]
  }
}
```

Initialize it once. Brolly will replace this value with versioned quarantine
manifests when an approved or automatic emergency action runs.

```bash
printf '%s' '{"version":1,"generation":0,"objects":{}}' \
  | pnpm wrangler secret put BROLLY_FUSE
```

## Durable Object: one required line

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

The guard parses `env.BROLLY_FUSE`, compares `ctx.id.toString()` locally, and
normally returns immediately. An explicit worker-wide or exact-object
quarantine throws `BrollyQuarantinedError` before `fetch`, RPC, `alarm`, or
WebSocket handlers run. It never calls Brolly, Cloudflare's API, KV, D1, or the
object's storage.

## Worker ingress

Call `brollyWorker(env)` first to enforce a whole-Worker stop. Before invoking
a Durable Object, pass the target ID so a quarantined object is rejected
without waking it:

```ts
import {
  BrollyQuarantinedError,
  brollyWorker,
} from "@standardagents/brolly-runtime";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      brollyWorker(env);
      const id = env.CHAT_ROOMS.idFromName(new URL(request.url).pathname);
      brollyWorker(env, { durableObjectId: id.toString() });
      return env.CHAT_ROOMS.get(id).fetch(request);
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

Use `brollyWorker(env)` first in `scheduled`, `queue`, and `email` handlers as
well. Constructor enforcement is the final backstop; the ingress check avoids
repeated billable Durable Object activations.

Quarantine never deletes application data. Recovery is manual by default:
Brolly removes the target from the secret and deploys the next fuse generation.
