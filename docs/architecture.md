# Architecture

Brolly runs inside the protected Cloudflare account so it remains available during an incident. A scheduled Worker acquires a short D1 lease, refreshes inventory, polls bounded telemetry adapters, persists compact samples, evaluates policy, and fans out deduplicated incidents. The dashboard and CLI use the same audited action API.

The control plane consists of `brolly-guard`, its D1 database, OAuth credentials, and at least one notification channel. Those assets are always allowlisted. Browser sessions use a hashed, 12-hour, HttpOnly cookie; OAuth grants and notifier credentials are AES-GCM encrypted before entering D1. A local CLI bearer token remains an optional break-glass path if the dashboard is unavailable.

The remote deployment owns the AES-GCM key lifecycle. It deploys the Worker
without replacing existing secrets, lists secret names, and generates
`BROLLY_CREDENTIAL_KEY` only after Cloudflare successfully confirms the name is
absent. The 256-bit value travels to `wrangler secret put` over stdin and is
never printed or committed. Listing and parse failures stop the deployment;
they never trigger key creation. Subsequent deployments preserve the original
key because silently rotating it would make stored OAuth and notifier
credentials unreadable.

The `apps/guard-worker` project is a full-stack Cloudflare Vite application.
Vite 8 builds a React client and the Worker in separate environments;
`@cloudflare/vite-plugin` emits one deployable Worker configuration with SPA
assets. Tailwind CSS 4 compiles the complete dashboard stylesheet, including
the standalone OAuth error surface. Semantic theme tokens follow the browser's
`prefers-color-scheme` setting across login, onboarding, and authenticated
pages. `/api/*` and `/health` run Worker-first while
navigation requests use the static SPA fallback. The npm installer packages
both the Worker bundle and the client asset directory.

Release discovery is active-page-driven rather than cron-driven. The client
calls an authenticated local endpoint on load and at most hourly while open.
That endpoint fetches one fixed, size-limited manifest from Brolly's public
`deploy-template` branch, validates its schema, release SHA, and trusted notes
URL, and caches it in D1 for one hour. A D1 lease deduplicates simultaneous
tabs. No GitHub credential enters Brolly: D1 stores only the optional
`owner/repository` slug used to construct the GitHub Actions link.

Updates are a separate repository-local control plane. The shipped manual
workflow receives a short-lived `GITHUB_TOKEN` from the installation's own
GitHub repository, copies only an explicit allowlist of release artifacts, and
opens a pull request. The running, already-installed workflow performs static
syntax and manifest checks; it does not execute scripts downloaded from the
candidate release while its write token is present. It cannot merge
automatically. Installation-owned
`wrangler.jsonc`, D1 identity, variables, and secrets are outside that copy
allowlist. This gives public and private installations the same review gate
without a publisher-owned GitHub App or long-lived token.
The workflow file itself is outside the routine update allowlist because GitHub
does not permit a workflow token to modify workflow files. It is provisioned at
installation time and changed only through an explicit owner-authorized
infrastructure migration.

Browser login uses Brolly's publisher-owned public OAuth client and one fixed
redirect URI at `brolly-login.standardagents.ai`. The private, separately
deployed `brolly-login` Worker contains the stateless relay; relay code and
infrastructure are not shipped in this open-source repository or customer
deployments. Each login state carries the requesting installation's public
HTTPS origin. The relay first asks that origin to prove the state exists in its
own D1 database, then returns the one-time code only to that origin's
`/api/auth/callback`. PKCE, an HttpOnly state cookie, a ten-minute expiry, and
exact origin matching prevent another installation from claiming the code. The
relay never exchanges the code and therefore never receives Cloudflare access
or refresh tokens.

The publisher OAuth client enables both authorization-code and refresh-token
grants. Brolly explicitly requests `offline_access` and refuses to persist an
OAuth exchange that does not include a refresh token. Each installation stores
the access token, refresh token, and expiry together in its own D1 using
AES-GCM. `operationalToken()` refreshes the grant five minutes before expiry
under a D1 lease so overlapping monitor and control requests cannot race token
rotation. Installations authorized before refresh-token support was enabled
must reconnect once to replace their original short-lived grant.

An unbound deployment accepts exactly one account in its first successful
browser authorization and persists that account ID in D1. This binds the
Cloudflare account, not the person: later sign-ins are accepted only when their
OAuth grant resolves to that same single account, and every other account is
rejected. Any account member able to authorize Brolly's requested scopes may
therefore operate the instance. The newest successful authorization replaces
the encrypted operational OAuth grant used for monitoring and controls. There
is no dashboard account-switch action; changing the protected account requires
an intentional D1 reset or a replacement deployment. The CLI installer avoids
the first-browser claim window by persisting the selected account before it
deploys the guard Worker.

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
family without a fast usage source is persisted as unavailable and opens a
coverage incident.

For charting, the minute pass writes one account-level projected-spend sample,
and the 15-minute pass writes one rolling-24-hour cost sample per active usage
family. This avoids reconstructing charts by repeatedly scanning
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
does not bypass setup, and the browser never receives or stores the break-glass
admin token. Existing policies without `familyDailySpend` are migrated in the wizard
by merging conservative defaults before saving.

The optional first-run usage check is a separate, read-only path. A 20-second
`RunBudget` caps it at four API calls and 20,000 returned samples, while the
implementation normally uses exactly the aggregate Durable Objects and Workers
Analytics requests and optionally a Billing Read request. A D1 lease prevents
overlap and a 15-minute D1 cache prevents repeated button clicks from repeating
the Cloudflare queries. Suggested warning, critical, and emergency budgets add
25%, 75%, and 150% headroom to measurable prior-24-hour cost. Missing or
zero-cost families keep their existing draft values, and partial account data
never overwrites the account-wide draft budget.

Access verification and draft mutation are separate client actions. The first
screen initially presents a single bounded check, then progressively reveals a
compact result list and only the relevant remediation. Reauthorizing
OAuth invalidates the 15-minute access cache. A Billing Read token submitted in
setup is tested against the bound account before its AES-GCM envelope is stored
under `billing_credentials` in D1; it is never returned to the client. A Worker
secret with the same purpose takes precedence. Only the explicit historical
usage action on the following account-budget screen copies suggestions into
the editable policy draft.

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
| `critical` | Alert only; reclassify only after blast-radius review |
| `standard` | Alert, prepare action, optional auto-stop at emergency threshold |
| `disposable` | Alert, optional reversible auto-stop |
| `unclassified` | Treat as critical until classified |

An action record is written before any actuator runs. Execution rechecks that
the incident is an emergency seen within the last 30 minutes, is not resolved,
and that the target has not become protected since preparation. Actions use
compare-and-set state transitions so double-clicks and retries cannot execute
the same stop twice. Controls deploy a fuse or pause queue delivery; they do not
delete resources, routes, domains, or storage.

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

Automatic execution requires two consecutive emergency observations from a
raw usage meter. Billing reconciliation and projected-dollar estimates can
alert and prepare evidence, but cannot authorize an automatic mutation. The
actuator coalesces up to 15 exact-object changes into one Worker deployment and
has three independent circuit breakers: five Workers per monitor pass, one
automatic deployment per Worker per five minutes, and twelve automatic
deployments per account per hour. A current successful configuration check
(less than 24 hours old) is mandatory.

## Configuration evidence

Runtime readiness is modeled per Worker and per Durable Object namespace, not
as one account boolean. Cloudflare's namespace inventory supplies the owning
script, class, and storage backend. Inventory metadata is merged into existing
asset metadata so authoritative Cloudflare fields can refresh without erasing
operator tiers or fuse declarations.

`GET /api/configuration` joins scoped assets with cached verification records
stored under `configuration_verification:<worker-script>` settings keys.
`POST /api/configuration/verify` accepts up to five inventoried Worker names and
performs bounded, read-only Cloudflare checks for secret presence, deployment
identity, and the runtime marker in at most the first 1 MB of deployed content. Namespace readiness then
inherits only the status of its resolved owning Worker. These checks are kept
outside the automatic monitor because bundle downloads are useful after a
deployment or operator request, not every minute.
