# Architecture

Brolly runs inside the protected Cloudflare account so it remains available during an incident. A scheduled Worker acquires a short D1 lease, claims bounded collector jobs, updates a persistent usage ledger, evaluates affected alert rules, and fans out period-specific notifications. The dashboard and CLI use the same audited action API.

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

Brolly's D1 ledger is the operational read model. One account root owns product
nodes, service scopes, and stable individual resources. Versioned metric
definitions normalize detailed usage, modeled cost, authoritative billed cost,
and newly encountered billing lines. Collector capability rows describe
availability, sampling, retention, finest scope, and ingestion watermark.
Dashboard routes query this stored state. Direct Cloudflare usage queries stay
inside scheduled collectors, setup checks, configuration verification, and
explicit refresh jobs.

The one-minute cron is a scheduler. Active Worker and Durable Object telemetry
is due every five minutes. Product-wide historical collectors cover every
registered Cloudflare usage dataset during the initial import. Hot watch can run each minute while a current alert
instance is open and the aligned Cloudflare watermark has advanced. Inventory,
billing reconciliation, and retention maintenance are hourly. Analytics
capability discovery is daily. Historical backfill runs newest-first from
budget left after active safeguards. First-run initial ingestion has a separate
bounded request budget and leaves unfinished slices for the cron scheduler.

Active telemetry uses one fixed completed five-minute window and a fixed pass
over the preceding window for correction. Continuations retain those original
interval bounds across restarts. Durable
Object billable datasets are grouped by namespace and object identifier.
Workers are grouped by script name. Both collectors use stable identifier
ordering, 10,000-row keyset pages, independent continuation cursors, and
explicit partial coverage. A collection pass never wakes a Durable Object or
reads customer application storage.

Current local-day and billing-cycle totals live in deterministic 8-bit
accumulator shards. Rows approaching 1.5 MB split into deterministic secondary
segments. Each metric keeps bounded correction state and a 12-scan
rolling baseline. Repeated windows are idempotent; delayed corrections replace
the previous contribution through a delta. Completed days seal into compact
usage_daily rows, with account, product, namespace, and individual history
retained for up to 730 days under D1 capacity safeguards.

Billing Read reconciliation runs hourly. Cloudflare billing data defines
authoritative aggregate charges and actual cycle boundaries. Requests align to
the current account billing-cycle start when the resulting range remains within
Cloudflare's 31-day request limit. Detailed resource
cost remains modeled; a product/day charge is proportionally allocated only
where granular usage provides a defensible weighting. Unmapped billing products
remain visible through account/product catchalls and explicit coverage gaps.

Setup offers a one-shot import of Cloudflare's available 90-day history. Usage
collectors create daily slices within each dataset's discovered or registered
retention. Billing Read uses contiguous slices of at most 31 days. Registered
usage families include Workers, Durable Objects, Workers AI, Queues, D1, R2,
Workers KV, Pages Functions, Images, Stream, Vectorize, Hyperdrive, AI Gateway,
Containers, Browser Rendering, Workflows, Worker Builds, Analytics Engine, Log
Explorer, zones, and Email. This ingestion path writes normalized ledger data
without entering alert, notification, or control evaluation. Daily collection
extends the stored history after setup, subject to the 730-day D1 retention
ceiling.

The implementation details, API surface, cost labels, and retention policy are
maintained in [usage-ledger.md](usage-ledger.md).

## Onboarding and alert configuration

First-run completion is stored in D1 as `onboarding_complete`. A new browser
does not bypass setup, and the browser never receives or stores the break-glass
admin token. The wizard connects Cloudflare, adds alert channels, configures the
alert level board, records risk tolerance, collects daily limits, collects
billing-cycle limits, and presents the runtime-fuse handoff.

The Alert channels step starts the bounded history import. Two progress rows
remain in the wizard sidebar while the import runs. The import writes ledger
history and coverage state without creating alert instances, notifications, or
control actions. Risk tolerance and both limit steps remain editable while the
import continues.

Each installation has one ordered alert-level board. Warning, Critical, and
Emergency are seeded as empty levels. A level has a case-insensitive unique
label, a position, and ordered entries. Custom levels use the same data model as
the seeded levels. The board permits up to eight levels and keeps one level when
an operator removes a column. A level's position supplies its priority as
`position * 10`; the rightmost position supplies the highest display severity.

`LimitsChart` is the reusable threshold input for daily and billing-cycle cost
or usage limits. It renders UTC daily ledger history, billing-cycle cumulative
values, and a projection for the current cycle. A symlog axis preserves the
ordinary range when one day exceeds ten times the nonzero median. Threshold
lines retain board order and a five-percent visual gap. A drag computes every
preview from the values at pointer-down, so reversing the drag restores pushed
neighbors before release. Typed and keyboard changes commit one step at a time.
Each chart keeps up to 50 in-memory snapshots for its Undo and Redo controls and
the standard `Cmd/Ctrl+Z` shortcuts. Usage dimensions keep separate histories.
A level diamond in a dimension row switches that level for the dimension. The
diamond stays available while its level is off. Read-only charts omit all
editing and history controls.

Risk tolerance is one ordered percentage map shared by account cost, product
and resource cost, and every billable usage dimension. Conservative spans 120%
through 300%, Balanced spans 150% through 800%, and Growth spans 250% through
3,000%. Each preset follows a geometric curve across the current alert-level
board. The control uses a logarithmic percentage axis and the same ordering,
minimum-gap, pointer, field, and keyboard behavior as a limits chart.

Daily defaults use the median of nonzero days in the 90-day ledger window.
Billing-cycle defaults use the median of at least two fully covered completed
cycles. When fewer cycles exist, the cycle baseline is the daily median times
the current cycle length. A p95 value appears only as the busiest-normal-day
readout. A single spike therefore does not change the multiplier baseline.

Tolerance seeds missing chart values once. Saved chart values remain detached
from later tolerance edits. Reset to tolerance reapplies the current
percentages to one chart and records one undo step. A cycle default also keeps
the matching daily value times the cycle length as its lower bound. Operators
may edit a cycle value below its daily counterpart. The chart then shows a
non-blocking single-day warning.

A channel entry names one configured recipient group and an interval. Cloudflare
Email, Resend, and Postmark groups may contain multiple recipients. Multiple
channels can use the same provider account while remaining distinct groups.
Twilio channels use one destination number. Action entries select Prepare or
Auto behavior for the stop/pause and quarantine families.
Entries accumulate from left to right. A channel entry in a later level can
replace the interval for the same target. Empty levels remain valid. Deleting a
channel cascades its entries. Deleting a level cascades its entries and retires
its materialized alert lines so existing history retains its references.

Channel credentials use encrypted provider records. Twilio, Cloudflare Email,
Resend, and Postmark each have one reusable account record. A channel stores a
sealed full configuration containing its provider values and destination group.
A provider update reseals every channel attached to that provider. Discord,
Slack, and generic webhooks store one URL per channel. Labels remain required
and unique without regard to letter case.

Cloudflare Email uses the REST Email Sending API with a dedicated token. Brolly
verifies token activity through `GET /user/tokens/verify`, lists the connected
account's zones for the from-address form, and sends through the account-scoped
Email Sending endpoint. The token verification call does not send mail. Domain
onboarding and Email Sending permission setup remain Cloudflare dashboard work.

## Policy model

Each policy spend scope stores a map keyed by alert-level ID:

- `accountDailySpend` for the protected account;
- `familyDailySpend` for every cataloged billable product family;
- `assetDailySpend` for every discovered Worker script and Durable Object
  namespace, keyed by family, scope, and resource ID;
- metric/window thresholds for individual assets, including Durable Object
  local-day or billing-cycle usage and cost across every billable
  fast-telemetry meter;
- `riskTolerance` for the shared preset, per-level percentages, and baseline
  audit window;
- `limits.day` and `limits.cycle` for per-scope cost, usage, dimension switches,
  and level switches.

Existing policies may omit `riskTolerance` and `limits`. The client applies the
Balanced curve and derives daily cost maps from the maintained legacy spend
fields. First-run setup saves the complete onboarding record. Budget settings
uses the policy PUT endpoint. Policy migration materializes daily and
billing-cycle cost and usage maps into alert rules with their chart and level
switches.

Policy materialization reads the ordered level board and writes one alert line
for each level value that exists in the selected scope. The alert line retains
its level ID, receives priority `position * 10`, and uses the level label. A
missing map value produces no line. This allows a custom level to carry its own
threshold while a scope remains intentionally unconfigured at another level.

Each rule selects a target, metric, measurement, and period. Alert instances
remain unique to one line, target, and period. The effective entry union for a
firing line drives channel delivery and action creation. Acknowledge marks the
instance seen, records the operator, and clears its next notification time.
Resolution and expiry also clear future notification work.

The bounded access check is a separate, read-only path. A 20-second
`RunBudget` caps it at four API calls and 20,000 returned samples, while the
implementation normally uses exactly the aggregate Durable Objects and Workers
Analytics requests and optionally a Billing Read request. A D1 lease prevents
overlap and a 15-minute D1 cache prevents repeated button clicks from repeating
the Cloudflare queries. The risk-tolerance step reads the stored daily series
after this import. It performs no Cloudflare requests.

Access verification and policy mutation are separate client actions. The first
screen initially presents a single bounded check, then progressively reveals a
compact result list and only the relevant remediation. Reauthorizing
OAuth invalidates the 15-minute access cache. A Billing Read token submitted in
setup is tested against the bound account before its AES-GCM envelope is stored
under `billing_credentials` in D1; it is never returned to the client. A Worker
secret with the same purpose takes precedence.

Scoped budgets take precedence over family defaults. Per-object Durable Object
cost also inherits its namespace budget when no exact-object budget exists.
Namespace spend is the sum of all returned object operations plus namespace-level
SQLite retained storage. Worker spend is projected from per-script billed
invocations and CPU milliseconds; cache-side request attribution remains a
visible coverage gap rather than being double-counted.

## Policy tiers and action safety

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

An Auto entry can execute only after complete, fresh, unsampled usage, an
eligible inherited resource policy, current fuse verification, and a sustained
breach through the confirmation window. Exact targets must stay breached
through that window. Aggregate rules prioritize a child that crossed its own
highest level, then require the same deterministic contributor in two
consecutive scans, at least half of interval usage or aggregate excess, and a
latest rate at least four times its rolling baseline. Billing and modeled cost
can alert and prepare an operator-reviewed action. They cannot authorize an
automatic mutation.

Prepare entries create audited actions in `prepared` state. An operator can
approve an eligible action from the action surface. Auto entries run the same
actuator path after validation. Worker-ingress stop, Durable Object quarantine,
and queue pause are the supported families. Control-plane assets, refused
tiers, denied resource policies, stale evidence, partial evidence, sampled
evidence, and missing evidence remain ineligible. Every action records its
rollback state before Cloudflare changes begin.

The actuator coalesces up to 15 exact-object changes into one Worker
deployment. Deployment-changing automation allows one action per Worker in 15
minutes and three account-wide automatic quarantines per hour. Audit and
rollback state are written before execution.

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
