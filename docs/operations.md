# Operations

The minute cron is intentionally bounded. If it reaches a request, row, sample, or wall-time budget, it stops collecting, commits a `monitoring_budget_exhausted` incident, and sends one deduplicated notification. It does not retry in a tight loop.

Each pass refreshes inventory for Workers, Durable Object namespaces, Queues,
D1, R2, KV, Vectorize, Hyperdrive, Pages, AI Gateway, and zones, then issues one
aggregate Durable Objects GraphQL request and one aggregate Workers GraphQL
request over the latest five-minute window. A one-page account normally uses
about 13 Cloudflare API requests. Every 15 minutes Brolly adds one direct
rolling-24-hour Durable Objects query; once daily it adds the optional Billing
API reconciliation. Inventory pagination can increase that count, but the hard
limit remains 150 API calls per pass.

These analytics queries do not wake each Durable Object and do not read its
private SQLite rows. The monitoring cost is Brolly's own scheduled Worker
invocation/CPU and bounded D1 activity. Per-pass limits are 25,000 D1 row
operations, 20,000 samples, and 45 seconds. They are workload ceilings, not a
guaranteed dollar ceiling. A manual dashboard scan runs the same monitor; the
55-second lease prevents it from overlapping the automatic minute pass.

Live Durable Object evaluation covers every object returned by eight bounded
per-metric operation queries, plus retained storage at Cloudflare's available
namespace/account scopes. Historical baseline retention runs only every
15 minutes and stores operation metrics for at most the 333 highest
estimated-cost objects. New inventory is visible immediately, while existing asset
freshness writes are coalesced to once per hour. This
prevents Brolly's own D1 writes from scaling without a deterministic ceiling.

The gross cost projection applies the published paid-plan marginal rates and
the 20:1 incoming WebSocket message conversion. It deliberately ignores monthly
included usage, discounts, and credits; daily Billing Read reconciliation is the
authoritative backstop. SQLite retained data is attributable only to namespace
and legacy key-value retained data only to account because those are the finest
dimensions in Cloudflare Analytics.

The dashboard separates response and observability state:

- **Usage incidents** crossed a configured hard or anomaly threshold and can
  be acknowledged or routed into a reversible control.
- **Coverage gaps** mean a collector is missing, delayed, or lacks permission.
  They are prominent but are not counted as spend incidents.
- **Current daily spend** is a gross rolling-24-hour telemetry estimate by
  product category. It is not an invoice and is labeled as such.

When `BROLLY_ACCOUNT_ID` is still the installer placeholder, the dashboard is
in **Local preview**. Live spend and inventory are explicitly labeled as
unavailable/sample data, and scan errors show a readable connection diagnosis
instead of raw provider JSON. A non-placeholder account with authentication or
routing failures is marked **Cloudflare connection needs attention**. Do not
treat either state as active protection.

On first authenticated login, complete all four budget steps. Brolly requires
ordered account limits, a limit for every product family, a limit for every
discovered Worker script and Durable Object namespace, and all supported
per-object Durable Object windows. Product or resource limits marked `Collector pending`
are retained but cannot be enforced until coverage becomes healthy. Reopen the
same wizard with **Budgets** in the dashboard header.

Before enabling automatic controls:

1. Complete OAuth installation and select exactly one account.
2. Configure a manual Billing Read token if invoice reconciliation is required.
3. Configure at least two notification paths, ideally one webhook and one SMS/email path.
4. Classify assets and verify the Brolly control-plane allowlist.
5. Run controls in `observe` mode, then `approval`, before enabling `automatic`.
6. Test stop and rollback for each actuator.

The guard has three bounded, reversible actuators. Runtime quarantine publishes
a secret-backed deployment fuse that makes one exact Durable Object or one
instrumented Worker reject application work without a runtime lookup. Queue pause records the queue's current settings before setting
`delivery_paused`. Worker ingress disable records Cron Triggers, workers.dev
state, zone routes, and custom domains before removing them. The rollback snapshot is committed
to D1 and audited before any Cloudflare mutation starts. Brolly never deletes a
Worker, queue, Durable Object, or its stored data.

Automatic actions are deliberately narrower: only classified `standard` or
`disposable` Durable Objects and Workers marked with a tested
`@standardagents/brolly-runtime` fuse can be quarantined automatically at an
emergency threshold. Broader trigger removal and queue controls always require
an explicit operator action. `control_plane`, `critical`, and `unclassified`
assets cannot be stopped through the normal action endpoint.

Exact-object quarantine is customer-visible downtime for that object. Worker
ingress can return HTTP 503 before waking it, and the constructor throws before
application handlers run. Stored state is preserved and sibling IDs are not
denied, although a Worker-version rollout may restart other live objects in the
same script. Recovery is manual by default so a stopped spike cannot flap back
on automatically. If a runtime has not installed the fuse, there is no
exact-object actuator; disabling its parent Worker has a namespace-wide or
user-wide blast radius and must be reviewed as a different control.

`brolly status`, `brolly incidents`, `brolly stop`, and `brolly resume` call the guard Worker with the local recovery token stored mode `0600` in `~/.brolly/config.json`; they do not depend on a browser session.

## Configuration verification

The dashboard's **Configuration** page is the readiness inventory for runtime
controls. Workers and Durable Object namespaces are evaluated independently so
partial rollouts remain visible. Cloudflare namespace inventory supplies the
authoritative owning Worker and class; operator declarations are retained
separately and mismatches are surfaced rather than silently overwritten.

A live refresh is operator-initiated and cached in D1. It uses three
control-plane reads per Worker: secrets, deployments, and deployed script
content. Each API request accepts at most 20 Workers, processes at most three
Workers concurrently, times out individual Cloudflare calls after ten seconds,
and scans no more than 5 MB of a deployed bundle. **Refresh all** chunks larger
accounts into those bounded requests. Configuration refresh is not part of the
automatic minute monitor and never invokes customer Workers or Durable Objects.

Cached evidence includes the check time, active deployment/version IDs, secret
presence, and runtime-marker result. A new inventory scan can add resources
without affecting the statuses of already verified Workers; the new rows begin
as not configured or partial until explicitly declared and refreshed.

Notification targets are capped at 20 deliveries per hour. Twilio targets are
additionally capped at five SMS messages per day. Incident notifications roll
up for 15 minutes, while the configured daily summary bypasses severity filters
but still respects delivery caps. Provider credentials are AES-GCM encrypted in
D1 with a key held only as a Worker secret.

Discord, Slack, and Twilio SMS can be configured under **Incident
notifications** on the separate `/settings` page. The read API returns only target status,
minimum severity, and last-delivery metadata; it never decrypts or returns a
webhook URL, Twilio token, or phone number. Use **Replace credentials** to rotate
a destination, **Pause** to stop delivery without losing its encrypted config,
and the severity menu to change escalation without re-entering secrets. Saving
a target does not emit a test message.

Control actions on the **Incidents & controls** page (the overview shows the
five most recent) are operator controls, not a passive log. Open a row to see
its target, reason, timestamps, provider link, current state, and any failure.
A `prepared` action can be approved and executed there; a `succeeded` action
can be restored from its rollback snapshot. A failed action also exposes
rollback because a provider mutation may have completed before a later step
failed. Every execute or restore still requires a confirmation in the browser.
Resuming a legacy signed-runtime quarantine can optionally release its forensic
hold; the deployment-fuse path ignores that flag.

## Dashboard development

```bash
pnpm --filter @standardagents/brolly-guard dev
pnpm --filter @standardagents/brolly-guard build
pnpm --filter @standardagents/brolly-guard preview
```

Development and preview both run through the Cloudflare Vite plugin so Worker
bindings and SPA routing match production. The development server is pinned to
port `5173` with `strictPort` enabled.
