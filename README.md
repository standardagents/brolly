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
| **🎯 Scoped limits** | Arbitrary Warning, Emergency, and custom lines for daily or Cloudflare billing-cycle periods. |
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
first setup step verifies monitoring access. The following budget step can read
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
the installation's D1. The following account-budget screen has the historical
usage button; verifying access alone never changes a limit. An operator may
instead continue supplying `CLOUDFLARE_BILLING_TOKEN` as a Worker secret, which
takes precedence over the D1 credential.

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
- Discord, Slack, Resend, Postmark, Twilio SMS, and generic webhook notifications
- Monitoring-cost, backfill, retention, and D1-capacity views
- Approval and automatic emergency modes
- Prepare, execute, inspect, and roll back controls
- Runtime-install verification per Worker and namespace

## Safety limits

Every monitoring pass defaults to hard limits of **300 GraphQL dataset
queries**, **50 REST requests**, **100,000 D1 rows read**, **50,000 D1 rows
written**, and **45 seconds**. Durable Object and Worker collectors use stable
10,000-row keyset pages. Brolly does not wake Durable Objects or query customer
application storage during a scan. Operators can configure lower or higher
ceilings on the Monitoring page within fixed product maximums.

Automatic quarantine requires global automatic mode, explicit rule opt-in, complete fresh unsampled
usage, an eligible inherited resource policy, current runtime verification, and
confirmation evidence. Aggregate contributor automation requires the same
deterministic candidate in two scans, majority contribution, and four-times
baseline acceleration. Brolly allows one deployment-changing action per Worker
in 15 minutes and three automatic quarantines per account hour.

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
