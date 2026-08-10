# @standardagents/brolly

Run `pnpm dlx @standardagents/brolly install` to connect one Cloudflare account and prepare a self-hosted Brolly guard deployment. The package deploys the Vite-built React dashboard and API Worker together. The first authenticated dashboard login requires account, product-family, per-Worker, per-Durable-Object-namespace, and per-object spending limits. Run `brolly help` for status, incident, classification, notification-target, policy-mode, stop, and rollback commands.

After installing the guard, instrument every Worker that Brolly should be able
to quarantine:

```bash
pnpm add @standardagents/brolly-runtime
printf '%s' '{"version":1,"generation":0,"objects":{}}' \
  | pnpm wrangler secret put BROLLY_FUSE
```

Add `brollyDurableObject(ctx, env)` immediately after `super(ctx, env)` in each
Durable Object constructor and `brollyWorker(env)` before Worker work. Associate
the namespace with its owning script before enabling automatic mode (an exact
object classification can override this inherited mapping):

```bash
brolly classify durable_objects NAMESPACE_ID standard --worker-script=my-worker
```

See [`../../docs/runtime-integration.md`](../../docs/runtime-integration.md)
for the complete Worker and Durable Object example and recovery semantics.
