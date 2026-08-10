# @standardagents/brolly

Run `pnpm dlx @standardagents/brolly install` to connect one Cloudflare account and prepare a self-hosted Brolly guard deployment. The package deploys the Vite-built React dashboard and API Worker together. The first authenticated dashboard login requires account, product-family, per-Worker, per-Durable-Object-namespace, and per-object spending limits. Run `brolly help` for status, incident, classification, notification-target, policy-mode, stop, and rollback commands.

The installer opens Brolly's publisher-owned Cloudflare OAuth client, uses PKCE
with a fixed loopback callback, and asks you to authorize exactly one account.
You do not need to create an OAuth client or paste an API token.

After installing the guard, instrument every Worker that Brolly should be able
to quarantine:

```bash
pnpm add @standardagents/brolly-runtime
printf '%s' '{"version":1,"generation":0,"objects":{}}' \
  | pnpm wrangler secret put BROLLY_FUSE
```

Add `brollyDurableObject(ctx, env)` immediately after `super(ctx, env)` in each
Durable Object constructor and `brollyWorker(env)` before Worker work. Refresh
the Configuration page before enabling automatic mode. Brolly accepts the
namespace-to-Worker relationship only from Cloudflare inventory; the CLI can
classify a safety tier but cannot override ownership.

See [`../../docs/runtime-integration.md`](../../docs/runtime-integration.md)
for the complete Worker and Durable Object example and recovery semantics.
