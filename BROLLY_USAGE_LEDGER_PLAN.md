# Brolly Usage Ledger and Granular Protection

> This is a temporary execution plan. Delete it after its acceptance criteria are complete and its durable architecture, security constraints, and operational guidance have been moved into maintained Brolly documentation.

## Objective

Turn Brolly into a persistent, account-wide Cloudflare usage ledger and protection system that:

- monitors billable usage at the finest practical scope: account, product, namespace, Worker, resource, and individual Durable Object;
- refreshes active usage every five minutes while minimizing Cloudflare API calls and the cost of Brolly itself;
- retains daily normalized history for up to two years in the installation's D1 database;
- evaluates configurable daily and billing-cycle limits whenever new usage arrives;
- produces understandable, deduplicated alert instances with configurable notification cadence;
- supports audited, reversible quarantine for verified Workers and Durable Objects;
- never automatically quarantines anything unless the operator explicitly enables that action for an applicable rule;
- makes missing, delayed, sampled, or incomplete telemetry visible instead of treating it as zero usage.

The dashboard and alert engine must read from Brolly's database. Direct Cloudflare queries belong only in scheduled collectors, setup verification, and explicit refresh jobs.

## Product model

### Resource hierarchy

Brolly should model resources as a hierarchy:

1. Cloudflare account
2. Product family
3. Namespace, script, database, bucket, queue, index, gateway, or equivalent service scope
4. Individual resource where Cloudflare exposes a stable identifier, including individual Durable Objects
5. Metric within the resource

Every resource records:

- its Cloudflare identifier and display name;
- its parent resource;
- the collector and dataset that discovered it;
- the last time activity was observed;
- telemetry coverage and freshness;
- whether Brolly's runtime fuse is installed and verified;
- its available control mechanism;
- its effective automatic-quarantine policy: inherit, allow, or deny.

A parent's `deny` policy must prevent automatic quarantine for all descendants. Brolly's own resources and every resource used by its monitoring or control plane must always be excluded.

### Historical resolution

Brolly should not retain an unbounded five-minute event log. Instead:

- keep live daily and billing-cycle accumulators updated every five minutes;
- preserve enough short-term scan state to identify deltas, corrections, resets, and suspicious acceleration;
- seal one compact normalized usage record per resource per day;
- retain daily account, product, and namespace aggregates for 730 days;
- target 730 days for high-cardinality individual resources, subject to D1 capacity safeguards.

This provides useful historical charts and limit evaluation without creating a second runaway storage problem.

## Cloudflare collection architecture

### Scheduling

Use a one-minute Cron trigger as a lightweight scheduler. It should enqueue or claim bounded jobs rather than performing an unbounded account scan in one invocation.

Default cadence:

| Job | Cadence |
| --- | --- |
| Active usage collection | Every 5 minutes |
| Optional hot watch for near-limit resources | Every 1 minute |
| Resource inventory | Hourly |
| API capability and retention discovery | Daily |
| Authoritative billing reconciliation | Hourly, plus day and billing-cycle close |
| Historical backfill | Continuously from unused collection budget |

Hot watch must only apply to resources near a configured limit or with an open emergency incident. If Cloudflare's ingestion watermark has not advanced, Brolly should back off rather than repeat the same query.

Every collector must use overlapping completed windows so delayed Cloudflare data can correct previous totals. Writes must be idempotent.

### Query budgets

The installation should begin with a hard default budget of 300 GraphQL dataset queries per five-minute collection run. Make this configurable, but retain a hard upper bound.

Each run also needs hard limits for:

- total Cloudflare API requests;
- elapsed Worker CPU and wall time;
- D1 rows read and written;
- pages fetched per dataset;
- resources normalized per transaction;
- retries and backoff;
- historical backfill work.

When a budget is exhausted, persist the continuation cursor and mark coverage incomplete. Do not silently convert incomplete collection into zero usage, and never enforce automatically from an incomplete interval.

### Individual Durable Objects

Use Cloudflare GraphQL Durable Object analytics grouped by namespace and object identifier. Do not issue one request per object.

Collection approach:

1. Query recently active Durable Objects using invocation/activity datasets.
2. Group usage datasets by `namespaceId` and `objectId` where supported.
3. Request all relevant billable sums in the same query when possible.
4. Sort by stable object identifier and paginate with `objectId_gt` rather than offset pagination.
5. Use Cloudflare's 10,000-row page size where available; 20,000 active objects should therefore require two pages per dataset, not 20,000 API calls.
6. Union the active identifiers found across relevant datasets and update `last_active_at`.
7. Stop polling inactive objects individually; rediscover them through account-level activity queries.
8. Prioritize watched, near-limit, and recently active objects if the collection budget cannot cover every active object.

If a page cannot be completed in the current run, retain its cursor and mark the interval partial. Partial or sampled object attribution may alert, but cannot automatically quarantine.

Cloudflare currently documents per-object ID and name filtering for Durable Object metrics, GraphQL pagination, sampling, dataset settings, and API limits here:

- [Durable Object metrics and analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)
- [Durable Object metrics filtering by ID and name](https://developers.cloudflare.com/changelog/post/2026-06-12-durable-objects-metrics-filter-by-id-name/)
- [GraphQL dataset settings and retention discovery](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/)
- [GraphQL Analytics API limits](https://developers.cloudflare.com/analytics/graphql-api/limits/)
- [GraphQL pagination](https://developers.cloudflare.com/analytics/graphql-api/features/pagination/)
- [GraphQL sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/)

### Metrics inventory

Collectors should normalize every billable metric Cloudflare exposes through an account API. The initial catalog should include:

| Product | Metrics | Finest expected scope |
| --- | --- | --- |
| Workers and Pages Functions | Requests, CPU time, billable/cache-related requests where exposed | Worker script |
| Durable Objects compute | Requests, duration, incoming WebSocket messages | Namespace and object |
| Durable Objects SQLite | Rows read, rows written, storage | Namespace and object where exposed |
| Durable Objects legacy storage | Reads, writes, deletes, storage | Namespace/account as exposed |
| D1 | Rows read, rows written, storage | Database |
| Workers KV | Read, write, delete, list operations and storage | Namespace |
| R2 | Class A operations, Class B operations, storage and retrieval/egress | Bucket |
| Queues | Billable operations and bytes | Queue |
| Vectorize | Queried and stored dimensions | Index |
| Hyperdrive | Database queries | Configuration |
| Workers AI | Neurons or current billable units | Model/tag where exposed |
| AI Gateway | Requests, tokens, provider cost and stored rows | Gateway |
| Containers | vCPU, memory, disk and egress | Application/instance where exposed |
| Browser Rendering | Sessions and session time | Account/resource as exposed |
| Workflows | Requests, CPU, steps and storage | Workflow/instance where exposed |
| Images and Media | Requests, transformations and stored/delivered media metrics | Account/zone/resource as exposed |
| Stream | Minutes delivered and stored | Video/account where exposed |
| Worker Builds | Build minutes | Account/project |
| Analytics Engine and Log Explorer | Data points, ingestion, queries and storage | Dataset |
| Zones | Requests and bandwidth | Zone |
| Unknown or newly introduced PayGo lines | Usage and authoritative charge | Account/product catchall |

Collector capabilities must be data-driven. New Cloudflare billing line items that do not yet map to a detailed collector should still appear through an account/product catchall, with an explicit coverage gap.

Do not persist prompts, request payloads, query text, Durable Object storage keys, customer content, or other sensitive application data.

### Billing reconciliation

Use Cloudflare's billable usage API when Billing Read access is available:

- [Cloudflare Billing usage API](https://developers.cloudflare.com/api/resources/billing/subresources/usage/)

Billing data should be treated as authoritative for aggregate billed charges and billing-cycle boundaries, but not as sufficiently fresh or granular for emergency enforcement.

Detailed resource cost is an estimate. Allocate authoritative product-level cost proportionally to granular usage where the mapping is defensible. Otherwise use a versioned pricing model and label the result estimated. Never present allocated or modeled per-resource cost as an invoice fact.

Store pricing versions and included allowances so historical estimates remain reproducible when Cloudflare pricing changes.

## Database design

### `resources`

Canonical resource inventory.

Key fields:

- `id`
- `account_id`
- `parent_resource_id`
- `product_family`
- `resource_type`
- `cloudflare_id`
- `display_name`
- `first_seen_at`
- `last_seen_at`
- `last_active_at`
- `coverage_status`
- `control_capability`
- `runtime_fuse_status`
- `auto_quarantine_policy` (`inherit`, `allow`, `deny`)
- `metadata_json`

Unique key: `(account_id, resource_type, cloudflare_id)`.

### `metric_definitions`

Versioned metric catalog.

Key fields:

- `id`
- `product_family`
- `metric_key`
- `display_name`
- `unit`
- `aggregation_kind`
- `billing_mapping`
- `collector_key`
- `finest_scope`
- `pricing_version_id`
- `active`

### `collector_capabilities`

Records what an installation can currently observe.

Key fields:

- `account_id`
- `collector_key`
- `dataset`
- `available`
- `retention_days`
- `sampling_behavior`
- `finest_scope`
- `last_verified_at`
- `error_code`
- `human_explanation`

### `collector_state`

Continuation cursors, high-water marks, correction windows, leases, retry state, and the next eligible run time for each collector and partition.

### `billing_cycles`

Stores actual Cloudflare billing-cycle boundaries, status, currency, authoritative totals, and reconciliation timestamps.

### `billing_line_items`

Stores normalized Cloudflare billing usage and charge lines, including unmapped/new product lines.

### `pricing_versions`

Versioned unit prices, included allowances, effective dates, and source metadata.

### `usage_accumulator_shards`

Mutable current-day and current-cycle totals. Use deterministic sharding to avoid a row per five-minute sample.

Suggested key:

`(account_id, product_family, scope_type, local_day, billing_cycle_id, resource_hash_bucket)`

Each payload contains compact resource-to-metric maps with:

- current daily totals;
- current cycle totals;
- source high-water marks;
- correction bookkeeping;
- a short rolling baseline, such as the last 12 completed scans;
- data-quality flags.

Use an 8-bit resource hash bucket initially. Keep each row comfortably below D1's row-size limit and split a shard when needed. At 20,000 active resources, 256 shard updates per scan are vastly safer than inserting 20,000 new sample rows every five minutes.

### `usage_daily`

One sealed compact record per resource/day, containing normalized metrics, estimated cost, authoritative allocated cost where available, collection completeness, sampling information, and revision metadata.

Unique key: `(resource_id, local_day)`.

### `usage_cycle_totals`

Current and sealed billing-cycle totals per resource, maintained for fast dashboard and rule evaluation.

### `monitor_runs`

One row per scheduled collection run with duration, API calls, datasets queried, rows returned, D1 reads/writes, continuation state, errors, and coverage.

### `monitor_usage_daily`

Daily aggregate of Brolly's own monitoring footprint. The dashboard should show Cloudflare API calls versus quota, Worker requests and CPU, and estimated D1 reads/writes/storage.

### `backfill_jobs` and `backfill_slices`

Track requested history, completed windows, cursors, retry state, and coverage by collector and scope.

### `alert_rules`

Defines a monitored target and metric:

- target selector or resource ID;
- metric definition;
- measurement (`usage`, `estimated_cost`, or `billed_cost`);
- period (`day` or `billing_cycle`);
- notification routing;
- whether contributor quarantine is allowed;
- enabled state.

### `alert_lines`

Arbitrary threshold lines belonging to a rule:

- label;
- color;
- priority;
- threshold value;
- optional action;
- repeat interval;
- enabled state.

Create only `Warning` and `Emergency` by default. Users may add, remove, rename, recolor, reorder, or disable lines. `Critical` is not a mandatory concept.

### `alert_instances`

A discrete threshold transgression for one time period.

Unique identity:

`(alert_rule_id, alert_line_id, target_resource_id, period_start, period_end)`

Key fields:

- observed and threshold values;
- evidence and data quality;
- status;
- first and last breach time;
- next notification time;
- notification count;
- silence state and actor;
- linked control action.

Silencing affects only this instance. It never disables the underlying alert rule.

### Existing control and audit tables

Preserve and extend the existing actions, approvals, notification deliveries, audit history, encrypted credentials, and fuse/control records rather than creating parallel control systems.

## D1 capacity policy

D1's current documented storage limits should be treated as a hard product constraint:

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

Brolly must stay D1-only for this design, so retention must be tiered:

1. Always preserve 730 days of account, product, and namespace daily aggregates.
2. Target 730 days for individual resources.
3. At 70% of the available database capacity, warn and show projected retention.
4. At 80%, pause historical backfill.
5. At 90%, prune the oldest individual-resource daily rows until projected use falls below 80%.
6. Never prune current accumulators, open alerts, actions, audit records, billing records, or aggregate history.

The UI must display the oldest retained per-resource date. High-cardinality installations on the Free D1 limit should receive an early recommendation to move the Brolly database to a paid plan.

## Limit evaluation and alert behavior

Evaluate affected rules transactionally after each successful usage update. Do not rescan the entire rule table after every metric write; resolve only rules applicable to changed resource/metric/period combinations.

Daily rules use the account's configured IANA timezone. Monthly rules use the actual Cloudflare billing cycle, not a calendar month. If Billing Read access is missing, billing-cycle limits must be labeled approximate until the cycle is confirmed.

Default notification cadence:

- Warning: notify once per alert instance.
- Emergency: notify immediately, then every six hours while the instance remains open and unsilenced.

Instances expire when their day or billing cycle ends. Historical backfill may create historical breach records for charts, but must never send notifications or execute controls.

Add email delivery through a provider such as Postmark or Resend, alongside Slack, Discord, Twilio SMS, and generic webhooks. Notification routing and delivery state belong in settings and audit history.

## Automatic quarantine safeguards

The installation's global default remains alert-only/manual approval. An automatic action must be explicitly enabled for the exact rule or applicable service policy.

### Exact-resource rule

An exact Worker or exact Durable Object rule may quarantine its own target only when:

- the target is verified as controllable;
- the Brolly fuse or supported control mechanism is installed and healthy;
- the interval is fresh, complete, and unsampled;
- the resource is not excluded;
- the rule explicitly enables automatic quarantine;
- the threshold remains breached for the configured confirmation window.

### Aggregate contributor rule

For an account, product, or namespace threshold, Brolly may select a likely transgressor only when the rule explicitly enables `auto_quarantine_contributors`.

Eligibility requirements:

- complete and fresh child attribution;
- unsampled data, or a sampling interval of one;
- exclusion of Brolly/control-plane resources;
- exclusion of resources with inherited or explicit `deny`;
- verified control readiness;
- no existing quarantine;
- the same candidate wins two consecutive scans.

Rank candidates by:

1. whether the individual candidate crossed its own emergency line;
2. contribution in the latest completed interval;
3. contribution during the current day or billing cycle;
4. stable resource identifier as a deterministic tie breaker.

Require meaningful evidence. A candidate should account for at least 50% of the latest interval or at least 50% of the aggregate excess, and its latest rate should be at least four times its rolling 12-scan baseline. If evidence is ambiguous, prepare an approval action showing the top contributors rather than acting automatically.

Rate limits:

- quarantine at most one contributor, then wait for the next completed scan;
- no more than one deployment-changing action per Worker per 15 minutes;
- no more than three automatic quarantines per account per hour;
- retain the existing runtime fuse payload-size and signature safeguards.

Estimated cost, aggregate billing totals, sampled data, partial coverage, missing collectors, or stale data must never directly trigger automatic quarantine.

## Onboarding and user experience

### Setup sequence

1. Sign in and bind the Brolly installation to one Cloudflare account.
2. Verify monitoring access and explain missing permissions in human language.
3. Inventory available products, resources, datasets, retention windows, and billing-cycle information.
4. Start a bounded background backfill, newest first:
   - previous 24 hours;
   - current billing cycle;
   - remaining available history.
5. Show coverage progress and explicitly distinguish missing data from zero usage.
6. Suggest initial Warning and Emergency lines from observed history with clear safety headroom.
7. Configure notification channels.
8. Offer runtime-fuse installation instructions and a copyable agent prompt.
9. Keep automatic quarantine disabled until the operator explicitly enables it.

Setup must remain usable while the historical backfill continues.

### Dashboard structure

All charts and tables read from D1. `Scan now` should schedule a bounded collector job and explain which datasets it will refresh, its request budget, and the most recent Cloudflare ingestion watermark.

Provide drill-down navigation:

`Account → Product → Namespace/Worker/Resource → Individual resource → Metric → Daily history`

Recommended pages:

- Overview
- Usage
- Limits
- Alert instances
- Resources
- Actions and quarantine
- Configuration and coverage
- Notifications
- Monitoring cost
- Backfill and retention
- Settings

Every incident, resource, action, coverage gap, and chart segment should link to the relevant details or available action.

The monitoring-cost page should show:

- GraphQL queries used versus the configured budget;
- REST requests used versus budget;
- D1 rows read/written and storage growth;
- Worker requests and CPU attributable to Brolly;
- estimated monthly Brolly operating cost;
- collection areas reduced or deferred by safety budgets.

## Migration from the current implementation

1. Add a new D1 migration for the ledger, metric catalog, capabilities, accumulator shards, daily usage, billing, alert rules/lines/instances, monitor accounting, and backfill state.
2. Preserve existing authentication, resources, notification destinations, actions, audit history, and quarantine/fuse state.
3. Convert existing policies into rules with Warning and Emergency lines. Preserve Critical values as disabled custom lines or migrate them explicitly; do not silently discard configured thresholds.
4. Replace unbounded raw `metric_samples` retention with accumulator shards and sealed daily rows after daily close and verification.
5. Move the dashboard, charts, incidents, suggestions, and limit evaluation to database-backed read APIs.
6. Add typed domain models for `MetricDefinition`, `Resource`, `UsageSeries`, `AlertRule`, `AlertLine`, `AlertInstance`, `CollectorCoverage`, and `MonitoringCost`.
7. Add APIs for usage drill-down, rule/line CRUD, instance silence, quarantine exclusions, backfill status, coverage, and monitoring cost.
8. Update the README, install docs, in-app docs, runtime docs, API docs, and public Brolly website together.

## Testing and acceptance criteria

### Collection correctness

- A simulated account with 20,000 active Durable Objects uses two 10,000-row pages per applicable dataset and makes no per-object request loop.
- Overlapping windows and late Cloudflare corrections do not double count.
- A stopped/restarted collector resumes from persisted cursors.
- Sampled, partial, stale, and missing data remain visibly distinct from zero.
- Day closing is correct across daylight-saving transitions in the account timezone.
- Billing-cycle totals close and reopen on the actual cycle boundary.

### Alerts

- Users can create any number of threshold lines, while new rules default to Warning and Emergency.
- Warning sends once per period instance.
- Emergency repeats every six hours until silenced or expired.
- Silencing one instance does not silence its rule, another line, another resource, or a future period.
- Historical backfill never sends a live notification.

### Controls

- Global mode defaults to alert-only.
- Automatic quarantine requires explicit opt-in on an applicable rule.
- Exclusions cascade safely.
- Missing, sampled, incomplete, stale, estimated-cost, and billing-only signals cannot auto-quarantine.
- Aggregate contributor selection is deterministic and requires two consecutive scans.
- Deployment and account action rate limits hold under concurrent breaches.
- Every prepared, approved, executed, failed, and reversed action has a complete audit trail.

### Cost and capacity

- Collection stays within configured Cloudflare API, Worker execution, and D1 budgets under load.
- Monitoring-cost estimates are visible and derived from recorded run data.
- At D1 pressure thresholds, only old individual-resource history is pruned; aggregates, current state, alerts, billing, actions, and audit history survive.
- Unknown Cloudflare billing products appear as catchall line items and coverage gaps rather than disappearing.

### Offline behavior

- The dashboard remains useful from stored data when Cloudflare APIs are temporarily unavailable.
- Every view displays data freshness and coverage.
- Controls fail closed when evidence or control readiness is uncertain.

## Rollout order

1. Schema, metric catalog, capability discovery, and monitoring-cost accounting.
2. Accumulator shards, daily sealing, account/product collectors, and database-backed charts.
3. Worker, namespace, database, bucket, queue, index, and other resource-level collectors.
4. Efficient active-Durable-Object discovery and per-object collection.
5. Historical backfill and retention/capacity management.
6. Arbitrary alert rules, threshold lines, period instances, silencing, and notification cadence.
7. Email notification delivery and settings UI.
8. Exact-resource quarantine safeguards.
9. Aggregate contributor analysis and explicitly opted-in automatic quarantine.
10. Complete drill-down UX, monitoring-cost UX, docs, load tests, and staged production rollout.

## Non-negotiable safety invariants

- Brolly never interprets missing telemetry as zero.
- Brolly never automatically controls a resource from sampled, stale, partial, modeled-cost, or aggregate billing evidence alone.
- Brolly never controls itself or a resource required for monitoring, authentication, recovery, or audit.
- Automatic quarantine is opt-in, reversible, rate-limited, and fully audited.
- Monitoring and backfill always have hard request, time, D1, and storage budgets.
- The dashboard states whether a number is authoritative, estimated, allocated, sampled, partial, or stale.
- Customer application data is not collected merely to measure usage.

## Pricing references

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
