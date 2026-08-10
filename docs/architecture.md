# Architecture

Brolly runs inside the protected Cloudflare account so it remains available during an incident. A scheduled Worker acquires a short D1 lease, refreshes inventory, polls bounded telemetry adapters, persists compact samples, evaluates policy, and fans out deduplicated incidents. The dashboard and CLI use the same audited action API.

The control plane consists of `brolly-guard`, its D1 database, OAuth credentials, and at least one notification channel. Those assets are always allowlisted. A local CLI with a recovery secret remains the break-glass path if the dashboard is unavailable.

The `apps/guard-worker` project is a full-stack Cloudflare Vite application.
Vite 8 builds a React client and the Worker in separate environments;
`@cloudflare/vite-plugin` emits one deployable Worker configuration with SPA
assets. `/api/*` and `/health` run Worker-first while navigation requests use
the static SPA fallback. The npm installer packages both the Worker bundle and
the client asset directory.

Fast telemetry is operational evidence, not invoice truth. The Durable Object
collector covers the complete current pricing surface: per-object requests,
compute GB-seconds, incoming WebSocket messages, SQLite rows read/written, and
legacy key-value read/write units and deletes. Each operation is queried as an
independent bounded top-1,000 list so one kind of high consumer cannot hide
behind another metric's ordering. Retained SQLite bytes are collected at
namespace scope and retained legacy key-value bytes at account scope, matching
the finest dimensions Cloudflare exposes. Invocation types are separated so
hibernated WebSocket messages and periodic non-hibernated WebSocket messages
both receive Cloudflare's 20:1 billing conversion exactly once. Five-minute telemetry runs every
minute; a direct 24-hour query runs every 15 minutes. Brolly separately imports Cloudflare billing usage when
a Billing Read token is configured. Billing usage can be delayed and is
reconciled rather than used for sub-minute shutdown decisions. Every cataloged
family without a fast collector is persisted as unavailable and opens a
coverage incident.

For charting, the minute pass writes one account-level projected-spend sample,
and the 15-minute pass writes one rolling-24-hour cost sample per active
collector family. This avoids reconstructing charts by repeatedly scanning
per-object samples. The dashboard reads bounded aggregates, at most 2,500 spend
points and 250 incidents per request.

## Policy model

`Policy` contains ordered warning, critical, and emergency limits at three
levels:

- `accountDailySpend` for the protected account;
- `familyDailySpend` for every cataloged billable product family;
- `assetDailySpend` for every discovered Worker script and Durable Object
  namespace, keyed by family, scope, and resource ID;
- metric/window thresholds for individual assets, including Durable Object
  five-minute rows, 24-hour rows, and projected daily cost across every
  billable fast-telemetry meter.

First-run completion is stored in D1 as `onboarding_complete`. A new browser
does not bypass setup, and local storage contains only the dashboard admin
token. Existing policies without `familyDailySpend` are migrated in the wizard
by merging conservative defaults before saving.

Scoped budgets take precedence over family defaults. Per-object Durable Object
cost also inherits its namespace budget when no exact-object budget exists.
Namespace spend is the sum of all returned object operations plus namespace-level
SQLite retained storage. Worker spend is projected from per-script billed
invocations and CPU milliseconds; cache-side request attribution remains a
visible coverage gap rather than being double-counted.

## Policy tiers

| Tier | Default response |
| --- | --- |
| `control_plane` | Alert only; never auto-stop |
| `critical` | Alert and require explicit approval |
| `standard` | Alert, prepare action, optional auto-stop at emergency threshold |
| `disposable` | Alert, optional reversible auto-stop |
| `unclassified` | Treat as critical until classified |

An action record is written before any actuator runs. For Cloudflare controls,
the live rollback snapshot is fetched, durably written to D1, and audited before
the first mutation. Every action carries its observed values, policy version,
rollback plan, actor, and idempotency key. Controls remove ingress or pause work;
they do not delete resources or storage.

## Deployment fuse

`@standardagents/brolly-runtime` is the preferred precise actuator. Brolly keeps
one canonical fuse manifest per integrated Worker in D1 and publishes it as the
Worker's `BROLLY_FUSE` secret. A publish creates a new Worker version. The
runtime checks that environment binding synchronously; it never performs a
network or storage lookup while enforcing the fuse.

The manifest contains a generation, an optional whole-Worker quarantine, and a
bounded map of exact 64-character Durable Object IDs. It is rejected before it
reaches Cloudflare if it would exceed the 5 KB binding limit. Applying or
resuming one target preserves all other active targets in that Worker. Resume
is explicit by default because stopped telemetry cannot prove that the
underlying runaway behavior has been repaired.

Cloudflare's deployment unit remains the Worker script. Exact matching means
only the selected object is denied after rollout, but unrelated active objects
in that script may restart as the version changes. Brolly exposes that
collateral lifecycle risk in confirmation UI and audit records.

## Configuration evidence

Runtime readiness is modeled per Worker and per Durable Object namespace, not
as one account boolean. Cloudflare's namespace inventory supplies the owning
script, class, and storage backend. Inventory metadata is merged into existing
asset metadata so authoritative Cloudflare fields can refresh without erasing
operator tiers or fuse declarations.

`GET /api/configuration` joins scoped assets with cached verification records
stored under `configuration_verification:<worker-script>` settings keys.
`POST /api/configuration/verify` accepts up to 20 inventoried Worker names and
performs bounded, read-only Cloudflare checks for secret presence, deployment
identity, and the runtime marker in deployed content. Namespace readiness then
inherits only the status of its resolved owning Worker. These checks are kept
outside the automatic monitor because bundle downloads are useful after a
deployment or operator request, not every minute.
