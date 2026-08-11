# Cloudflare surprise-billing X cards

Seven retained X posts rendered as consistent 1200×675 PNG cards in light and dark modes. The posts directly concern runaway Cloudflare usage, missing hard spending limits, or costs that continued without an effective ceiling.

## Contents

- `../../apps/docs-site/public/x-posts/light/` — light-mode post cards served by the marketing site
- `../../apps/docs-site/public/x-posts/dark/` — matching dark-mode post cards served by the marketing site
- `contact-sheet-light.png` — light-mode overview
- `contact-sheet-dark.png` — dark-mode overview
- `posts.json` — curated post text and source URLs
- `manifest.json` — generated file/source mapping
- `render.mjs` — deterministic renderer

The Brolly homepage uses the source URLs in `posts.json` and alternates the
light and dark assets in one slow, accessible marquee. Regeneration writes
directly to the public site asset directories above.

The set intentionally excludes subscription renewals, ordinary billing mistakes, the disputed $120k Enterprise-contract story, the corrected $38k estimate, and the two cards removed during curation.

## Regenerate

```bash
NODE_PATH=/Users/justinschroeder/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules \
  /Users/justinschroeder/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node render.mjs
```
