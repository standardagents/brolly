# Cloudflare product metric contract

Brolly defines Product Limits from Cloudflare's product pricing contracts. A
connected account supplies values, coverage, live GraphQL capabilities, and
billing records. Account activity never adds or removes a Product Limits row.

The executable contract lives in
`packages/core/src/catalog.ts` as `PRODUCT_METRIC_CONTRACTS`. Every row records
its display unit, billing role, history-source class, billing unit, pricing
reference, and any shared or conditional billing rule. Supporting telemetry
stays in the ledger when it helps explain usage, but it does not become a
configurable Product Limit.

## Canonical Product Limits

| Product family | Product Limits rows | Billing semantics | Primary Cloudflare contract |
| --- | --- | --- | --- |
| Workers | Requests; CPU time | Independent usage meters | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Durable Objects | Requests; compute duration; SQLite rows read; SQLite rows written; KV read units; KV write units; KV deletes; SQLite storage; KV storage | Independent usage and storage meters. Incoming WebSocket messages remain supporting telemetry because Cloudflare converts them into request billing. | [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Workers AI | Neurons | Independent usage meter | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Queues | Billable operations | Independent 64 KiB operation chunks. Messages and bytes remain supporting telemetry. | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) |
| D1 | Rows read; rows written; storage | Independent usage and storage meters | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| R2 | Class A operations; Class B operations; storage; Infrequent Access retrieval | Retrieval applies to Infrequent Access objects. Egress remains supporting telemetry because R2 egress is free. | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Workers KV | Reads; writes; deletes; lists; storage | Independent usage and storage meters | [Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| Pages Functions | Function requests | Shared Workers request billing. Pages builds are outside the Pages Functions usage meter. | [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/) |
| Images | Unique transformations; stored images; images delivered | Independent transformation, storage, and delivery meters. Generic image requests do not stand in for delivery. | [Images pricing](https://developers.cloudflare.com/images/pricing/) |
| Stream | Video stored; video delivered | Independent stored-minute and delivered-minute meters | [Stream pricing](https://developers.cloudflare.com/stream/pricing/) |
| Vectorize | Queried vector dimensions; stored vector dimensions | Independent queried-dimension and storage-period meters | [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) |
| Hyperdrive | Database queries | Free-plan quota. Paid Hyperdrive has no independent overage meter. | [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) |
| AI Gateway | Logpush requests | Conditional Cloudflare charge when AI Gateway Logpush is enabled. Gateway requests, provider tokens, and provider-reported model cost remain supporting or provider data. | [AI Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/) |
| Containers | CPU time; allocated memory; allocated disk; egress | Independent compute meters. Egress charges depend on region and included transfer. | [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) |
| Browser Rendering | Browser time; concurrent browsers | Browser time is an independent meter. Additional average concurrency is conditional above the plan allowance. | [Browser Rendering pricing](https://developers.cloudflare.com/browser-run/pricing/) |
| Workflows | Workflow invocations; CPU time; workflow steps; workflow state storage | Invocations and CPU share Workers billing. Steps and state storage are independent Workflows meters. | [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/) |
| Worker Builds | Build time | Independent build-minute meter | [Worker Builds pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/) |
| Analytics Engine | Data points written; SQL read queries | Cloudflare publishes these rates and currently reports that charges are not active. | [Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) |
| Log Explorer | Logs ingested; logs stored | Independent ingestion and storage meters. Queries add no separate charge. | [Log Explorer pricing](https://developers.cloudflare.com/log-explorer/pricing/) |
| Email | Outbound emails | Independent outbound-sending meter. Inbound Email Routing is free and remains outside Product Limits. | [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/) |

## History and coverage rules

Brolly requests a 90-day initial window for every canonical row. Cloudflare's
dataset-specific retention can be shorter. The chart marks dates outside that
retention as unavailable and preserves the 90-day axis.

Cloudflare's GraphQL settings response controls whether Brolly queries a
dataset and which aggregate fields it requests. Brolly stores coverage by
metric within each dataset. A missing aggregate field produces unavailable
coverage for that metric. It never produces a measured zero.

Billing-only rows use Cloudflare's billable-usage history. GraphQL rows use the
live schema exposed to the installation. A completed query with the required
field and no result row is measured zero. Shared, conditional, quota-only, and
announced meters retain those classifications in the usage-series API.

Billing completion releases account spend setup and every Product Limit meter
whose contract accepts Billing history. GraphQL enrichment continues in the
background. A GraphQL-only meter remains unavailable or importing until its
own dataset reaches a final state.

Pages Functions requests and the shared Workflows request and CPU meters drain
the Workers request and CPU pools in account cost estimates. Cloudflare invoice
lines remain attached to the Workers meter that receives the charge. Brolly
keeps each source meter as its own Product Limit so users can alert on its
usage.

Cloudflare documents its live-schema discovery and request constraints in the
[GraphQL introspection guide](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/introspection/),
[GraphQL settings guide](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/),
and [GraphQL limits](https://developers.cloudflare.com/analytics/graphql-api/limits/).

## Change requirements

A catalog change requires all of the following evidence:

1. A current Cloudflare pricing or limits page that establishes the product meter.
2. A billing API field, documented telemetry source, or live GraphQL schema field that establishes the history source.
3. A fixture or test for unit conversion, coverage behavior, and any shared or conditional billing rule.
4. A catalog-version bump and updates to this document.

Observed usage from one installation may supply a regression fixture. It cannot
define the cross-account product schema.
