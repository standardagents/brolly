# Brolly public site

This app is the universal marketing and installation guide at
`brolly.standardagents.ai`. It is not included in customer Brolly deployments.

## Rendering

Vite builds `src/render.tsx` for SSR, then `scripts/prerender.mjs` writes the
rendered document to `dist/site/index.html`. The production page ships no
client-side JavaScript. A small Worker serves `/health` and delegates all other
requests to Cloudflare static assets.

## Commands

```bash
pnpm --filter @standardagents/brolly-docs dev
pnpm build:docs
pnpm deploy:docs
```

`wrangler.jsonc` owns the custom domain and is used for manual deployment.
`wrangler.ci.jsonc` deliberately omits route management so the main-branch
workflow needs only Workers deployment permissions after the domain has been
bootstrapped once.
