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
pnpm build:docs
pnpm build:deploy-template
pnpm deploy:docs
pnpm release:runtime patch --dry-run --yes
```

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
