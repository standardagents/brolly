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

The optional first-run usage check is narrower than a monitor pass. It makes
one rolling-24-hour Durable Objects Analytics request and one rolling-24-hour
Workers Analytics request. If a separate Billing Read token exists, it may add
one billing request and use its latest available daily record for other product
families. The result is cached in
the installation's D1 database for 15 minutes, concurrent checks are refused,
and no incidents, notifications, controls, or policy changes are created. The
browser applies returned suggestions only to its editable draft; setup must be
finished before any suggested limit is saved.

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
- **Coverage gaps** mean Cloudflare did not expose a usage signal, returned it
  late, or denied the installation permission to read it. They do not mean zero usage.
  They are prominent but are not counted as spend incidents.
- **Current daily spend** is a gross rolling-24-hour telemetry estimate by
  product category. It is not an invoice and is labeled as such.

Before Cloudflare OAuth is completed, the dashboard is an unauthenticated local
preview and live protection is inactive. A signed-in installation takes its
account ID from the authorized Cloudflare account stored in D1, not from a
browser field or mutable dashboard setting. Authentication or routing failures
are shown as **Cloudflare connection needs attention** rather than raw provider
JSON. Do not treat either state as active protection.

For a Deploy to Cloudflare installation, the first successful browser sign-in
binds the selected Cloudflare account ID in D1. The binding belongs to the
account, not the person: later operators may sign in only by authorizing that
same account, and any member able to grant the requested scopes is treated as
an administrator. Each successful sign-in refreshes the encrypted OAuth grant
used by the monitor and control plane. There is no routine account switch;
changing accounts requires deliberately resetting the D1 binding and stored
credentials or deploying a new Brolly instance. The CLI installer pre-binds its
selected account before the Worker becomes available.

The canonical Deploy to Cloudflare release is generated in `deploy/`. CI
publishes that directory as the root-only `deploy-template` branch, and the
button targets that branch rather than the multi-application workspace root or
a nested directory. This avoids Cloudflare creating a placeholder repository
with only its rewritten Wrangler file. The installation requires only the
automatically provisioned D1 binding. Its explicit `npm run build` command
validates the precompiled Worker, dashboard, migrations, and upload boundary
without network access; Cloudflare then runs the separate `npm run deploy`
command. After deploying the Worker, Brolly asks Cloudflare for the names—not
the values—of its configured secrets. If `BROLLY_CREDENTIAL_KEY` is absent,
the deploy script generates a 256-bit value and sends it to `wrangler secret
put` over stdin without printing it. If the listing fails or is malformed, the
deployment fails closed and never creates or rotates a key. Later deployments
preserve the existing secret so credentials already encrypted in D1 remain
readable. The public OAuth client ID and shared relay URL are compiled into the
release, while the private relay service is deployed and operated separately;
the account ID is derived during first sign-in, and timezone/summary settings
default to UTC and 09:00. Operators who need break-glass CLI access or
authoritative billing reconciliation can add those Worker secrets later.

## Application updates

Each installation includes `.github/workflows/brolly-update.yml`. In
**Settings → Updates**, the operator saves only the installation repository's
`owner/repository` slug. Brolly does not request or retain GitHub credentials.
Private repositories are supported because the browser and repo-local workflow
authenticate through GitHub itself.

An authenticated dashboard asks its own `/api/releases` endpoint on load and
once per hour while the page remains active. Returning to a visible tab also
checks only when an hour has elapsed. The Worker keeps the upstream manifest in
D1 for one hour and uses a short D1 lease, so concurrent tabs or operators
produce at most one upstream fetch per installation per hour. A failed check is
non-fatal and retains any older release information as stale.

The update banner opens the repository's manual **Update Brolly** workflow.
That workflow downloads the public `deploy-template` branch, validates it,
creates a `brolly/update-*` branch, and opens a pull request. It never merges or
deploys by itself. The allowlisted update copies the prebuilt Worker, static
dashboard, migrations, verifier, updater, package metadata, and workflow. It
deliberately does not replace `wrangler.jsonc`; the provisioned D1 binding,
Worker variables, and secrets remain installation-owned. Review the diff and
Cloudflare preview before merging. If organization policy disables write
access for `GITHUB_TOKEN`, enable read/write workflow permissions for the
repository before running the updater.
If repository policy separately forbids Actions from creating pull requests,
the workflow leaves the verified update branch in place and emits a prefilled
GitHub comparison URL in the run summary. The operator opens that URL to create
the same review PR manually; no direct deployment occurs.
Routine updates exclude `.github/workflows/brolly-update.yml` from their copy
allowlist because GitHub does not let a workflow's own token create or modify
workflow files. New installations receive the canonical workflow from the
Deploy Button template. A future workflow-infrastructure migration must be an
explicit owner-authorized repository change rather than a self-update.

On first authenticated login, verify usage access, then complete all four budget
steps. The access check is required before onboarding can continue. The access
screen is built into Brolly and requires no local agent or additional service.
It starts with one bounded read-only check and does not apply suggested limits.
Results are shown before any credential form.
OAuth reconnection is revealed only for an Analytics permission problem;
Billing token instructions are revealed only when Billing Read is unavailable.
Each result says what Brolly can monitor, what remains missing, and the next
action. A partial Worker result is not presented as a permission failure when
Cloudflare simply does not expose a per-Worker billing breakdown; the screen
directs the operator to add Billing Read for account totals and leave additional
headroom in per-Worker limits. Connected rows explicitly require no action.
The Billing Read handoff is three explicit actions: copy the token settings,
open the already-bound account's Cloudflare API Tokens page, then paste and
verify the token Cloudflare creates. The recipe specifies Account → Billing →
Read for only the connected account, with no zone permissions. Because Billing
Read is an account API-token permission rather than a Brolly OAuth scope, the
same screen verifies the token against Cloudflare and only then stores it
AES-GCM-encrypted in the installation's D1; plaintext exists only for the
request and Cloudflare API call. `CLOUDFLARE_BILLING_TOKEN`, when supplied as a
Worker secret, remains the higher-precedence operator-managed alternative.
The next account-budget screen can apply the cached historical suggestions.
Brolly OAuth access is renewable: the publisher client enables refresh tokens,
the authorization request includes `offline_access`, and each installation
refreshes its encrypted grant five minutes before expiry. An installation that
was authorized before renewable access was enabled must use **Reconnect
Cloudflare** once; subsequent access-token rotation is automatic.
Brolly requires
ordered account limits, a limit for every product family, a limit for every
discovered Worker script and Durable Object namespace, and all supported
per-object Durable Object windows. Product or resource limits marked `Limited
usage data` are retained, but alerts can evaluate only the billing signals
Cloudflare currently exposes to the installation. Reopen the
same wizard with **Budgets** in the dashboard header.

Before enabling automatic controls:

1. Complete OAuth installation and select exactly one account. Confirm that the
   first sign-in binds the intended account before sharing the instance URL.
2. Configure a manual Billing Read token if invoice reconciliation is required.
3. Configure at least two notification paths, ideally one webhook and one SMS/email path.
4. Classify assets and verify the Brolly control-plane allowlist.
5. Run controls in `observe` mode, then `approval`, before enabling `automatic`.
6. Test stop and rollback for each actuator.

The guard has two bounded, reversible actuators. Runtime quarantine publishes
a secret-backed deployment fuse that makes one exact Durable Object or one
instrumented Worker reject application work without a runtime lookup. Queue
pause records the queue's current settings before setting `delivery_paused`.
Legacy route/domain/trigger removal is retired and refused by the API. The
rollback or desired fuse state is committed to D1 and audited before any
Cloudflare mutation starts. Brolly never deletes a Worker, route, domain,
queue, Durable Object, or stored data.

Automatic actions are deliberately narrower: only classified `standard` or
`disposable` Durable Objects and Workers marked with a tested
`@standardagents/brolly-runtime` fuse can be quarantined automatically at an
emergency threshold. The emergency must be observed twice, come from a raw
usage meter, and remain fresh; projected cost and billing totals never trigger
an automatic mutation. Verification must have passed in the last 24 hours.
Brolly limits each monitor pass to five Worker rollouts, coalesces at most 15
object actions per Worker, permits one automatic rollout per Worker per five
minutes, and opens an account circuit breaker after 12 automatic rollouts in an
hour. Queue controls always require an explicit operator action.
`control_plane`, `critical`, and `unclassified` assets cannot be stopped.

Exact-object quarantine is customer-visible downtime for that object. Worker
ingress can return HTTP 503 before waking it, and the constructor throws before
application handlers run. Stored state is preserved and sibling IDs are not
denied, although a Worker-version rollout may restart other live objects in the
same script. Recovery is manual by default so a stopped spike cannot flap back
on automatically. If a runtime has not installed the fuse, there is no
exact-object actuator; disabling its parent Worker has a namespace-wide or
user-wide blast radius and must be reviewed as a different control.

`brolly status`, `brolly incidents`, `brolly stop`, and `brolly resume` call the
guard Worker with the optional break-glass token stored mode `0600` in
`~/.brolly/config.json`; they do not depend on a browser session. Browser login
uses Cloudflare OAuth and never exposes that token.

## Configuration verification

The dashboard's **Configuration** page is the readiness inventory for runtime
controls. Workers and Durable Object namespaces are evaluated independently so
partial rollouts remain visible. Cloudflare namespace inventory supplies the
authoritative owning Worker and class; operator declarations are retained
separately and mismatches are surfaced rather than silently overwritten.

A live refresh is operator-initiated and cached in D1. It uses three
control-plane reads per Worker: secrets, deployments, and deployed script
content. Each API request accepts at most five Workers, processes at most three
Workers concurrently, times out individual Cloudflare calls after ten seconds,
and scans no more than 1 MB of a deployed bundle. **Refresh all** chunks larger
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
can be restored from its rollback snapshot. A failed stop retains its error and
desired state and can be retried explicitly after checking Cloudflare; it cannot
be resumed until one application succeeds. Every execute or restore requires confirmation in the
browser. A prepared stop becomes invalid if its incident resolves, ages past 30
minutes, or the target is reclassified; run a fresh scan and prepare a new
action instead.

## Dashboard development

```bash
pnpm --filter @standardagents/brolly-guard dev
pnpm --filter @standardagents/brolly-guard build
pnpm --filter @standardagents/brolly-guard preview
```

Development and preview both run through the Cloudflare Vite plugin so Worker
bindings and SPA routing match production. The development server is pinned to
port `5173` with `strictPort` enabled.
