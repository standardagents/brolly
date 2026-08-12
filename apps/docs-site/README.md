# Brolly public site

This app is the universal marketing and installation guide at
`brolly.standardagents.ai`. It is not included in customer Brolly deployments.

## Rendering

Vite builds `src/render.tsx` for SSR, then `scripts/prerender.mjs` writes the
rendered document to `dist/site/index.html`. The production page ships no
client-side JavaScript. A small Worker serves `/health` and delegates all other
requests to Cloudflare static assets.

Tailwind CSS 4 compiles the entire site stylesheet as a separate static build.
The page follows `prefers-color-scheme`: light-mode visitors receive the light
palette and dark-mode visitors receive the dark palette without client-side
JavaScript or a flash of the wrong theme.

## Commands

```bash
pnpm --filter @standardagents/brolly-docs dev
pnpm build:docs
```

The production deployment path is a push from `main`. GitHub Actions typechecks,
builds, verifies the deploy template, and deploys that commit.
`wrangler.ci.jsonc` deliberately omits route management so that workflow needs
only Workers deployment permissions after the domain has been bootstrapped
once.

Manual production deployment is reserved for emergencies:

```bash
pnpm deploy:docs
```

The command shows the source branch, commit, working-tree state, and production
URL. It requires `continue` before building and `deploy` immediately before
upload. `wrangler.production.jsonc` owns the custom domain for this confirmed
manual path.

The default `wrangler.jsonc` uses the separate `brolly-docs-local` Worker name
and contains no production route, which keeps a plain `wrangler deploy` away
from the production Worker. The package-level `deploy` command uses the same
confirmations. The CI entry point requires the canonical GitHub Actions
repository, `refs/heads/main`, and a checked-out HEAD matching `GITHUB_SHA`.
