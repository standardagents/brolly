# Brolly

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/standardagents/brolly)

`@standardagents/brolly` is a self-hosted Cloudflare cost sentinel. It inventories billable asset families in one account, polls Durable Object telemetry every minute, reconciles Cloudflare's account-wide authoritative billing usage daily, and exposes reversible emergency controls. Durable Object fast telemetry covers every billable meter in Cloudflare's current pricing model: requests, compute GB-seconds, incoming WebSocket messages, SQLite rows read/written, legacy key-value read/write units and deletes, and retained storage. The metric catalog also records every known family whose fast collector is absent, so incomplete protection is visible and alerting rather than silently green.

The design assumes telemetry can fail. Every metric family has a coverage state (`healthy`, `delayed`, `unavailable`, or `permission_denied`), and missing coverage alerts instead of silently reporting zero usage.

The guard includes a React 19 dashboard built with Vite 8 and the Cloudflare
Vite plugin. Static dashboard assets and the API Worker deploy together. The
public `/docs` route provides the Brolly product overview, setup guide, runtime
integration examples, notification setup, and safety model without requiring
an admin token. Its **Deploy to Cloudflare** control opens Cloudflare's official
deployment flow; the OAuth-guided CLI remains available as an alternative.

The
first authenticated login must complete the server-backed budget wizard before
the dashboard unlocks: total account limits, daily limits for every cataloged
Cloudflare product family, an explicit daily budget for every discovered Worker
script and Durable Object namespace, and per-object Durable Object limits are
all stored in the audited policy.

## Guardrails

- Monitoring runs are capped at 150 Cloudflare API calls, 25,000 D1 rows, 20,000 samples, and 45 seconds.
- A typical one-page account scan makes about 13 control-plane/analytics API requests. It does not wake each Durable Object or query customer-object SQLite; Brolly's own Worker and D1 usage are the billable monitoring workload.
- Incident notification fan-out is deduplicated and rate-limited.
- Brolly never deletes resources or stored customer data.
- Automatic shutdown is opt-in per policy tier. Control-plane and critical assets only alert.
- Worker scripts and exact Durable Object IDs are quarantined through the zero-hot-path-I/O `@standardagents/brolly-runtime` deployment fuse. Without that package, Brolly can only use broader Cloudflare controls such as removing Worker ingress or pausing a queue consumer.
- The separate **Configuration** page shows every discovered Worker and Durable Object namespace independently, including partial installations, owning-Worker mappings, cached live evidence, and targeted refresh controls.

## Install

Use the **Deploy to Cloudflare** button above to clone Brolly, provision its D1
database, apply migrations, configure required values, and deploy the Worker
through Workers Builds.

Or use the OAuth-guided CLI installer:

```bash
pnpm dlx @standardagents/brolly install
```

The installer uses Cloudflare OAuth with PKCE for account-scoped read/write access. Cloudflare does not currently expose Billing Read or API Token creation through the OAuth scope catalog, so authoritative billing reconciliation uses an optional, manually created Billing Read token. Fast GraphQL telemetry and coverage alerts work without it.

Set `BROLLY_OAUTH_CLIENT_ID` to a public PKCE client registered with the
`account.read` and `workers-platform.write` scopes. The installer creates or
reuses the D1 database, applies its schema, deploys the guard Worker, installs
encrypted refreshable OAuth credentials and Worker secrets, and prints the
public runtime-control key. Override `BROLLY_OAUTH_SCOPES` if the registered
client uses a narrower scope set.

### Install precise shutdown in an application Worker

```bash
pnpm add @standardagents/brolly-runtime
printf '%s' '{"version":1,"generation":0,"objects":{}}' \
  | pnpm wrangler secret put BROLLY_FUSE
```

Declare `BROLLY_FUSE` in `secrets.required`, call `brollyWorker(env)` before
Worker work begins, and add exactly one line immediately after `super()` in
every protected Durable Object constructor:

```ts
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env)
  brollyDurableObject(ctx, env)
}
```

Before a Worker invokes a Durable Object, call
`brollyWorker(env, { durableObjectId: id.toString() })` so a quarantined object
is rejected without being awakened. See the complete copy-paste Worker and DO
example in [runtime integration](docs/runtime-integration.md).

After installation, open **Configuration** and refresh each protected Worker.
Brolly passively checks Cloudflare API access, the `BROLLY_FUSE` secret, the
active deployment, and the deployed bundle's runtime marker. Namespace rows
inherit only their actual owning Worker's result, so installing Brolly on one
Worker never makes unrelated Workers or namespaces appear protected.

## Defaults

- Poll: every minute
- Daily summary: 09:00 in the configured timezone
- Durable Objects projected gross-spend warning: $5/day
- Critical: $12.50/day
- Emergency: $25/day
- Local Durable Object alarm invocation: 1,000,000 rows read / 10,000 rows written
- External Durable Object window: 5,000,000 reads / 25,000 writes per 5 minutes; 100,000,000 reads / 500,000 writes per day

The dashboard's daily-spend chart is a gross rolling-24-hour estimate from fast
telemetry. It does not apply included usage, discounts, credits, or invoice
adjustments. Authoritative billing reconciliation is labeled separately and
requires the optional Billing Read token.

Per-object analytics are available for compute and storage operations. Cloudflare
exposes SQLite retained bytes at namespace scope and legacy key-value retained
bytes at account scope, so Brolly monitors those costs at those scopes and says
so explicitly rather than presenting invented object-level precision. Rates and
meter definitions follow [Cloudflare's Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Worker script budgets use per-script invocation requests and CPU milliseconds
from GraphQL at the published Standard-model marginal rates. Cache-side billed
requests remain an explicit coverage gap until they can be separated from cache
miss invocations without double-counting. Rates follow [Cloudflare's Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Dashboard workflow

The dashboard is organized as five sidebar pages: **Overview** (`/`),
**Assets** (`/assets`), **Incidents & controls** (`/incidents`),
**Configuration** (`/configuration`), and **Settings** (`/settings`).

- The Overview answers the operational questions first: estimated spend today
  with a short-horizon trend, open incidents, coverage gaps, runtime-protection
  readiness, a needs-attention queue, and the five most recent control actions.
  Every tile links to its detail page. Open emergency incidents raise a
  dashboard-wide banner.
- `Open incidents` counts actual usage/spend incidents only. Telemetry failures
  live under `Coverage gaps` on the Configuration page and do not inflate the
  response queue.
- Every incident opens a response drawer with a human-readable measurement,
  time window, threshold, Cloudflare link, asset classification, acknowledge,
  prepare, execute, and rollback controls as applicable.
- The Assets page browses the discovered inventory with family, tier, and text
  filters. An asset drawer shows its budget, telemetry recency, and open
  incidents, and edits the protection tier and owning-Worker fuse declaration.
- Budget settings can be reopened from the `Budgets` button in the top bar.
  Changing them updates the same policy used by the minute monitor.
- Notification destinations, budget summaries, the runtime install guide, and
  the shutdown-control reference live on the `/settings` page.
- Every control-action row on Incidents & controls opens a detail drawer.
  Operators can inspect the audit state, execute a prepared action, or
  restore/un-jail an active control from its saved rollback state after an
  explicit confirmation.
- A placeholder local install is labeled `Local preview` across the dashboard.
  Sample/stale spend is never presented as live, scan failures are translated
  into operator-facing connection guidance, and features that require a live
  Cloudflare account are listed explicitly with recovery steps.

## Notifications

The dashboard's **Incident notifications** section configures Discord incoming
webhooks, Slack incoming webhooks, and Twilio SMS. Target secrets are encrypted
with `BROLLY_CREDENTIAL_KEY` before they enter D1 and are never returned to the
browser. Operators can pause a destination or change its minimum severity
without re-entering the secret. Replacing credentials requires the complete new
webhook or Twilio credential set.

Immediate notifications are deduplicated and limited to 20 attempts per target
per hour. Twilio has an additional five-SMS-per-day safety cap. Saving a target
does not send a test message; a delivery is only attempted for a qualifying
incident.

Official Cloudflare product glyphs in the dashboard are local SVG assets sourced
from Cloudflare's `cloudflare-docs/src/icons` product icon set. They do not load
third-party assets at runtime.

## Emergency workflow

```bash
brolly incidents
brolly classify durable_objects NAMESPACE_ID standard --worker-script=my-worker
brolly prepare INCIDENT_ID
brolly stop INCIDENT_ID
brolly resume ACTION_ID
```

Queue incidents infer `pause_consumer`; Worker incidents infer
`disable_trigger` unless that Worker is marked as fuse-integrated. Both broader
controls save live rollback state before making the first Cloudflare change.
Fuse-integrated Workers and exact objects can be quarantined automatically at
an emergency threshold; recovery remains manual. Use `brolly mode automatic`
only after classifying and testing every runtime-integrated asset. Add notification targets from a local
JSON file with `brolly target KIND FILE` so credentials do not need to be typed
as command-line arguments.

See [architecture](docs/architecture.md), [operations](docs/operations.md),
[runtime integration](docs/runtime-integration.md), and
[Cloudflare icon sources](docs/icon-sources.md). Notification logo provenance
is documented separately in [notification brand icons](docs/notification-brand-icons.md).
