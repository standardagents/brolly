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
| **⚡ Fast detection** | Bounded telemetry every minute, plus daily billing reconciliation. |
| **🎯 Scoped limits** | Account, product, Worker, Durable Object namespace, and exact-object budgets. |
| **↩ Reversible controls** | Approval-first quarantine, rollback state, and a complete audit trail. |

> [!IMPORTANT]
> Brolly never deletes resources or customer data. Automatic controls are
> opt-in, and missing telemetry is reported as a coverage gap—not zero usage.

## Install

Use **Deploy to Cloudflare** above. The Cloudflare flow provisions Brolly's D1 database and deploys the dashboard
and guard Worker. The form asks only for the provisioned D1 binding. On the
first deploy, Brolly generates a 256-bit `BROLLY_CREDENTIAL_KEY` and sends it
directly to Cloudflare as a Worker secret without printing it. Later deploys
verify that the secret exists and preserve it, so credentials already encrypted
in D1 remain readable.
Account ID, OAuth client, timezone, summary hour, optional billing access, and
the optional break-glass token are not installation questions. On first visit,
**Continue with Cloudflare** authorizes exactly
one account. The first successful sign-in binds that Cloudflare account to the
installation—not the individual user—until its D1 binding is deliberately reset
or the instance is replaced. Later sign-ins must authorize the same account; any
Cloudflare member able to grant Brolly's requested scopes for that account may
sign in. Brolly encrypts the latest revocable OAuth grant in your own D1 database
and asks for limits for every discovered product, Worker, and namespace. The
first optional setup step can read the previous rolling 24 hours and prefill
suggested limits with 25%, 75%, and 150% headroom. It uses at most two bounded
Analytics requests plus one Billing request when Billing Read is configured,
using the latest available daily billing record for billing-only products. It
caches the result for 15 minutes, leaves products without measurable cost
unchanged, and saves nothing until the final setup step.

First-run setup separates permission verification from limit generation. The
access screen can reauthorize the Cloudflare OAuth grant and can accept an
account-scoped **Billing Read** token. A token entered there is verified before
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
- Per-Worker, namespace, and exact-object limits
- Human-readable incidents and coverage gaps
- Discord, Slack, and Twilio SMS notifications
- Approval and automatic emergency modes
- Prepare, execute, inspect, and roll back controls
- Runtime-install verification per Worker and namespace

## Safety limits

Every monitoring pass stops at **150 Cloudflare API calls**, **25,000 Brolly D1
row operations**, **20,000 samples**, or **45 seconds**. Brolly does not wake
every Durable Object or query customer-object SQLite during a scan.

Automatic quarantine is narrower still: two consecutive fresh emergency
observations, an exact Worker or object target, a safe asset tier, successful
runtime verification within 24 hours, and a current Cloudflare-owned Worker
mapping are all required. Projected-dollar estimates never authorize an
automatic stop. Brolly caps automatic rollouts at five Workers per monitor pass,
one rollout per Worker per five minutes, and twelve per account per hour.

## Documentation

- [Brolly website and installation guide](https://brolly.standardagents.ai)
- [Operations and emergency response](docs/operations.md)
- [Runtime integration and exact-object quarantine](docs/runtime-integration.md)
- [Architecture and safety model](docs/architecture.md)
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
