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
| Zones | `dns.svg` |

- Source directory: <https://github.com/cloudflare/cloudflare-docs/tree/production/src/icons>
- Cloudflare icon guidance: <https://developers.cloudflare.com/style-guide/components/icons/>
- Retrieved: 2026-08-09

The vendored files are exact copies of Cloudflare's SVG sources. Brolly renders
them through a CSS mask so the glyphs can inherit local status colors without
rewriting the source files.
