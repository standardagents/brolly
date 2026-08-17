# Usage ledger and alert API

Brolly maintains an account-wide usage ledger in the installation's D1 database. Scheduled collectors and explicit ingestion jobs query Cloudflare usage APIs. Dashboard charts, limits, alert instances, coverage, monitoring cost, and retention views read stored ledger state.

## Resource and metric model

The resources table is a hierarchy with one account root, product nodes, service scopes, and individual resources where Cloudflare exposes stable identifiers. Each resource stores collection origin, freshness, coverage quality, control capability, runtime-fuse status, protection tier, exclusion state, and an inherited automatic-quarantine policy.

The metric_definitions table is a versioned catalog. It contains detailed usage meters, synthetic estimated-cost meters, authoritative billed-cost meters, and account/product catchalls for billing lines without a detailed collector. Collector capability records state the finest available scope, retention, sampling behavior, current watermark, and a human-readable gap.

Brolly stores these quality states:

| State | Meaning |
| --- | --- |
| complete | The completed window was fully collected and unsampled. |
| partial | A page or collector budget ended before the window completed. |
| sampled | Cloudflare reported adaptive sampling. |
| stale | Stored evidence exists, but its watermark is too old for live enforcement. |
| missing | The dataset, permission, or collector is unavailable. |

Missing data remains missing throughout aggregation and alert evaluation.

## Collection and storage

The one-minute cron acts as a scheduler:

- active Worker and Durable Object usage is due every five minutes;
- hot watch is due every minute while a current warning or emergency instance is open and Cloudflare's aligned ingestion watermark has advanced;
- inventory and billing reconciliation are due hourly;
- Analytics dataset capability discovery is due daily;
- retention maintenance is due hourly;
- newest-first historical backfill drains up to the configured slice budget after active protection work.

First-run setup creates a separate initial-ingestion job. It imports daily usage for Workers, Durable Objects, Workers AI, Queues, D1, R2, Workers KV, Pages Functions, Images, Stream, Vectorize, Hyperdrive, AI Gateway, Containers, Browser Rendering, Workflows, Worker Builds, Analytics Engine, Log Explorer, zones, and Email. Each collector stops at the earlier of 90 days or its documented Analytics retention. Billing Read uses contiguous windows of at most 31 days across the full 90-day request. The request has its own bounded budget and leaves unfinished slices for the cron scheduler. Failed slices retry after 30 seconds, two minutes, and eight minutes before recording missing coverage. Initial and manual ingestion write ledger history without evaluating alerts, sending notifications, or preparing controls.

Active collection reads one fixed completed five-minute window with a two-minute ingestion delay, plus the immediately preceding fixed window as a correction pass. Each continuation remains bound to its original start and end timestamps after a restart. Durable Object datasets and Worker scripts use stable identifier ordering and keyset cursors with pages of up to 10,000 rows. Other product backfill collectors use daily product or resource groups. A dataset that reaches its bounded 10,000-row daily limit records partial coverage. A partial result persists independent active and correction cursors and keeps its interval in partial quality.

Current day and billing-cycle values live in deterministic 8-bit accumulator shards. A shard approaching 1.5 MB splits into deterministic 4-bit secondary segments. Each resource metric retains correction bookkeeping and a bounded 12-scan baseline. Repeating a window is idempotent; a changed Cloudflare result replaces the prior contribution through a delta. Completed local days seal into one usage_daily row per resource and day. Billing cycles use Cloudflare's reconciled boundaries when Billing Read is available and an explicitly approximate calendar boundary during a coverage gap.

Local-day totals reconcile every shard that belongs to that day, including a day that spans a billing-cycle boundary. Billing-cycle totals reconcile daily shard contributions across the stored Cloudflare cycle. Incomplete quality and sampling evidence remain attached after short-term scan windows are compacted. The monitoring-cost estimate uses elapsed execution duration as a conservative Worker CPU proxy because a Worker invocation cannot read its own final billed CPU measurement.

The default hard limits for one run are:

| Budget | Default | Hard maximum |
| --- | ---: | ---: |
| GraphQL dataset queries | 300 | 500 |
| REST requests | 50 | 100 |
| D1 rows read | 100,000 | 250,000 |
| D1 rows written | 50,000 | 100,000 |
| Dataset pages | 30 | 50 |
| Resources per transaction | 500 | 1,000 |
| Retries | 3 | 5 |
| Backfill slices | 4 | 12 |
| Wall time | 45 seconds | 55 seconds |

Budget exhaustion records an incomplete monitor run and preserves continuation state. Operators can lower or raise each value on the Monitoring page within the listed product maximum.

## Billing and cost labels

Hourly Billing Read reconciliation requests Cloudflare billable usage with explicit date bounds. A request may align to the current billing-cycle start when the resulting range stays within Cloudflare's 31-day limit. The restricted v2 endpoint is attempted first; a 403 or 404 uses the Billing Read-compatible PayGo endpoint. Billing records define authoritative aggregate charges and actual billing-cycle boundaries. A full-day span without billing rows remains missing data and creates a dated billing coverage record during the initial import.

Granular usage cost remains a model. Brolly proportionally allocates a product/day authoritative charge only among leaf resources with defensible estimated-cost weights. The dashboard labels values as authoritative aggregate, allocated, estimated, sampled, partial, or stale.

An unfamiliar Cloudflare product or metric is stored as a billing line, receives a dynamic metric definition, and creates a billing:catchall capability gap. It remains visible in account and product totals. Detailed collectors retain the usage fields Cloudflare exposes. Metrics such as Pages builds, stored Stream minutes, and Workflow storage remain billing-derived when Analytics has no matching field.

## Limits and alert instances

An alert rule selects one exact resource or a resource selector, one metric definition, a measurement (usage, estimated_cost, or billed_cost), and a period (day or billing_cycle). A rule owns any number of threshold lines. New rules begin with Warning and Emergency lines. Operators can add, rename, recolor, reorder, disable, or remove lines. Rules and lines with historical instances are retired in place so alert history keeps valid references. Items without history are removed directly.

Each threshold crossing has a period-specific alert_instances identity. Warning defaults to one delivery per instance. Emergency defaults to immediate delivery followed by six-hour repeats while open. Silencing one instance leaves its rule, sibling lines, other resources, and future periods active. Active recurring collection evaluates alert rules after it writes observations. Historical ingestion stays outside alert evaluation.

Notification destinations support Discord, Slack, Resend, Postmark, Twilio SMS, and generic HTTPS webhooks. Credentials remain AES-GCM encrypted. A generic webhook refuses redirects and local or private-network destinations.

Legacy account, family, resource, and metric thresholds migrate to ledger rules. Warning and Emergency remain enabled. A configured Critical line is retained in a disabled custom line so its value remains available for review.

## Automatic quarantine

The default global mode is approval. Estimated and incomplete evidence can prepare an operator-reviewed action when a quarantine line requests one. Exact-resource automation requires global automatic mode, an explicitly opted-in rule, and all of this evidence:

- an exact Worker or Durable Object target;
- complete, fresh, unsampled usage;
- a verified runtime fuse and authoritative owning Worker;
- an eligible tier and an inherited policy without exclusion or denial;
- a sustained breach through the rule's confirmation window;
- no active quarantine or action-rate limit.

Aggregate rules require explicit contributor automation. Candidate selection prioritizes a child that crossed its own Emergency line, then requires complete child attribution, at least half of interval usage or aggregate excess, at least four times the rolling 12-scan baseline, and the same deterministic winner in two consecutive scans. Ambiguous evidence records the leading contributors and prepares one exact action for operator review.

Automatic deployment limits allow one changing action per Worker in 15 minutes and three automatic quarantines per account hour. Brolly writes audit and rollback state before control execution. Estimated cost, allocated cost, billing totals, missing data, partial data, sampled data, and stale data cannot authorize an automatic control.

## Retention and D1 capacity

Cloudflare Analytics retention varies by dataset. Brolly requests up to 90 days during setup and records the shorter available range for datasets with 30-day, 31-day, 32-day, or 62-day retention. The stored daily history has a separate 730-day ceiling. Account, product, and namespace aggregates receive preservation priority. Individual-resource history targets the same duration under these safeguards:

- 70% capacity records a warning and displays projected retention;
- 80% pauses historical backfill;
- 90% prunes the oldest individual-resource daily rows toward 80%;
- current accumulators, aggregate history, alerts, actions, audit, and billing records remain preserved.

The dashboard reports the oldest retained individual-resource day and recommends paid D1 capacity before high-cardinality history becomes constrained.

## Read and management API

All routes require the existing authenticated Brolly session or break-glass credential.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /api/usage?resourceId=...&metricId=...&from=YYYY-MM-DD&to=YYYY-MM-DD | Daily history and live accumulator state for one resource. |
| GET | /api/ledger/resources?q=...&family=...&cursor=...&limit=... | Search and traverse canonical resources with stable keyset pagination. |
| PUT | /api/ledger/resources/:id/protection | Set inherited policy, exclusion, or tier. |
| GET | /api/metric-definitions | List active metric definitions. |
| GET | /api/coverage | Collector capabilities, watermarks, cursors, and errors. |
| GET | /api/monitoring-cost | Daily monitoring footprint and recent bounded runs. |
| GET, PUT | /api/monitoring-limits | Read or update per-run collection limits within product hard maximums. |
| GET | /api/retention | Capacity pressure and oldest retained dates. |
| GET, POST | /api/backfill | Inspect or schedule historical jobs within Cloudflare's 90-day source window. |
| GET, POST | /api/onboarding/ingest | Start the idempotent first-run import and read exact per-collector slice progress. |
| GET, POST | /api/alert-rules | List or create rules. |
| PUT, DELETE | /api/alert-rules/:id | Update or remove a rule. |
| POST | /api/alert-rules/:id/lines | Add a threshold line. |
| PUT, DELETE | /api/alert-lines/:id | Update or remove a line. |
| GET | /api/alert-instances | List period-specific crossings. |
| POST | /api/alert-instances/:id/silence | Silence one current instance. |
| POST | /api/run | Run one bounded collector and return budgets, datasets, watermarks, and accounting. |

Rule, line, instance-silence, protection, backfill, and control changes create audit records.
