# Brolly

Brolly is a self-hosted Cloudflare cost sentinel and emergency control plane.

## Safety invariants

- Brolly must never auto-delete customer data or resources.
- Every monitoring run has hard request, row, sample, and wall-clock budgets.
- Unknown or inaccessible telemetry is an explicit coverage incident, never a healthy signal.
- Automatic actions must be reversible and produce an audit record before execution.
- The Brolly Worker, its D1 database, and notification path are always protected control-plane assets.
- Exact Durable Object quarantine is only available through a signed runtime integration.
- A forensic hold prevents cleanup and resume until an operator explicitly releases it.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev
pnpm dev:demo
pnpm build:docs
pnpm build:deploy-template
pnpm deploy:docs
pnpm release:runtime patch --dry-run --yes
```

## Dashboard UI preview

`pnpm dev:demo` serves the guard Worker dashboard on
<http://localhost:5199> against an in-process mock API
(`apps/guard-worker/vite.demo.config.ts`). It needs no Cloudflare account, no
OAuth client, and no D1 database. Use it for any dashboard UI work or review.

`pnpm dev` boots the real Worker instead. That path requires Cloudflare OAuth
and permanent account binding before any page past the login screen renders, so
it cannot show the UI on a machine without an account to bind.

The preview opens signed in on Overview, and its fixtures cover the states worth
reviewing: a critical incident holding a prepared quarantine action awaiting
approval, an acknowledged warning, an informational incident, a resolved past
action, one coverage gap, a partially configured Worker and namespace, a
notification target, and 24 hours of spend history. The Budgets button opens the
onboarding wizard in edit mode, so its steps are reachable without completing
onboarding.

Two rules for changing it:

- The fixture account id must stay a placeholder string. `connectionHealth()`
  keys the "Local preview" banner off that, which is what stops a preview from
  reading as live protection.
- Fixtures must satisfy the response types in
  `apps/guard-worker/src/client/types.ts`. The demo config is inside the
  package's `tsconfig.json`, so `pnpm typecheck` fails when a dashboard API
  response shape changes and its fixture does not.

Mutating routes answer `{ ok: true }` without side effects, so every button is
safe to click. The harness is development-only and never reaches `deploy/`.

`apps/docs-site` is the universal public site for
`brolly.standardagents.ai`. It is prerendered to static HTML and deployed by
`.github/workflows/deploy-docs.yml` on pushes to `main`. It is intentionally
not part of the customer Deploy to Cloudflare build in `pnpm build`.

`deploy/` is the canonical, fully isolated generated release template used by
the Deploy to Cloudflare button. Cloudflare's installer failed to clone this
repository's nested template reliably, so `.github/workflows/deploy-docs.yml`
builds and verifies `deploy/` on Linux, commits any platform-normalized release
output inside the CI checkout, and publishes it as the root of the
`deploy-template` branch before updating the public site. Run
`pnpm build:deploy-template` after guard Worker changes and commit the resulting
Worker, assets, migrations, and deploy helpers. The dashboard and README must
link to the `deploy-template` branch URL, never the monorepo root or `deploy/`
subdirectory URL.
