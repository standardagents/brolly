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
pnpm release:runtime patch --dry-run --yes
```
