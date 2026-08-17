# Operations

The minute cron claims bounded work. Active telemetry is due every five
minutes. Inventory, Billing Read reconciliation, and retention maintenance run
hourly. Capability discovery runs daily. Hot watch may claim a one-minute pass
while a current alert is open and Cloudflare's completed ingestion watermark
has advanced. Newest-first backfill consumes only budget left after active
protection work.

The first-run **Alert channels** step starts a one-shot 90-day ingestion job in
the background and shows its progress while the operator connects channels.
Usage collectors create daily slices within each dataset's available retention,
up to 90 days. Billing Read creates three contiguous slices of no more than 31
days. The job uses a separate budget of 40 GraphQL queries, five REST requests,
and 25 seconds. Setup can continue while the cron scheduler finishes eligible
slices. The progress view reports stored slice counts and dates.

One run has default limits of 300 GraphQL dataset queries, 50 REST requests,
100,000 D1 rows read, 50,000 D1 rows written, 30 dataset pages, four backfill
slices, and 45 seconds. Configurable values remain under hard maxima. Budget
exhaustion closes the monitor run as partial, preserves every continuation
cursor, and keeps incomplete telemetry out of automatic enforcement. The
Monitoring page edits these ceilings and displays each product maximum.

Durable Object and Worker datasets use stable identifier ordering and keyset
pages of up to 10,000 rows. The collectors query all supported billable sums in
bounded dataset requests. They do not wake each Durable Object or read customer
application storage. A 55-second lease prevents explicit dashboard refreshes
from overlapping the scheduled pass.

The optional first-run usage check is narrower than a monitor pass. It makes
one rolling-24-hour Durable Objects Analytics request and one rolling-24-hour
Workers Analytics request. If a separate Billing Read token exists, it may add
one billing request and use its latest available daily record for other product
families. The result is cached in
the installation's D1 database for 15 minutes, concurrent checks are refused,
and no incidents, notifications, controls, or policy changes are created. The
browser applies returned suggestions only to its editable draft; setup must be
finished before any suggested limit is saved.

Initial and manual historical ingestion update ledger coverage and daily
history without evaluating alert rules. A failed slice retries after 30
seconds, two minutes, and eight minutes. Exhausted retries record missing
coverage and allow the remaining job to complete. Cloudflare rate-limit
responses honor one `Retry-After` delay before slice retry handling resumes.

One fixed completed window and one fixed preceding correction window update
correction-safe local-day and billing-cycle accumulators. Persisted continuations
retain their interval bounds across restarts. Each resource metric retains a bounded 12-scan
baseline. Completed days seal into compact history. The 730-day target applies
to account, product, namespace, and individual-resource rows under D1 capacity
safeguards.

The dashboard separates evidence clearly:

- complete usage comes from a fully collected unsampled window;
- partial, sampled, stale, and missing values retain those labels;
- modeled resource cost is an estimate;
- proportional billing allocation is labeled allocated;
- reconciled account and product charges are authoritative aggregates.

The **Monitoring cost** page reports query and D1 budgets, Worker usage,
storage pressure, estimated monthly operating cost, collector deferrals, and
recent monitor runs. **Backfill & retention** reports slice coverage, retries,
oldest retained dates, and capacity policy.

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
The setup header always includes **Sign out**. Signing out ends only the current
browser session; it does not mark onboarding complete, clear saved settings, or
unbind the installation's Cloudflare account. The operator can authenticate
again and continue setup.
It starts with one bounded read-only check and does not apply suggested limits.
Results are shown before any credential form.
OAuth reconnection is revealed only for an Analytics permission problem.
When Billing Read is unavailable, both **Grant billing access** actions open the
same token setup dialog.
Each result says what Brolly can monitor, what remains missing, and the next
action. A partial Worker result is not presented as a permission failure when
Cloudflare simply does not expose a per-Worker billing breakdown; the screen
marks the row **Setup needed** until the operator adds Billing Read for exact
account totals. Once connected, Worker requests and CPU time combine with
account billing to cover every signal Cloudflare exposes. Cache charges remain
protected by account and product limits because Cloudflare does not attribute
them to individual Workers. Reconnecting OAuth is shown only for an actual
authorization failure, never for a platform-level telemetry limitation.
Connected rows explicitly require no action.
Operators may continue onboarding without Billing Read. The access-step footer
keeps the recommendation on the left and presents **Continue without billing**
before the primary **Grant billing access** action. Once Billing Read is
verified, the normal **Continue to import** action is restored.
The same account-scoped token generator, paste-and-verify form, connection
status, and replacement workflow remain available under **Settings → Daily
billing access** after onboarding. Skipping the first-run prompt therefore
does not make Billing Read inaccessible later.
The Billing Read handoff uses Cloudflare's documented user API-token template
URL. Brolly opens the user token creation form with the already-bound account,
token name, and Account → Billing → Read permission prefilled. The operator
reviews the form, creates the token, then pastes the one-time secret back into
Brolly for verification. Cloudflare's restricted billable-usage API rejects
account-owned (`cfat_`) tokens even when they carry Billing Read, so Brolly
rejects that token type with corrective instructions before making an API
request. Because Billing Read is a separate user API-token permission rather
than a Brolly OAuth scope, the same screen verifies the token against Cloudflare and only then stores it
AES-GCM-encrypted in the installation's D1; plaintext exists only for the
request and Cloudflare API call. `CLOUDFLARE_BILLING_TOKEN`, when supplied as a
Worker secret, remains the higher-precedence operator-managed alternative.
Billing reconciliation first requests Cloudflare's restricted v2
`/billable/usage` endpoint with explicit date bounds. A 403 or 404 falls back
to the Billing Read-compatible PayGo `/billable-usage` endpoint. The response
supplies authoritative aggregate charges and actual billing-cycle boundaries.
Enterprise accounts continue with bounded Analytics estimates and explicit
billing coverage state when an invoice-aligned result is unavailable.
The account-budget screen can apply the cached historical suggestions after
the history import step.
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

Automatic actions require global automatic mode and explicit opt-in on an applicable alert rule. Exact
Worker and Durable Object targets need complete, fresh, unsampled usage,
`standard` or `disposable` classification, inherited permission, a verified
`@standardagents/brolly-runtime` fuse, and a sustained confirmation window.
Aggregate contributor rules prioritize a child that crossed its own Emergency
line. They require the same deterministic candidate in two consecutive scans,
at least half of current interval usage or aggregate excess, and at least four
times the candidate's rolling baseline. Modeled cost,
allocated cost, billing totals, sampled data, partial data, missing data, and
stale data can support operator review and cannot authorize an automatic mutation.

Brolly coalesces at most 15 exact-object changes per Worker. Automation allows
one deployment-changing action per Worker in 15 minutes and three automatic
quarantines per account hour. Queue controls require explicit operator action.
`control_plane`, `critical`, and `unclassified` assets remain ineligible.

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

Notification targets are capped at 20 deliveries per hour. Twilio targets also
have a five-message daily cap. Warning lines default to one delivery for each
period instance. Emergency lines default to immediate delivery followed by
six-hour repeats while the instance stays open and unsilenced. Provider
credentials are AES-GCM encrypted with a Worker-secret key.

Discord, Slack, Resend, Postmark, Twilio SMS, and generic HTTPS webhooks are
configured on **Notifications**. The read API returns target status, minimum
severity, label, and last-delivery metadata. It never decrypts a destination
credential. Operators can configure several targets of one kind and identify
each target with a label. Generic webhooks refuse redirects and local or
private-network addresses. **Replace credentials** rotates a destination.
Removing a target deletes its encrypted configuration.

Control actions on the **Actions & quarantine** page (the overview shows the
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
