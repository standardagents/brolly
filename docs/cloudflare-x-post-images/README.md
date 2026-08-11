# Cloudflare surprise-billing X stories

Seven retained X posts rendered as semantic HTML cards on the Brolly homepage.
The posts directly concern runaway Cloudflare usage, missing hard spending
limits, or costs that continued without an effective ceiling.

## Contents

- `posts.json` — curated text, metadata, source URLs, and local avatar paths
- `sync-avatars.mjs` — refreshes the locally hosted profile images
- `../../apps/docs-site/public/x-posts/avatars/` — tiny local avatar assets

The Brolly homepage imports `posts.json` during its static SSR build. Every card
is real HTML with selectable text, semantic author and time metadata, a real
source link, and a Tailwind-compiled treatment that follows the visitor's
system light/dark preference. Profile images are clipped to
circular headshots in CSS. There are no flattened card screenshots in the
production site.

The set intentionally excludes subscription renewals, ordinary billing mistakes, the disputed $120k Enterprise-contract story, the corrected $38k estimate, and the two cards removed during curation.

## Refresh avatars

```bash
node docs/cloudflare-x-post-images/sync-avatars.mjs
```
