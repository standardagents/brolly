# Cloudflare product icon sources

Brolly vendors the Cloudflare product SVGs used in its dashboard so the guard
does not make third-party icon requests at runtime. The source is Cloudflare's
official `cloudflare/cloudflare-docs` repository, `production` branch,
`src/icons/`, as identified by the Cloudflare docs style guide.

| Brolly family | Cloudflare source file |
| --- | --- |
| Durable Objects | `durable-objects.svg` |
| Workers | `workers.svg` |
| Workers AI | `workers-ai.svg` |
| Queues | `queues.svg` |
| D1 | `d1.svg` |
| R2 | `r2.svg` |
| KV | `kv.svg` |
| Pages | `pages.svg` |
| Images | `images.svg` |
| Stream | `stream.svg` |
| Vectorize | `vectorize.svg` |
| Hyperdrive | `hyperdrive.svg` |
| AI Gateway | `ai-gateway.svg` |
| Containers | `containers.svg` |
| Browser Rendering | `browser-run.svg` |
| Workflows | `workflows.svg` |
| Worker Builds | `dynamic-workers.svg` |
| Analytics Engine | `analytics.svg` |
| Log Explorer | `log-explorer.svg` |
| Zones | `dns.svg` |
| Email | `email-routing.svg` |

- Source directory: <https://github.com/cloudflare/cloudflare-docs/tree/production/src/icons>
- Cloudflare icon guidance: <https://developers.cloudflare.com/style-guide/components/icons/>
- Retrieved: 2026-08-18

The vendored files are copies of Cloudflare's SVG sources. Cloudflare's source
files use both inherited and fixed black fills; fixed fills are normalized to
`currentColor` where needed. Brolly renders them through a CSS mask so the
glyphs inherit local status colors.
