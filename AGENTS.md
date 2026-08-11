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

`deploy/` is the fully isolated, generated release template used by the Deploy
to Cloudflare button. Cloudflare does not support this repository's
multi-Worker workspace as one template target. Run `pnpm build:deploy-template`
after guard Worker changes and commit the resulting Worker, assets, migrations,
and deploy helper. The dashboard and README must link to the `deploy/`
subdirectory URL, not the repository root.
