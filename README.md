<p align="center">
  <img src="docs/brolly-logo.svg" width="92" alt="Brolly umbrella logo">
</p>

<h1 align="center">Brolly</h1>

<p align="center">
  <strong>Cost guardrails and emergency controls for Cloudflare.</strong><br>
  Catch runaway usage before it becomes an invoice.
</p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/standardagents/brolly/tree/deploy-template"><img src="https://deploy.workers.cloudflare.com/button" height="32" alt="Deploy to Cloudflare"></a>
  &nbsp;
  <a href="https://brolly.standardagents.ai"><img src="https://img.shields.io/badge/Read_the_docs-202124?style=for-the-badge&logo=readthedocs&logoColor=white" height="32" alt="Read the docs"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare_Workers-F6821F?logo=cloudflare&logoColor=white" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/React_19-20232a?logo=react&logoColor=61dafb" alt="React 19">
  <img src="https://img.shields.io/badge/Vite_8-646cff?logo=vite&logoColor=white" alt="Vite 8">
  <img src="https://img.shields.io/badge/Tailwind_CSS_4-06b6d4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS 4">
  <img src="https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/license-MIT-16803a" alt="MIT license">
</p>

---

Brolly watches billable Cloudflare usage, alerts when spend moves out of line,
and gives operators audited, reversible ways to contain it. It is self-hosted
inside your Cloudflare account.

| | |
|---|---|
| **☂ Account-wide coverage** | Workers, Durable Objects, D1, R2, KV, Queues, AI, and other billable assets. |
| **⚡ Fast detection** | Five-minute active telemetry, optional one-minute hot watch, and hourly billing reconciliation. |
| **📚 Persistent ledger** | Correction-safe daily history in D1 for up to 730 days with explicit evidence quality. |
| **🎯 Scoped limits** | Ordered alert levels with per-level limits for daily or Cloudflare billing-cycle periods. |
| **↩ Reversible controls** | Approval-first quarantine, rollback state, and a complete audit trail. |

> [!IMPORTANT]
> Brolly never deletes resources or customer data. Automatic controls are
> opt-in, and missing telemetry retains an explicit coverage-gap state.

## Install

Use **Deploy to Cloudflare** above. The Cloudflare flow provisions Brolly's D1 database and deploys the dashboard
and guard Worker. The form asks only for the provisioned D1 binding. On the
first deploy, Brolly generates a 256-bit `BROLLY_CREDENTIAL_KEY` and sends it
directly to Cloudflare as a Worker secret without printing it. Later deploys
verify that the secret exists and preserve it, so credentials already encrypted
in D1 remain readable.
Account ID, OAuth client, timezone, summary hour, optional billing access, and
the optional break-glass token are not installation questions. On first visit,
**Login with Cloudflare** authorizes exactly
one account. The first successful sign-in binds that Cloudflare account to the
installation—not the individual user—until its D1 binding is deliberately reset
or the instance is replaced. Later sign-ins must authorize the same account; any
Cloudflare member able to grant Brolly's requested scopes for that account may
sign in. Brolly encrypts the latest revocable OAuth grant in your own D1 database
and asks for limits for every discovered product, Worker, and namespace. The
first setup step verifies monitoring access. A later budget step can read
the previous rolling 24 hours and prefill
suggested limits with 25%, 75%, and 150% headroom. It uses at most two bounded
Analytics requests plus one Billing request when Billing Read is configured,
using the latest available daily billing record for billing-only products. It
caches the result for 15 minutes, leaves products without measurable cost
unchanged, and saves nothing until the final setup step.

First-run setup separates permission verification from limit generation. The
required access screen initially shows one monitoring-access check. Setup cannot
continue until that check has run. It reveals
results and only the remediation actually needed: OAuth reconnection for a
denied Analytics scope, or guided Billing Read setup when billing is missing.
The billing guide provides a copyable least-privilege token recipe. A token
entered there is verified before
it is saved, AES-GCM encrypted with `BROLLY_CREDENTIAL_KEY`, and stored only in
the installation's D1. The next step imports Cloudflare's available 90-day
usage and billing history with exact per-collector progress. Setup can continue
while that bounded job runs in the background. Risk tolerance uses the imported
history to seed daily and billing-cycle limits. An operator may continue
supplying `CLOUDFLARE_BILLING_TOKEN` as a Worker secret, which takes precedence
over the D1 credential.

The setup wizard has seven steps:

1. Connect Cloudflare and verify monitoring access.
2. Add alert channels. The first Twilio, Cloudflare Email, Resend, or Postmark channel saves its account credentials; later channels reuse that account. Cloudflare Email, Resend, and Postmark channels may group multiple recipients, while each Twilio channel uses one destination number. Discord, Slack, and generic webhooks use one URL per channel.
3. Arrange the alert level board. Warning, Critical, and Emergency start as empty columns. Custom columns can be inserted, renamed, reordered, or removed while one column remains. Channel entries carry their own repeat interval. Prepare and Auto entries select reversible controls for eligible Workers, Durable Objects, and Queues.
4. Choose Conservative, Balanced, or Growth risk tolerance. The shared percentages apply to every cost and billable usage chart.
5. Set daily cost and billable usage limits for the account, products, and resources.
6. Set billing-cycle cost and billable usage limits for the same scopes.
7. Install the shutdown fuse through the generated coding-agent handoff.

Each level includes entries from the levels before it. A firing level therefore
uses the union of its inherited channel and action entries. The rightmost level
has the highest display severity. Acknowledge on an alert instance stops its
repeats; a resolved instance also stops them.

Browser sign-in briefly passes through Brolly's separately operated, stateless
OAuth relay at `brolly-login.standardagents.ai`. The relay verifies the
installation's one-time state and returns only the short-lived authorization
code. It never receives an access or refresh token, and its implementation is
not included in this open-source package or customer deployments.
The installation exchanges that code directly with Cloudflare and requires a
refresh token for unattended monitoring. Short-lived access tokens are renewed
five minutes before expiry and the rotated credentials remain encrypted in the
installation's D1. If a login does not grant renewable access, Brolly rejects
the connection immediately instead of failing after the first token expires.

For local development, copy `dev.vars.example` to `.dev.vars` and generate the
local-only credential key described in that file. Automatic provisioning is for
remote deployments and never writes production secrets into the repository.

The canonical self-contained template lives in `deploy/`. After every verified
push to `main`, CI publishes that directory as the root-only `deploy-template`
branch. The button targets that branch—not a monorepo subdirectory—so the new
installation repository receives the Worker, dashboard assets, migrations,
package metadata, and deploy scripts required by Workers Builds.

Once installed, save that `owner/repository` name under **Settings → Updates**.
While the dashboard is open, Brolly checks a small release manifest at most
once per hour and shows a banner when a release is available. **Review update**
opens the installation's manual GitHub Actions workflow, which creates a pull
request. Brolly never stores a GitHub token, updates itself, or auto-merges the
PR. Private repositories work the same way: GitHub authenticates the operator
and supplies the workflow's short-lived repository token. The updater replaces
only published application artifacts and preserves `wrangler.jsonc`, the D1
binding, variables, and secrets.

Some GitHub organizations disable pull-request creation by Actions. In that
case the workflow still succeeds after pushing the verified update branch and
puts a prefilled **Open pull request** comparison link in its run summary.
Routine application updates never rewrite the repository's updater workflow;
GitHub intentionally forbids a workflow token from modifying workflow files.

Brolly defaults to UTC with a 09:00 daily summary. Advanced operators can add
`BROLLY_TIMEZONE`, `BROLLY_DAILY_SUMMARY_HOUR`, `CLOUDFLARE_BILLING_TOKEN`, or
`BROLLY_ADMIN_TOKEN` to the deployed Worker later; none is required to get to
the dashboard.

## Precise shutdown

Alerts require no application changes. To quarantine a specific Worker or
Durable Object ID without a network lookup, install the tiny deployment fuse:

```bash
pnpm add @standardagents/brolly-runtime
```

```ts
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env)
  brollyDurableObject(ctx, env)
}
```

The fuse reads only its deployment binding. It performs no HTTP, KV, D1, or
Durable Object storage operation on the hot path.

## What you get

- Daily spend charts and per-category budgets
- Account, product, namespace, Worker, and exact-object usage history
- Configurable period limits and discrete alert instances
- Human-readable collector coverage and ingestion watermarks
- Cloudflare Email, Discord, Postmark, Resend, Slack, Twilio SMS, and generic webhook notifications
- Monitoring-cost, backfill, retention, and D1-capacity views
- Per-level prepared and automatic control entries
- Prepare, execute, inspect, and roll back controls
- Runtime-install verification per Worker and namespace

## Alert channels and levels

Channel labels are required and unique without regard to letter case. Each
labeled channel remains a separate group. Cloudflare Email, Resend, and
Postmark channels may group multiple recipients. Multiple channels can use the
same provider account while remaining distinct groups. Twilio channels use one
destination number. A provider account stores the shared credentials for one
Twilio, Cloudflare Email, Resend, or Postmark kind. Removing a channel leaves
its provider account until an operator removes that account from Notifications
settings. Changing a provider account reseals every channel that uses it.

Cloudflare Email uses a dedicated API token with Email Sending permission. Brolly
verifies that the token is active through Cloudflare's token endpoint, lists the
connected account's zones for the from-address domain, and sends through the
account REST API. Email Service domain onboarding remains a Cloudflare dashboard
task under Compute → Email Service. Delivery failures, including permanent
bounces, appear on the channel's delivery status.

The level board is available in the setup wizard and through the Budgets action
when an installation is configured. Entries are additive from left to right. A
channel repeated in a later level uses that later entry's interval. Once,
5-minute, 15-minute, 30-minute, 1-hour, 3-hour, 6-hour, 12-hour, and 24-hour
intervals are available. The 20 deliveries-per-hour per-target cap and the
Twilio five-per-day cap apply to every interval.

Prepare entries create an audited action awaiting approval. Auto entries run an
eligible action after the same safety checks. Worker-ingress stop, Durable
Object quarantine, and queue pause preserve resources and storage. Recovery is
manual.

## Deployment and schema releases

The release template includes the notification provider and alert-level schema
migrations. A fresh Deploy to Cloudflare installation applies them in migration
order before the dashboard accepts channel or level changes. The generated
`deploy-template` branch is the source for the deployment button, so run
`pnpm build:deploy-template` after guard Worker or migration changes and review
the generated release before publishing it. Installation-owned Wrangler
configuration, D1 identity, variables, and secrets remain outside the copied
release artifacts.

## Safety limits

Every monitoring pass defaults to hard limits of **300 GraphQL dataset
queries**, **50 REST requests**, **100,000 D1 rows read**, **50,000 D1 rows
written**, and **45 seconds**. Durable Object and Worker collectors use stable
10,000-row keyset pages. Brolly does not wake Durable Objects or query customer
application storage during a scan. Operators can configure lower or higher
ceilings on the Monitoring page within fixed product maximums.

An Auto action entry requires complete fresh unsampled usage, an eligible
inherited resource policy, current runtime verification, and confirmation
evidence. Existing tier, control-plane, and resource-policy refusals remain in
force. Aggregate contributor automation requires the same deterministic
candidate in two scans, majority contribution, and four-times baseline
acceleration. Brolly allows one deployment-changing action per Worker in 15
minutes and three automatic quarantines per account hour.

## Documentation

- [Brolly website and installation guide](https://brolly.standardagents.ai)
- [Operations and emergency response](docs/operations.md)
- [Runtime integration and exact-object quarantine](docs/runtime-integration.md)
- [Architecture and safety model](docs/architecture.md)
- [Usage ledger, alerts, retention, and API](docs/usage-ledger.md)
- [Cloudflare icon sources](docs/icon-sources.md)

## Runtime releases

`@standardagents/brolly-runtime` publishes through GitHub Actions with npm
trusted publishing and provenance. Stable releases must start from `main`:

```bash
pnpm release:runtime patch
```

Development releases use a commit-qualified prerelease and the `dev` dist-tag:

```bash
pnpm release:runtime:dev patch
```

The npm trusted publisher must target the `standardagents/brolly` repository
and `.github/workflows/publish-runtime.yml`. No npm token is stored in GitHub.

## License

[MIT](LICENSE)
