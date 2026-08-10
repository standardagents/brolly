# Brolly

`@standardagents/brolly` is a self-hosted Cloudflare cost sentinel. It inventories billable asset families in one account, polls Durable Object telemetry every minute, reconciles Cloudflare's account-wide authoritative billing usage daily, and exposes reversible emergency controls. Durable Object fast telemetry covers every billable meter in Cloudflare's current pricing model: requests, compute GB-seconds, incoming WebSocket messages, SQLite rows read/written, legacy key-value read/write units and deletes, and retained storage. The metric catalog also records every known family whose fast collector is absent, so incomplete protection is visible and alerting rather than silently green.

The design assumes telemetry can fail. Every metric family has a coverage state (`healthy`, `delayed`, `unavailable`, or `permission_denied`), and missing coverage alerts instead of silently reporting zero usage.

The guard includes a React 19 dashboard built with Vite 8 and the Cloudflare
Vite plugin. Static dashboard assets and the API Worker deploy together. The
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
- Durable Object IDs are quarantined through a signed endpoint implemented by the owning runtime. Without that integration, Brolly can only act on the parent Worker or its triggers.

## Install

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

- `Open incidents` counts actual usage/spend incidents only. Telemetry failures
  live under `Coverage gaps` and do not inflate the response queue.
- Every incident opens a response drawer with a human-readable measurement,
  time window, threshold, Cloudflare link, asset classification, acknowledge,
  prepare, execute, and rollback controls as applicable.
- Summary cards, spend categories, product families, and coverage groups link
  directly to their drill-down or operator action.
- Budget settings can be reopened from the header. Changing them updates the
  same policy used by the minute monitor.
- The overview is intentionally operational: spend, incidents, coverage,
  assets, and recent actions. Notification destinations, budget entry points,
  and the shutdown-control reference live on the separate `/settings` page.
- Every recent-action row opens a detail drawer. Operators can inspect the
  audit state, execute a prepared action, or restore/un-jail an active control
  from its saved rollback state after an explicit confirmation.
- A placeholder local install is labeled `Local preview` across the dashboard.
  Sample/stale spend is never presented as live, scan failures are translated
  into operator-facing connection guidance, and features that require a live
  Cloudflare account are listed explicitly.

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
brolly classify durable_objects OBJECT_ID standard --runtime-url=https://instance.example --project-id=PROJECT_ID
brolly prepare INCIDENT_ID https://instance.example
brolly stop INCIDENT_ID https://instance.example
brolly resume ACTION_ID
```

Queue incidents infer `pause_consumer`; Worker incidents infer
`disable_trigger`. Both save live rollback state before making the first
Cloudflare change. Use `brolly mode automatic` only after classifying and
testing every runtime-integrated asset. Add notification targets from a local
JSON file with `brolly target KIND FILE` so credentials do not need to be typed
as command-line arguments.

See [architecture](docs/architecture.md), [operations](docs/operations.md),
[runtime integration](docs/runtime-integration.md), and
[Cloudflare icon sources](docs/icon-sources.md). Notification logo provenance
is documented separately in [notification brand icons](docs/notification-brand-icons.md).
